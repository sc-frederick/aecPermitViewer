import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { UpdateCheck } from "../shared/bridge.js";

const payloadSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(1_000_000_000),
  // Empty until releases are Authenticode-signed; the Ed25519 manifest is then the only trust anchor.
  publisher: z.string().max(200),
});

type UpdatePayload = z.infer<typeof payloadSchema>;

const envelopeSchema = z.object({
  signed: z.base64(),
  signature: z.base64(),
});

const configSchema = z.object({
  feedUrl: z.string(),
  publicKeySpkiBase64: z.string(),
  expectedPublisher: z.string(),
});

function newer(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > (b[index] ?? 0)) return true;

    if (a[index]! < (b[index] ?? 0)) return false;
  }

  return false;
}

export function verifyReleaseEnvelope(text: string, publicKeySpkiBase64: string, expectedPublisher: string): UpdatePayload {
  const envelope = envelopeSchema.parse(JSON.parse(text));
  const signedBytes = Buffer.from(envelope.signed, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, "base64"), format: "der", type: "spki" });

  if (!verify(null, signedBytes, key, signature)) throw new Error("Update manifest signature invalid");
  const payload = payloadSchema.parse(JSON.parse(signedBytes.toString("utf8")));

  if (!safeHttpsUrl(payload.url) || payload.publisher !== expectedPublisher) throw new Error("Update manifest target invalid");

  return payload;
}

function safeHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;

    return url;
  } catch {
    return null;
  }
}

async function fetchHttps(url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;

  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(current, { redirect: "manual", signal });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");

    if (!location) throw new Error("Update redirect missing location");
    const next = safeHttpsUrl(new URL(location, current).toString());

    if (!next) throw new Error("Update redirect is not HTTPS");
    current = next;
  }

  throw new Error("Too many update redirects");
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Empty update manifest");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;
    bytes += value.byteLength;

    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Update manifest too large");
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  return hash.digest("hex");
}

function sameHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");

  return a.length === b.length && timingSafeEqual(a, b);
}

export class UpdateManager {
  private readonly config: { feedUrl: string; publicKeySpkiBase64: string; expectedPublisher: string };
  private available: UpdatePayload | null = null;
  private downloadedPath: string | null = null;

  constructor(private readonly dataRoot: string, private readonly currentVersion: string, private readonly scriptPath: string, configPath: string) {
    this.config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  }

  async check(): Promise<UpdateCheck> {
    this.available = null;
    this.downloadedPath = null;
    const feed = safeHttpsUrl(this.config.feedUrl);

    if (!feed || !this.config.publicKeySpkiBase64) return { state: "unavailable" };
    const response = await fetchHttps(feed, AbortSignal.timeout(10_000));

    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 32_768) throw new Error("Update manifest unavailable");
    const text = await boundedText(response, 32_768);
    const payload = verifyReleaseEnvelope(text, this.config.publicKeySpkiBase64, this.config.expectedPublisher);

    if (!newer(payload.version, this.currentVersion)) return { state: "current" };
    this.available = payload;

    return { state: "available", version: payload.version, size: payload.size };
  }

  async download(): Promise<string> {
    const payload = this.available;

    if (!payload) throw new Error("No verified update available");
    const updateDir = path.join(this.dataRoot, "updates");
    await mkdir(updateDir, { recursive: true });
    const temporary = path.join(updateDir, `${randomUUID()}.partial.exe`);
    const final = path.join(updateDir, `PermitMonitorSetup-${payload.version}.exe`);
    const installerUrl = safeHttpsUrl(payload.url);

    if (!installerUrl) throw new Error("Update URL invalid");
    // The installer is large, so abort on a stalled connection rather than a fixed total time.
    const stall = new AbortController();
    let stallTimer = setTimeout(() => stall.abort(), 60_000);

    const response = await fetchHttps(installerUrl, stall.signal).catch((error: unknown) => {
      clearTimeout(stallTimer);
      throw error;
    });

    if (!response.ok || !response.body) {
      clearTimeout(stallTimer);
      throw new Error("Update download failed");
    }

    const file = await open(temporary, "wx", 0o600);
    let bytes = 0;
    const hash = createHash("sha256");

    try {
      const reader = response.body.getReader();

      while (true) {
        const { done, value: chunk } = await reader.read();
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(), 60_000);

        if (done) break;
        bytes += chunk.byteLength;

        if (bytes > payload.size || bytes > 1_000_000_000) throw new Error("Update size exceeded");
        hash.update(chunk);
        let offset = 0;

        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset, null);

          if (result.bytesWritten <= 0) throw new Error("Update write failed");
          offset += result.bytesWritten;
        }
      }
    } catch (error) {
      await file.close();
      await rm(temporary, { force: true });
      throw error;
    } finally {
      clearTimeout(stallTimer);
    }

    await file.close();

    if (bytes !== payload.size || !sameHex(hash.digest("hex"), payload.sha256)) {
      await rm(temporary, { force: true });
      throw new Error("Update hash mismatch");
    }

    try {
      await this.verifyPublisher(temporary, payload.publisher);
      await rm(final, { force: true });
      await rename(temporary, final);

      for (const entry of await readdir(updateDir)) {
        if ((entry.startsWith("PermitMonitorSetup-") && entry.endsWith(".exe") && entry !== path.basename(final)) ||
          entry.endsWith(".partial.exe")) await rm(path.join(updateDir, entry), { force: true });
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    this.downloadedPath = final;

    return payload.version;
  }

  async installerForApprovedHandoff(): Promise<string> {
    const payload = this.available;
    const file = this.downloadedPath;

    if (!payload || !file) throw new Error("No verified update downloaded");

    if ((await stat(file)).size !== payload.size || !sameHex(await sha256File(file), payload.sha256)) {
      throw new Error("Downloaded update changed");
    }

    await this.verifyPublisher(file, payload.publisher);

    return file;
  }

  private async verifyPublisher(file: string, publisher: string): Promise<void> {
    // verifyReleaseEnvelope already required publisher === config.expectedPublisher, so an empty value
    // only reaches here from an unsigned-build configuration.
    if (!publisher) return;

    if (process.platform !== "win32") throw new Error("Authenticode verification requires Windows");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", this.scriptPath,
        "-InstallerPath", file, "-ExpectedPublisher", publisher], { windowsHide: true, stdio: "ignore" });

      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Update publisher verification failed")));
    });
  }
}
