import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  saveDownload,
  UpdateManager,
  UpdateNotReady,
  UpdateSuperseded,
  verifyReleaseEnvelope,
} from "../src/main/updater.js";

describe("signed update metadata", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

  const payload = {
    version: "0.2.0",
    url: "https://updates.example.test/PermitMonitorSetup.exe",
    sha256: "a".repeat(64),
    size: 250_000_000,
    publisher: "Permit Monitor LLC",
  };

  function envelope(value: typeof payload): string {
    const signed = Buffer.from(JSON.stringify(value));

    return JSON.stringify({
      signed: signed.toString("base64"),
      signature: sign(null, signed, keys.privateKey).toString("base64"),
    });
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
    expect(() =>
      verifyReleaseEnvelope(
        envelope({ ...payload, url: "http://updates.example.test/app.exe" }),
        publicKey,
        "Permit Monitor LLC",
      ),
    ).toThrow();
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

// A self-signed certificate for localhost and 127.0.0.1, trusted only while these tests run. Regenerate with:
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj "/CN=localhost"
//   -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout localhost-key.pem -out localhost-cert.pem
const tlsKey = readFileSync(path.resolve("tests/fixtures/updater/localhost-key.pem"), "utf8");

const tlsCert = readFileSync(path.resolve("tests/fixtures/updater/localhost-cert.pem"), "utf8");

interface Installer {
  bytes: Buffer;
  release: Promise<void>;
  drop: boolean;
}

/**
 * Serves a signed release feed and its installers over local HTTPS. Each installer sends its first half, then waits for
 * its release before sending the rest (or dropping the connection). Installer requests are recorded, along with those
 * the client hung up on before the end.
 */
async function updateServer(signingKey: KeyObject) {
  let feed = { status: 404, body: "" };
  const installers = new Map<string, Installer>();
  const requests: string[] = [];
  const hungUp: string[] = [];

  const server = createServer({ key: tlsKey, cert: tlsCert }, (request, response) => {
    if (request.url === "/feed") {
      response.writeHead(feed.status).end(feed.body);

      return;
    }

    const name = request.url?.replace("/installer/", "") ?? "";
    const installer = installers.get(name);

    if (!installer) {
      response.writeHead(404).end();

      return;
    }

    requests.push(name);
    response.on("close", () => {
      if (!response.writableFinished) hungUp.push(name);
    });
    const half = Math.floor(installer.bytes.length / 2);
    response.writeHead(200, { "content-length": installer.bytes.length });
    response.write(installer.bytes.subarray(0, half));
    void installer.release.then(() => {
      if (installer.drop) response.destroy();
      else response.end(installer.bytes.subarray(half));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const origin = `https://127.0.0.1:${port}`;

  return {
    origin,
    requests,
    hungUp,
    /** Publishes a signed manifest for `bytes` as `version`, served in full unless held. */
    publish(version: string, bytes: Buffer): void {
      installers.set(version, { bytes, release: Promise.resolve(), drop: false });

      const signed = Buffer.from(
        JSON.stringify({
          version,
          url: `${origin}/installer/${version}`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          publisher: "",
        }),
      );

      feed = {
        status: 200,
        body: JSON.stringify({
          signed: signed.toString("base64"),
          signature: sign(null, signed, signingKey).toString("base64"),
        }),
      };
    },
    /** Holds `version`'s installer after its first half until the returned function is called. */
    hold(version: string): () => void {
      let open: () => void = () => undefined;

      const released = new Promise<void>((resolve) => {
        open = resolve;
      });

      const installer = installers.get(version);

      if (installer) installer.release = released;

      return open;
    },
    /** Serves `bytes` for `version` from now on without changing its signed manifest; `drop` cuts it off halfway. */
    serve(version: string, bytes: Buffer, ending: "end" | "drop"): void {
      installers.set(version, { bytes, release: Promise.resolve(), drop: ending === "drop" });
    },
    failFeed(status: number): void {
      feed = { status, body: "" };
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("update operations", () => {
  const trusted = getCACertificates("default");
  const keys = generateKeyPairSync("ed25519");
  const directories: string[] = [];
  const servers: Array<{ close(): Promise<void> }> = [];

  beforeAll(() => {
    setDefaultCACertificates([...trusted, tlsCert]);
  });

  afterAll(() => {
    setDefaultCACertificates(trusted);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();

    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** A running feed server and an UpdateManager for app version 1.0.0 that reads it, with its own data folder. */
  async function setup() {
    const server = await updateServer(keys.privateKey);
    servers.push(server);
    const dataRoot = mkdtempSync(path.join(tmpdir(), "permit-monitor-updates-"));
    directories.push(dataRoot);
    const config = path.join(dataRoot, "update-config.json");
    writeFileSync(
      config,
      JSON.stringify({
        feedUrl: `${server.origin}/feed`,
        expectedPublisher: "",
        publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      }),
    );
    const updates = new UpdateManager(dataRoot, "1.0.0", "unused-authenticode.ps1", config);

    const updateFiles = async (): Promise<string[]> => {
      const folder = path.join(dataRoot, "updates");

      return existsSync(folder) ? readdir(folder) : [];
    };

    return { server, updates, updateFiles };
  }

  const first = Buffer.from("installer 1.1.0 ".repeat(4096));

  const second = Buffer.from("installer 1.2.0 ".repeat(4096));

  it("keeps a download going through a failed recheck and hands over the verified installer", async () => {
    const { server, updates } = await setup();
    server.publish("1.1.0", first);
    expect(await updates.check()).toEqual({ state: "available", version: "1.1.0", size: first.length });
    const release = server.hold("1.1.0");
    const download = updates.download();
    await vi.waitFor(() => expect(server.requests).toEqual(["1.1.0"]));

    server.failFeed(503);
    await expect(updates.check()).rejects.toThrow();
    release();

    await expect(download).resolves.toBe("1.1.0");
    expect(readFileSync(await updates.installerForApprovedHandoff())).toEqual(first);
  });

  it("joins a download in flight when the same release is offered again", async () => {
    const { server, updates } = await setup();
    server.publish("1.1.0", first);
    await updates.check();
    const release = server.hold("1.1.0");
    const download = updates.download();
    await vi.waitFor(() => expect(server.requests).toEqual(["1.1.0"]));

    expect(await updates.check()).toEqual({ state: "available", version: "1.1.0", size: first.length });
    const again = updates.download();
    release();

    expect(await Promise.all([download, again])).toEqual(["1.1.0", "1.1.0"]);
    expect(server.requests).toEqual(["1.1.0"]);
    expect(readFileSync(await updates.installerForApprovedHandoff())).toEqual(first);
  });

  it("stops the old download when the feed offers a newer release, and installs only the new one", async () => {
    const { server, updates, updateFiles } = await setup();
    server.publish("1.1.0", first);
    await updates.check();
    server.hold("1.1.0");
    const stale = updates.download();
    await vi.waitFor(() => expect(server.requests).toEqual(["1.1.0"]));

    server.publish("1.2.0", second);
    expect(await updates.check()).toEqual({ state: "available", version: "1.2.0", size: second.length });
    await expect(stale).rejects.toBeInstanceOf(UpdateSuperseded);
    await vi.waitFor(() => expect(server.hungUp).toEqual(["1.1.0"]));

    await expect(updates.installerForApprovedHandoff()).rejects.toBeInstanceOf(UpdateNotReady);

    expect(await updates.download()).toBe("1.2.0");
    expect(readFileSync(await updates.installerForApprovedHandoff())).toEqual(second);
    expect(await updateFiles()).toEqual(["PermitMonitorSetup-1.2.0.exe"]);
  });

  it("rejects a failed or altered download without keeping it, and can try the same release again", async () => {
    const { server, updates, updateFiles } = await setup();
    server.publish("1.1.0", first);
    await updates.check();

    server.serve("1.1.0", first, "drop");
    await expect(updates.download()).rejects.toThrow();
    server.serve("1.1.0", second, "end");
    await expect(updates.download()).rejects.toThrow("Update hash mismatch");
    await expect(updates.installerForApprovedHandoff()).rejects.toBeInstanceOf(UpdateNotReady);
    expect(await updateFiles()).toEqual([]);

    server.serve("1.1.0", first, "end");
    expect(await updates.download()).toBe("1.1.0");
    expect(readFileSync(await updates.installerForApprovedHandoff())).toEqual(first);
  });

  it("cancels a download in flight, releasing the connection and its partial file before resolving", async () => {
    const { server, updates, updateFiles } = await setup();
    server.publish("1.1.0", first);
    await updates.check();
    server.hold("1.1.0");
    const download = updates.download();
    await vi.waitFor(() => expect(server.requests).toEqual(["1.1.0"]));

    const stopped = expect(download).rejects.toBeInstanceOf(UpdateSuperseded);
    await updates.cancel();
    expect(await updateFiles()).toEqual([]);
    await stopped;
    await vi.waitFor(() => expect(server.hungUp).toEqual(["1.1.0"]));

    await expect(updates.download()).rejects.toBeInstanceOf(UpdateNotReady);
    await expect(updates.installerForApprovedHandoff()).rejects.toBeInstanceOf(UpdateNotReady);
  });
});
