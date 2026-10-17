import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
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
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;

    if (left > right) return true;

    if (left < right) return false;
  }

  return false;
}

/**
 * Verify a signed update feed envelope and return the release it describes.
 *
 * @param text - The feed response body: JSON holding the base64 signed payload and its Ed25519 signature.
 * @param publicKeySpkiBase64 - The app's pinned Ed25519 public key, as base64 DER SPKI.
 * @param expectedPublisher - The publisher the release must name; the installer's Authenticode signer is checked
 *   against it after download.
 * @returns The payload, only after its signature verified against the pinned key.
 * @throws Error or ZodError when the envelope or payload is malformed, the signature is invalid, the installer URL is
 *   not a plain HTTPS URL, or the publisher differs. Callers treat any throw as "no trustworthy update".
 */
export function verifyReleaseEnvelope(
  text: string,
  publicKeySpkiBase64: string,
  expectedPublisher: string,
): UpdatePayload {
  const envelope = envelopeSchema.parse(JSON.parse(text));
  const signedBytes = Buffer.from(envelope.signed, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, "base64"), format: "der", type: "spki" });

  if (!verify(null, signedBytes, key, signature)) throw new Error("Update manifest signature invalid");
  const payload = payloadSchema.parse(JSON.parse(signedBytes.toString("utf8")));

  if (!safeHttpsUrl(payload.url) || payload.publisher !== expectedPublisher)
    throw new Error("Update manifest target invalid");

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

/** Follows up to three HTTPS redirects by hand. Each redirect's body is released before the next request. */
async function fetchHttps(url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;

  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(current, { redirect: "manual", signal });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
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

/**
 * Writes a download to a new `file` and returns its SHA-256, failing unless exactly `size` bytes arrive. On any failure
 * the stream is cancelled, the file is closed, and the error is rethrown. The file is removed only if this call created
 * it; an existing file at `file` fails the call and is left alone. `onProgress` runs after each read.
 */
export async function saveDownload(
  body: ReadableStream<Uint8Array>,
  file: string,
  size: number,
  onProgress: () => void,
): Promise<string> {
  const reader = body.getReader();
  let handle: FileHandle | null = null;
  let created = false;

  try {
    handle = await open(file, "wx", 0o600);
    created = true;
    const hash = createHash("sha256");
    let bytes = 0;

    while (true) {
      const { done, value: chunk } = await reader.read();
      onProgress();

      if (done) break;
      bytes += chunk.byteLength;

      if (bytes > size) throw new Error("Update size exceeded");
      hash.update(chunk);
      let offset = 0;

      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);

        if (result.bytesWritten <= 0) throw new Error("Update write failed");
        offset += result.bytesWritten;
      }
    }

    if (bytes !== size) throw new Error("Update ended early");
    await handle.close();
    handle = null;

    return hash.digest("hex");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);

    if (created) await rm(file, { force: true });
    throw error;
  }
}

/** A newer check or a cancellation replaced the update this operation was working on, so its result was discarded. */
export class UpdateSuperseded extends Error {
  readonly _tag = "UpdateSuperseded" as const;

  constructor(
    readonly operation: "check" | "download" | "install",
    override readonly cause?: unknown,
  ) {
    super(`Update ${operation} was superseded`);
  }
}

/** The operation needs a verified update the updater doesn't currently hold: one offered by a check, or one downloaded. */
export class UpdateNotReady extends Error {
  readonly _tag = "UpdateNotReady" as const;

  constructor(readonly needed: "available" | "downloaded") {
    super(needed === "available" ? "No verified update available" : "No verified update downloaded");
  }
}

/**
 * The update on offer and how far it has got. A download belongs to the payload it started with; `abort` stops it when
 * that payload is withdrawn, and only the download that still owns the current offer may make it `ready`.
 */
type UpdateState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "available"; readonly payload: UpdatePayload }
  | {
      readonly _tag: "downloading";
      readonly payload: UpdatePayload;
      readonly operation: Promise<string>;
      readonly abort: AbortController;
    }
  | { readonly _tag: "ready"; readonly payload: UpdatePayload; readonly file: string };

function samePayload(left: UpdatePayload, right: UpdatePayload): boolean {
  return (
    left.version === right.version &&
    left.url === right.url &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.publisher === right.publisher
  );
}

/**
 * Checks the signed feed, downloads and verifies the offered installer, and hands it over for installation. Operations
 * that would conflict are ordered rather than raced: concurrent downloads of one offer share a single transfer, a
 * check that changes the offer stops the old download, and a failed check leaves the current offer untouched.
 */
export class UpdateManager {
  private readonly config: { feedUrl: string; publicKeySpkiBase64: string; expectedPublisher: string };
  private state: UpdateState = { _tag: "idle" };
  /** Advances whenever the offer is replaced or withdrawn; work started under an older value is stale. */
  private generation = 0;
  /** Advances with each check, so only the most recent one may apply its answer. */
  private checkSequence = 0;
  /** Settles once the latest download has finished all its file work, successful or not. Never rejects. */
  private downloadSettled: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataRoot: string,
    private readonly currentVersion: string,
    private readonly scriptPath: string,
    configPath: string,
  ) {
    this.config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  }

  /**
   * Reads the signed feed and offers its release if it is newer than this app. A different release replaces the offer
   * and stops any download of the old one; the same release keeps a download in flight or already finished. Rejects,
   * leaving the offer as it was, when the feed can't be read or verified; rejects with `UpdateSuperseded` when a later
   * check or `cancel()` overtook this one.
   */
  async check(): Promise<UpdateCheck> {
    this.checkSequence += 1;
    const sequence = this.checkSequence;
    const generation = this.generation;
    const feed = safeHttpsUrl(this.config.feedUrl);

    if (!feed || !this.config.publicKeySpkiBase64) return { state: "unavailable" };
    const response = await fetchHttps(feed, AbortSignal.timeout(10_000));

    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 32_768) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Update manifest unavailable");
    }

    const text = await boundedText(response, 32_768);
    const payload = verifyReleaseEnvelope(text, this.config.publicKeySpkiBase64, this.config.expectedPublisher);

    if (sequence !== this.checkSequence || generation !== this.generation) throw new UpdateSuperseded("check");

    if (!newer(payload.version, this.currentVersion)) {
      this.offer(null);

      return { state: "current" };
    }

    this.offer(payload);

    return { state: "available", version: payload.version, size: payload.size };
  }

  /** The feed's link to the newest macOS build, which the Mac app sends people to instead of installing; null with no feed. */
  macDownloadUrl(): string | null {
    const feed = safeHttpsUrl(this.config.feedUrl);

    return feed ? new URL("/mac", feed).toString() : null;
  }

  /**
   * Downloads and verifies the offered installer and resolves with its version. A download already running for the
   * offer is joined, and a finished one resolves at once. Rejects with `UpdateNotReady` when nothing is offered and with
   * `UpdateSuperseded` when the offer changes or is cancelled first; any other failure returns to the offered state.
   */
  async download(): Promise<string> {
    const state = this.state;

    if (state._tag === "idle") throw new UpdateNotReady("available");

    if (state._tag === "downloading") return state.operation;

    if (state._tag === "ready") return state.payload.version;
    const { payload } = state;
    const generation = this.generation;
    const abort = new AbortController();

    // A superseded download may still be finishing its file work; this one waits for it so the two never touch the
    // update folder at once.
    const operation = this.downloadSettled
      .then(() => this.saveInstaller(payload, abort.signal))
      .then(
        (file) => {
          if (generation !== this.generation) throw new UpdateSuperseded("download");
          this.state = { _tag: "ready", payload, file };

          return payload.version;
        },
        (cause) => {
          if (generation !== this.generation) throw new UpdateSuperseded("download", cause);
          this.state = { _tag: "available", payload };
          throw cause;
        },
      );

    this.downloadSettled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.state = { _tag: "downloading", payload, operation, abort };

    return operation;
  }

  /**
   * Withdraws the offer, stops any download, and discards the answer of a check still in flight. Resolves once the
   * stopped download has released its connection and finished with its files, so the update folder can be removed.
   */
  async cancel(): Promise<void> {
    this.offer(null);
    await this.downloadSettled;
  }

  /**
   * Re-verifies the downloaded installer's size, hash, and publisher just before it is launched and returns its path.
   * Rejects with `UpdateNotReady` when no download finished for the current offer.
   */
  async installerForApprovedHandoff(): Promise<string> {
    const state = this.state;

    if (state._tag !== "ready") throw new UpdateNotReady("downloaded");
    const { payload, file } = state;

    if ((await stat(file)).size !== payload.size || !sameHex(await sha256File(file), payload.sha256)) {
      throw new Error("Downloaded update changed");
    }

    await this.verifyPublisher(file, payload.publisher);

    if (this.state !== state) throw new UpdateSuperseded("install");

    return file;
  }

  /** Replaces the offer with `payload`, or withdraws it. Re-offering the same release keeps its download. */
  private offer(payload: UpdatePayload | null): void {
    const state = this.state;

    if (payload && state._tag !== "idle" && samePayload(state.payload, payload)) return;

    if (state._tag === "downloading") state.abort.abort();
    this.generation += 1;
    this.state = payload ? { _tag: "available", payload } : { _tag: "idle" };
  }

  /** Downloads `payload`'s installer into the update folder, verifies it, and returns its final path. */
  private async saveInstaller(payload: UpdatePayload, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new UpdateSuperseded("download");
    const updateDir = path.join(this.dataRoot, "updates");
    await mkdir(updateDir, { recursive: true });
    const temporary = path.join(updateDir, `${randomUUID()}.partial.exe`);
    const final = path.join(updateDir, `PermitMonitorSetup-${payload.version}.exe`);
    const installerUrl = safeHttpsUrl(payload.url);

    if (!installerUrl) throw new Error("Update URL invalid");
    // The installer is large, so abort on a stalled connection rather than a fixed total time.
    const stall = new AbortController();
    let stallTimer = setTimeout(() => stall.abort(), 60_000);
    let hash: string;

    try {
      const response = await fetchHttps(installerUrl, AbortSignal.any([stall.signal, signal]));

      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Update download failed");
      }

      hash = await saveDownload(response.body, temporary, payload.size, () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(), 60_000);
      });
    } catch (cause) {
      // Aborting ends the connection, whatever step failed.
      stall.abort();

      if (signal.aborted) throw new UpdateSuperseded("download", cause);
      throw cause;
    } finally {
      clearTimeout(stallTimer);
    }

    if (!sameHex(hash, payload.sha256)) {
      await rm(temporary, { force: true });
      throw new Error("Update hash mismatch");
    }

    try {
      await this.verifyPublisher(temporary, payload.publisher, signal);

      // A withdrawn offer must not replace the installer or clear the folder.
      if (signal.aborted) throw new UpdateSuperseded("download");
      await rm(final, { force: true });
      await rename(temporary, final);

      for (const entry of await readdir(updateDir)) {
        if (
          (entry.startsWith("PermitMonitorSetup-") && entry.endsWith(".exe") && entry !== path.basename(final)) ||
          entry.endsWith(".partial.exe")
        )
          await rm(path.join(updateDir, entry), { force: true });
      }
    } catch (cause) {
      await rm(temporary, { force: true });
      throw cause;
    }

    return final;
  }

  private async verifyPublisher(file: string, publisher: string, signal?: AbortSignal): Promise<void> {
    // verifyReleaseEnvelope already required publisher === config.expectedPublisher, so an empty value
    // only reaches here from an unsigned-build configuration.
    if (!publisher) return;

    if (process.platform !== "win32") throw new Error("Authenticode verification requires Windows");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          this.scriptPath,
          "-InstallerPath",
          file,
          "-ExpectedPublisher",
          publisher,
        ],
        { windowsHide: true, stdio: "ignore", signal },
      );

      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Update publisher verification failed")),
      );
    });
  }
}
