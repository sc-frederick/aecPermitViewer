import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveDownload, verifyReleaseEnvelope } from "../src/main/updater.js";

describe("signed update metadata", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

  const payload = { version: "0.2.0", url: "https://updates.example.test/PermitMonitorSetup.exe",
    sha256: "a".repeat(64), size: 250_000_000, publisher: "Permit Monitor LLC" };

  function envelope(value: typeof payload): string {
    const signed = Buffer.from(JSON.stringify(value));

    return JSON.stringify({ signed: signed.toString("base64"), signature: sign(null, signed, keys.privateKey).toString("base64") });
  }

  it("accepts a signed installer hash and expected publisher", () => {
    expect(verifyReleaseEnvelope(envelope(payload), publicKey, "Permit Monitor LLC")).toEqual(payload);
  });

  it("accepts an unsigned-build manifest only when no publisher is expected", () => {
    const unsigned = { ...payload, publisher: "" };
    expect(verifyReleaseEnvelope(envelope(unsigned), publicKey, "")).toEqual(unsigned);
    expect(() => verifyReleaseEnvelope(envelope(unsigned), publicKey, "Permit Monitor LLC")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope(payload), publicKey, "")).toThrow();
  });

  it("rejects a manifest signed by another key", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => verifyReleaseEnvelope(envelope(payload), other, "Permit Monitor LLC")).toThrow();
  });

  it("rejects altered metadata, wrong publisher, and non-HTTPS installer", () => {
    const valid = JSON.parse(envelope(payload));
    valid.signed = Buffer.from(JSON.stringify({ ...payload, sha256: "b".repeat(64) })).toString("base64");
    expect(() => verifyReleaseEnvelope(JSON.stringify(valid), publicKey, "Permit Monitor LLC")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope(payload), publicKey, "Other Publisher")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope({ ...payload, url: "http://updates.example.test/app.exe" }), publicKey, "Permit Monitor LLC")).toThrow();
  });
});

describe("installer download", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function target(): string {
    const directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-update-"));
    directories.push(directory);

    return path.join(directory, "setup.partial.exe");
  }

  /** A download that sends `chunks`, then ends or fails; `cancelled` records whether the app released it. */
  function stream(chunks: readonly string[], ending: "end" | "fail") {
    const state = { cancelled: false };
    const queue = [...chunks];

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();

        if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
        else if (ending === "end") controller.close();
        else controller.error(new Error("connection reset"));
      },
      cancel() {
        state.cancelled = true;
      },
    });

    return { body, state };
  }

  it("saves a complete download and returns its hash", async () => {
    const file = target();
    const { body } = stream(["Permit", "Monitor"], "end");
    const hash = await saveDownload(body, file, 13, () => undefined);
    expect(hash).toBe(createHash("sha256").update("PermitMonitor").digest("hex"));
    expect(readFileSync(file, "utf8")).toBe("PermitMonitor");
  });

  it("removes the partial file when the connection fails partway", async () => {
    const file = target();
    const { body } = stream(["Permit"], "fail");
    await expect(saveDownload(body, file, 13, () => undefined)).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it("stops reading and removes the file when more bytes arrive than the manifest promised", async () => {
    const file = target();
    const { body, state } = stream(["Permit", "Monitor", "Extra"], "end");
    await expect(saveDownload(body, file, 8, () => undefined)).rejects.toThrow("Update size exceeded");
    expect(state.cancelled).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects a download that ends early", async () => {
    const file = target();
    const { body } = stream(["Permit"], "end");
    await expect(saveDownload(body, file, 13, () => undefined)).rejects.toThrow("Update ended early");
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a file it didn't create in place", async () => {
    const file = target();
    writeFileSync(file, "someone else's file");
    const { body, state } = stream(["Permit"], "end");
    await expect(saveDownload(body, file, 6, () => undefined)).rejects.toMatchObject({ code: "EEXIST" });
    expect(state.cancelled).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("someone else's file");
  });

  it("releases the connection when the file can't be written", async () => {
    const { body, state } = stream(["Permit"], "end");
    const blocked = path.join(target(), "missing-folder", "setup.partial.exe");
    await expect(saveDownload(body, blocked, 6, () => undefined)).rejects.toThrow();
    expect(state.cancelled).toBe(true);
  });
});
