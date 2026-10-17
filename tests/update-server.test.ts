import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type FeedEnv } from "../infra/update-server/src/index.js";
import type { FeedPutOptions } from "../infra/update-server/src/bucket.js";
import { parseReleaseVersion } from "../infra/update-server/src/manifest.js";
import {
  compareReleaseVersions,
  decideInstallerUpload,
  decideManifestReplacement,
  type VersionedManifest,
} from "../infra/update-server/src/release-policy.js";
import { MemoryBucket } from "./fixtures/memory-bucket.js";
import { LocalFixedLengthStream } from "./fixtures/fixed-length-stream.js";

Object.defineProperty(globalThis, "FixedLengthStream", { value: LocalFixedLengthStream, configurable: true });

const ORIGIN = "https://permitmon-updates.example.test";

const TOKEN = "upload-token";

const INSTALLER_TYPE = "application/vnd.microsoft.portable-executable";

const keys = generateKeyPairSync("ed25519");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A manifest signed the way scripts/sign-release-manifest.mjs signs one. */
function manifest(version: string, installer: string, publisher = ""): string {
  const signed = Buffer.from(
    JSON.stringify({
      version,
      url: `${ORIGIN}/PermitMonitorSetup-${version}.exe`,
      sha256: sha256(installer),
      size: Buffer.byteLength(installer),
      publisher,
    }),
  );

  return JSON.stringify({
    signed: signed.toString("base64"),
    signature: sign(null, signed, keys.privateKey).toString("base64"),
  });
}

/** A bucket and the Worker bindings that serve it. */
interface TestFeed {
  readonly bucket: MemoryBucket;
  readonly env: FeedEnv;
}

function feed(bucket = new MemoryBucket()): TestFeed {
  return { bucket, env: { BUCKET: bucket, UPLOAD_TOKEN: TOKEN } };
}

function call(env: FeedEnv, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

function uploadCall(env: FeedEnv, path: string, method: string, body?: BodyInit): Promise<Response> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}` } };

  if (body !== undefined) init.body = body;

  return call(env, `/upload/${path}`, init);
}

/** Uploads `installer` through the manual multipart protocol in parts of `partBytes`, as scripts/publish-update.mjs does. */
async function uploadInstaller(env: FeedEnv, version: string, installer: string, partBytes = 4): Promise<Response> {
  const key = `PermitMonitorSetup-${version}.exe`;
  const claim = { sha256: sha256(installer), size: Buffer.byteLength(installer) };
  const started = await uploadCall(env, key, "POST", JSON.stringify(claim));

  if (started.status !== 200) return started;
  const start = await started.clone().json();

  if (start.status !== "created") return started;
  const parts = [];
  const bytes = new TextEncoder().encode(installer);

  for (let offset = 0, partNumber = 1; offset < bytes.length; offset += partBytes, partNumber += 1) {
    const response = await uploadCall(
      env,
      `${key}?stagingKey=${encodeURIComponent(start.stagingKey)}&uploadId=${start.uploadId}&partNumber=${partNumber}`,
      "PUT",
      bytes.slice(offset, offset + partBytes),
    );

    parts.push(await response.json());
  }

  return uploadCall(
    env,
    `${key}?stagingKey=${encodeURIComponent(start.stagingKey)}&uploadId=${start.uploadId}`,
    "POST",
    JSON.stringify({ ...claim, parts }),
  );
}

function version(text: string): VersionedManifest["version"] {
  const parsed = parseReleaseVersion(text);

  if (!parsed) throw new Error(`test version ${text} is invalid`);

  return parsed;
}

describe("release publication policy", () => {
  it("orders versions numerically, not as text", () => {
    expect(compareReleaseVersions(version("0.10.0"), version("0.9.9"))).toBeGreaterThan(0);
    expect(compareReleaseVersions(version("1.0.0"), version("0.99.99"))).toBeGreaterThan(0);
    expect(compareReleaseVersions(version("0.7.0"), version("0.7.0"))).toBe(0);
    expect(compareReleaseVersions(version("0.7.0"), version("0.7.1"))).toBeLessThan(0);
  });

  it("accepts only major.minor.patch versions", () => {
    expect(parseReleaseVersion("0.7.0")).toEqual({ text: "0.7.0", major: 0, minor: 7, patch: 0 });

    for (const text of ["0.7", "0.7.0-beta.1", "v0.7.0", " 0.7.0", "0.7.0.1", `${"9".repeat(20)}.0.0`]) {
      expect(parseReleaseVersion(text)).toBeNull();
    }
  });

  it("writes a versioned installer once and accepts only an identical retry", () => {
    const candidate = { size: 10, sha256: "a".repeat(64) };
    expect(decideInstallerUpload(null, candidate)).toEqual({ _tag: "upload" });
    expect(decideInstallerUpload({ size: 10, sha256: "a".repeat(64) }, candidate)).toEqual({
      _tag: "already_published",
    });
    expect(decideInstallerUpload({ size: 10, sha256: "b".repeat(64) }, candidate)._tag).toBe("conflict");
    expect(decideInstallerUpload({ size: 11, sha256: null }, candidate)._tag).toBe("conflict");
    expect(decideInstallerUpload({ size: 10, sha256: null }, candidate)).toEqual({ _tag: "unverified" });
  });

  it("moves the manifest only to a newer version", () => {
    const published = { version: version("0.7.0"), text: "published" };
    expect(decideManifestReplacement(null, published)).toEqual({ _tag: "replace" });
    expect(decideManifestReplacement(published, { version: version("0.10.0"), text: "newer" })).toEqual({
      _tag: "replace",
    });
    expect(decideManifestReplacement(published, { version: version("0.6.9"), text: "older" })).toEqual({
      _tag: "stale",
      published: "0.7.0",
    });
    expect(decideManifestReplacement(published, { version: version("0.7.0"), text: "published" })).toEqual({
      _tag: "unchanged",
    });
    expect(decideManifestReplacement(published, { version: version("0.7.0"), text: "resigned" })).toEqual({
      _tag: "conflict",
      published: "0.7.0",
    });
  });
});

describe("update feed downloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withInstaller(): TestFeed {
    const setup = feed();
    setup.bucket.seed("PermitMonitorSetup-0.7.0.exe", "0123456789", INSTALLER_TYPE, sha256("0123456789"));
    setup.bucket.seed("release-manifest.json", manifest("0.7.0", "0123456789"), "application/json");

    return setup;
  }

  function quietStorageLog(): void {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  it("serves a whole installer and the manifest with their cache policies", async () => {
    const { env } = withInstaller();
    const installer = await call(env, "/PermitMonitorSetup-0.7.0.exe");
    expect(installer.status).toBe(200);
    expect(await installer.text()).toBe("0123456789");
    expect(installer.headers.get("cache-control")).toContain("immutable");
    expect(installer.headers.get("content-type")).toBe(INSTALLER_TYPE);

    const feedManifest = await call(env, "/release-manifest.json");
    expect(feedManifest.headers.get("cache-control")).toBe("no-cache");
    expect(await feedManifest.text()).toBe(manifest("0.7.0", "0123456789"));
  });

  it("answers a storage failure on an ordinary GET with a retryable 503, not 416", async () => {
    const { bucket, env } = withInstaller();
    quietStorageLog();
    bucket.failing.add("get");
    const response = await call(env, "/PermitMonitorSetup-0.7.0.exe");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");

    bucket.failing.clear();
    bucket.failing.add("head");
    expect((await call(env, "/PermitMonitorSetup-0.7.0.exe", { method: "HEAD" })).status).toBe(503);
    expect((await call(env, "/PermitMonitorSetup-0.7.0.exe", { headers: { range: "bytes=0-1" } })).status).toBe(503);
  });

  it("serves byte ranges, including open-ended and suffix ranges", async () => {
    const { env } = withInstaller();

    const cases: [string, string, string][] = [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
      ["bytes=-50", "0123456789", "bytes 0-9/10"],
    ];

    for (const [range, body, contentRange] of cases) {
      const response = await call(env, "/PermitMonitorSetup-0.7.0.exe", { headers: { range } });
      expect(response.status, range).toBe(206);
      expect(response.headers.get("content-range"), range).toBe(contentRange);
      expect(await response.text(), range).toBe(body);
    }
  });

  it("returns 416 only for a well-formed range past the end, and ignores ranges it doesn't support", async () => {
    const { env } = withInstaller();
    const unsatisfiable = await call(env, "/PermitMonitorSetup-0.7.0.exe", { headers: { range: "bytes=10-" } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
    expect((await call(env, "/PermitMonitorSetup-0.7.0.exe", { headers: { range: "bytes=-0" } })).status).toBe(416);

    for (const range of ["bytes=abc", "bytes=5-2", "bytes=0-1,4-5", "items=0-1"]) {
      const whole = await call(env, "/PermitMonitorSetup-0.7.0.exe", { headers: { range } });
      expect(whole.status, range).toBe(200);
      expect(await whole.text(), range).toBe("0123456789");
    }
  });

  it("reports the installer size on HEAD without a body", async () => {
    const { env } = withInstaller();
    const response = await call(env, "/PermitMonitorSetup-0.7.0.exe", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("etag")).toMatch(/^".+"$/);
  });

  it("rejects a malformed percent-encoded path with 400", async () => {
    const { env } = withInstaller();
    expect((await call(env, "/%ZZ")).status).toBe(400);
    expect((await uploadCall(env, "PermitMonitorSetup-%E0%A4%A.exe", "POST", "{}")).status).toBe(400);
  });

  it("redirects the stable link to the published version", async () => {
    const { bucket, env } = withInstaller();
    const response = await call(env, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/PermitMonitorSetup-0.7.0.exe`);

    quietStorageLog();
    bucket.failing.add("get");
    expect((await call(env, "/PermitMonitorSetup.exe")).status).toBe(503);
  });

  it("redirects the Mac link to the published version's zip and serves it", async () => {
    const { bucket, env } = withInstaller();
    const response = await call(env, "/mac");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/PermitMonitor-0.7.0-mac-arm64.zip`);

    bucket.seed("PermitMonitor-0.7.0-mac-arm64.zip", "zipped", "application/zip", sha256("zipped"));
    const zip = await call(env, "/PermitMonitor-0.7.0-mac-arm64.zip");
    expect(zip.status).toBe(200);
    expect(await zip.text()).toBe("zipped");
    expect(zip.headers.get("content-disposition")).toBe('attachment; filename="PermitMonitor-0.7.0-mac-arm64.zip"');
    expect((await uploadCall(env, "PermitMonitor-0.8.0-mac-arm64.zip", "POST", "{}")).status).toBe(400);
  });

  it("does not redirect to an unreadable manifest", async () => {
    const { bucket, env } = feed();
    bucket.seed("release-manifest.json", "{not json", "application/json");
    expect((await call(env, "/")).status).toBe(500);
  });
});

describe("manual installer upload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires the upload token", async () => {
    const { env } = feed();

    const response = await call(env, "/upload/PermitMonitorSetup-0.8.0.exe", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.status).toBe(401);
    expect(
      (
        await worker.fetch(new Request(`${ORIGIN}/upload/release-manifest.json`, { method: "PUT" }), {
          BUCKET: new MemoryBucket(),
        })
      ).status,
    ).toBe(401);
  });

  it("assembles the parts and records the declared hash", async () => {
    const { bucket, env } = feed();
    const response = await uploadInstaller(env, "0.8.0", "new installer bytes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "published", size: 19 });
    expect(bucket.storedText("PermitMonitorSetup-0.8.0.exe")).toBe("new installer bytes");
    expect((await bucket.head("PermitMonitorSetup-0.8.0.exe"))?.customMetadata?.sha256).toBe(
      sha256("new installer bytes"),
    );
  });

  it.each([false, true])("atomically publishes competing manual uploads (identical=%s)", async (identical) => {
    let arrived = 0;
    let release = () => {};

    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    class CompetingBucket extends MemoryBucket {
      override async put(key: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions) {
        if (key === "PermitMonitorSetup-0.8.0.exe") {
          arrived += 1;

          if (arrived === 2) release();
          await barrier;
        }

        return super.put(key, value, options);
      }
    }

    const { bucket, env } = feed(new CompetingBucket());

    const responses = await Promise.all([
      uploadInstaller(env, "0.8.0", "AAAA"),
      uploadInstaller(env, "0.8.0", identical ? "AAAA" : "BBBB"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual(identical ? [200, 200] : [200, 409]);
    const winner = bucket.storedText("PermitMonitorSetup-0.8.0.exe");
    expect(winner).toBe(identical ? "AAAA" : ["AAAA", "BBBB"][responses[0]?.status === 200 ? 0 : 1]);
    expect(bucket.openUploads).toBe(0);
    bucket.seed("PermitMonitor-0.8.0-mac-arm64.zip", "mac eight", "application/zip", sha256("mac eight"));

    if (!winner) throw new Error("Winning artifact is absent");
    expect((await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", winner))).status).toBe(200);
    expect(
      (await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", winner === "AAAA" ? "BBBB" : "AAAA")))
        .status,
    ).toBe(409);
    expect(await (await call(env, "/PermitMonitorSetup-0.8.0.exe")).text()).toBe(winner);
  });

  it("does not delete a CI winner when staged completion validation fails", async () => {
    const key = "PermitMonitorSetup-0.8.0.exe";

    class CiPublishesDuringCompletion extends MemoryBucket {
      override resumeMultipartUpload(stagingKey: string, uploadId: string) {
        const multipart = super.resumeMultipartUpload(stagingKey, uploadId);

        return {
          ...multipart,
          complete: async (parts: Parameters<typeof multipart.complete>[0]) => {
            const staged = await multipart.complete(parts);
            this.seed(key, "CI!!", INSTALLER_TYPE, sha256("CI!!"));

            return staged;
          },
        };
      }
    }

    const { bucket, env } = feed(new CiPublishesDuringCompletion());
    const claim = { sha256: sha256("manual"), size: 6 };
    const start = await (await uploadCall(env, key, "POST", JSON.stringify(claim))).json();
    const session = new URLSearchParams({ uploadId: start.uploadId, stagingKey: start.stagingKey });
    const part = await (await uploadCall(env, `${key}?${session}&partNumber=1`, "PUT", "bad")).json();
    const completed = await uploadCall(env, `${key}?${session}`, "POST", JSON.stringify({ ...claim, parts: [part] }));
    expect(completed.status).toBe(409);
    expect(bucket.storedText(key)).toBe("CI!!");
    expect(bucket.storedText(start.stagingKey)).toBeNull();
  });

  it("rejects same-size corrupt bytes before any public artifact is created", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";
    const claim = { sha256: sha256("AAAA"), size: 4 };
    const start = await (await uploadCall(env, key, "POST", JSON.stringify(claim))).json();
    const session = new URLSearchParams({ uploadId: start.uploadId, stagingKey: start.stagingKey });
    const part = await (await uploadCall(env, `${key}?${session}&partNumber=1`, "PUT", "BBBB")).json();
    expect(
      (await uploadCall(env, `${key}?${session}`, "POST", JSON.stringify({ ...claim, parts: [part] }))).status,
    ).toBe(409);
    expect(bucket.storedText(key)).toBeNull();
    expect(bucket.storedText(start.stagingKey)).toBeNull();
  });

  it("finishes when storage rejects a conditional write without consuming its stream", async () => {
    const key = "PermitMonitorSetup-0.8.0.exe";

    class EarlyPreconditionRejection extends MemoryBucket {
      override async put(name: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions) {
        if (name === key) {
          this.seed(key, "BBBB", INSTALLER_TYPE, sha256("BBBB"));

          return null;
        }

        return super.put(name, value, options);
      }
    }

    const { bucket, env } = feed(new EarlyPreconditionRejection());
    expect((await uploadInstaller(env, "0.8.0", "AAAA")).status).toBe(409);
    expect(bucket.storedText(key)).toBe("BBBB");
  });

  it("reports an identical retry as published without starting another upload", async () => {
    const { bucket, env } = feed();
    await uploadInstaller(env, "0.8.0", "new installer bytes");
    const retry = await uploadInstaller(env, "0.8.0", "new installer bytes");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "published" });
    expect(bucket.openUploads).toBe(0);
  });

  it("refuses to start an upload that would replace an installer with different bytes", async () => {
    const { bucket, env } = feed();
    await uploadInstaller(env, "0.8.0", "new installer bytes");
    expect((await uploadInstaller(env, "0.8.0", "rebuilt installer!!")).status).toBe(409);
    expect((await uploadInstaller(env, "0.8.0", "shorter")).status).toBe(409);
    expect(bucket.storedText("PermitMonitorSetup-0.8.0.exe")).toBe("new installer bytes");
  });

  it("refuses an older installer that was stored without a recorded hash", async () => {
    const { bucket, env } = feed();
    bucket.seed("PermitMonitorSetup-0.6.0.exe", "old bytes", INSTALLER_TYPE);
    expect((await uploadInstaller(env, "0.6.0", "old bytes")).status).toBe(409);
    expect(bucket.storedText("PermitMonitorSetup-0.6.0.exe")).toBe("old bytes");
  });

  it("repeats the immutability check at completion", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";
    const late = { sha256: sha256("second"), size: 6 };
    // Both uploads start while the key is empty; the one started second completes first.
    const started = await (await uploadCall(env, key, "POST", JSON.stringify(late))).json();

    const part = await (
      await uploadCall(
        env,
        `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}&partNumber=1`,
        "PUT",
        "second",
      )
    ).json();

    expect((await uploadInstaller(env, "0.8.0", "first!")).status).toBe(200);

    const completed = await uploadCall(
      env,
      `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
      "POST",
      JSON.stringify({ ...late, parts: [part] }),
    );

    expect(completed.status).toBe(409);
    expect(bucket.storedText(key)).toBe("first!");
    expect(bucket.openUploads).toBe(0);
  });

  it("treats a completion that matches the installer published meanwhile as an identical retry", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";
    const claim = { sha256: sha256("same!!"), size: 6 };
    const started = await (await uploadCall(env, key, "POST", JSON.stringify(claim))).json();

    const part = await (
      await uploadCall(
        env,
        `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}&partNumber=1`,
        "PUT",
        "same!!",
      )
    ).json();

    await uploadInstaller(env, "0.8.0", "same!!");

    const completed = await uploadCall(
      env,
      `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
      "POST",
      JSON.stringify({ ...claim, parts: [part] }),
    );

    expect(await completed.json()).toEqual({ status: "published" });
    expect(bucket.openUploads).toBe(0);
  });

  it("removes a completed installer whose bytes don't match the declared size", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";
    const claim = { sha256: sha256("declared"), size: 8 };
    const started = await (await uploadCall(env, key, "POST", JSON.stringify(claim))).json();

    const part = await (
      await uploadCall(
        env,
        `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}&partNumber=1`,
        "PUT",
        "short",
      )
    ).json();

    const completed = await uploadCall(
      env,
      `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
      "POST",
      JSON.stringify({ ...claim, parts: [part] }),
    );

    expect(completed.status).toBe(409);
    expect(bucket.storedText(key)).toBeNull();
  });

  it("removes a completed installer when the completion declares a different hash than the start", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";

    const started = await (
      await uploadCall(env, key, "POST", JSON.stringify({ sha256: sha256("abc"), size: 3 }))
    ).json();

    const part = await (
      await uploadCall(
        env,
        `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}&partNumber=1`,
        "PUT",
        "abd",
      )
    ).json();

    const completion = { sha256: sha256("abd"), size: 3, parts: [part] };
    expect(
      (
        await uploadCall(
          env,
          `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
          "POST",
          JSON.stringify(completion),
        )
      ).status,
    ).toBe(409);
    expect(bucket.storedText(key)).toBeNull();
  });

  it("rejects malformed start and completion requests before calling storage", async () => {
    const { bucket, env } = feed();
    const key = "PermitMonitorSetup-0.8.0.exe";
    expect((await uploadCall(env, key, "POST")).status).toBe(400);
    expect((await uploadCall(env, key, "POST", JSON.stringify({ sha256: "not a hash", size: 3 }))).status).toBe(400);

    const started = await (
      await uploadCall(env, key, "POST", JSON.stringify({ sha256: sha256("abc"), size: 3 }))
    ).json();

    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ sha256: sha256("abc"), size: 3, parts: "all" }),
      JSON.stringify({ sha256: sha256("abc"), size: 3, parts: [{ partNumber: 0, etag: "x" }] }),
    ]) {
      expect(
        (
          await uploadCall(
            env,
            `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
            "POST",
            body,
          )
        ).status,
        body,
      ).toBe(400);
    }

    expect(bucket.openUploads).toBe(1);
    expect(
      (
        await uploadCall(
          env,
          `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}`,
          "POST",
          "x".repeat(1_048_577),
        )
      ).status,
    ).toBe(413);
  });

  it("answers storage failures during an upload with a retryable 503", async () => {
    const { bucket, env } = feed();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = "PermitMonitorSetup-0.8.0.exe";
    bucket.failing.add("createMultipartUpload");
    const refused = await uploadCall(env, key, "POST", JSON.stringify({ sha256: sha256("abc"), size: 3 }));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");

    bucket.failing.clear();

    const started = await (
      await uploadCall(env, key, "POST", JSON.stringify({ sha256: sha256("abc"), size: 3 }))
    ).json();

    bucket.failing.add("uploadPart");
    expect(
      (
        await uploadCall(
          env,
          `${key}?stagingKey=${encodeURIComponent(started.stagingKey)}&uploadId=${started.uploadId}&partNumber=1`,
          "PUT",
          "abc",
        )
      ).status,
    ).toBe(503);
  });
});

describe("manual manifest upload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A feed at 0.7.0 with the 0.8.0 installer already uploaded. */
  function published(): TestFeed {
    const setup = feed();
    setup.bucket.seed("PermitMonitorSetup-0.7.0.exe", "seven", INSTALLER_TYPE, sha256("seven"));
    setup.bucket.seed("PermitMonitor-0.7.0-mac-arm64.zip", "mac seven", "application/zip", sha256("mac seven"));
    setup.bucket.seed("PermitMonitor-0.8.0-mac-arm64.zip", "mac eight", "application/zip", sha256("mac eight"));
    setup.bucket.seed("PermitMonitorSetup-0.8.0.exe", "eight", INSTALLER_TYPE, sha256("eight"));
    setup.bucket.seed("release-manifest.json", manifest("0.7.0", "seven"), "application/json");

    return setup;
  }

  it("replaces the manifest with a newer version", async () => {
    const { bucket, env } = published();
    const response = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "0.8.0", status: "published" });
    expect(bucket.storedText("release-manifest.json")).toBe(manifest("0.8.0", "eight"));
  });

  it("keeps the known-good Mac download when the new release has no Mac archive", async () => {
    const { bucket, env } = published();
    await bucket.delete("PermitMonitor-0.8.0-mac-arm64.zip");
    const refused = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"));
    expect(refused.status).toBe(409);
    const redirect = await call(env, "/mac");
    expect(redirect.headers.get("location")).toBe(`${ORIGIN}/PermitMonitor-0.7.0-mac-arm64.zip`);
    expect((await call(env, "/PermitMonitor-0.7.0-mac-arm64.zip")).status).toBe(200);
    expect(bucket.storedText("release-manifest.json")).toBe(manifest("0.7.0", "seven"));
  });

  it("never moves the feed back to an older version", async () => {
    const { bucket, env } = published();
    await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"));
    const older = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.7.0", "seven"));
    expect(older.status).toBe(409);
    expect(bucket.storedText("release-manifest.json")).toBe(manifest("0.8.0", "eight"));
  });

  it("does not overwrite a manifest first published while this upload was in progress", async () => {
    const newer = manifest("0.9.0", "nine");

    class ManifestAppearsOnPut extends MemoryBucket {
      override async put(key: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions) {
        if (key === "release-manifest.json") this.seed(key, newer, "application/json");

        return super.put(key, value, options);
      }
    }

    const bucket = new ManifestAppearsOnPut();
    bucket.seed("PermitMonitorSetup-0.8.0.exe", "eight", INSTALLER_TYPE, sha256("eight"));
    bucket.seed("PermitMonitor-0.8.0-mac-arm64.zip", "mac eight", "application/zip", sha256("mac eight"));
    const { env } = feed(bucket);
    const response = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"));
    expect(response.status).toBe(409);
    expect(bucket.storedText("release-manifest.json")).toBe(newer);
  });

  it("accepts an identical retry and refuses a different manifest for the published version", async () => {
    const { bucket, env } = published();
    const retry = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.7.0", "seven"));
    expect(await retry.json()).toEqual({ version: "0.7.0", status: "unchanged" });

    const conflicting = await uploadCall(
      env,
      "release-manifest.json",
      "PUT",
      manifest("0.7.0", "seven", "Other Publisher"),
    );

    expect(conflicting.status).toBe(409);
    expect(bucket.storedText("release-manifest.json")).toBe(manifest("0.7.0", "seven"));
  });

  it("refuses a manifest whose installer is missing or has other bytes", async () => {
    const { env } = published();
    expect((await uploadCall(env, "release-manifest.json", "PUT", manifest("0.9.0", "nine"))).status).toBe(409);
    // Same size as the stored 0.8.0 installer, different hash.
    expect((await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "EIGHT"))).status).toBe(409);
  });

  it("matches installers stored without a recorded hash by size", async () => {
    const { bucket, env } = published();
    bucket.seed("PermitMonitorSetup-0.8.0.exe", "eight", INSTALLER_TYPE);
    expect((await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"))).status).toBe(200);
  });

  it("counts the size limit in bytes, not UTF-16 code units", async () => {
    const { env } = published();
    // 20,000 characters, 40,000 UTF-8 bytes: under the limit by string length, over it by bytes.
    const response = await uploadCall(env, "release-manifest.json", "PUT", "é".repeat(20_000));
    expect(response.status).toBe(413);
  });

  it("stops reading a streamed manifest once it passes the limit", async () => {
    const { env } = published();
    const state = { pulled: 0, cancelled: false };

    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(4_096));
      },
      cancel() {
        state.cancelled = true;
      },
    });

    // Node's fetch requires `duplex` for a streamed request body; the DOM typings don't declare it.
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: endless,
      duplex: "half",
    };

    const response = await worker.fetch(new Request(`${ORIGIN}/upload/release-manifest.json`, init), env);
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(20);
  });

  it("rejects a malformed manifest or installer URL with 400", async () => {
    const { env } = published();
    expect((await uploadCall(env, "release-manifest.json", "PUT", "{}")).status).toBe(400);
    expect(
      (await uploadCall(env, "release-manifest.json", "PUT", JSON.stringify({ signed: "!!", signature: "" }))).status,
    ).toBe(400);

    const signed = Buffer.from(
      JSON.stringify({
        version: "0.8.0",
        url: `${ORIGIN}/%E0%A4%A`,
        sha256: sha256("eight"),
        size: 5,
        publisher: "",
      }),
    ).toString("base64");

    expect(
      (await uploadCall(env, "release-manifest.json", "PUT", JSON.stringify({ signed, signature: signed }))).status,
    ).toBe(400);
  });

  it("leaves an unreadable published manifest for a person to replace", async () => {
    const { bucket, env } = published();
    bucket.seed("release-manifest.json", "corrupt", "application/json");
    expect((await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"))).status).toBe(500);
    expect(bucket.storedText("release-manifest.json")).toBe("corrupt");
  });

  it("answers a storage failure while publishing with a retryable 503", async () => {
    const { bucket, env } = published();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    bucket.failing.add("put");
    const response = await uploadCall(env, "release-manifest.json", "PUT", manifest("0.8.0", "eight"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(bucket.storedText("release-manifest.json")).toBe(manifest("0.7.0", "seven"));
  });
});
