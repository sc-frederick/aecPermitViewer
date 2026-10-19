import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import worker, { type FeedEnv } from "../infra/update-server/src/index.js";
import type { FeedPutOptions } from "../infra/update-server/src/bucket.js";
import { FileFeedBucket } from "./fixtures/file-feed-bucket.js";
import { LocalFixedLengthStream } from "./fixtures/fixed-length-stream.js";
import { MemoryBucket } from "./fixtures/memory-bucket.js";
import { fakeAwsEnvironment, FEED_BUCKET, installFakeAwsCli } from "./support/fake-aws-cli.js";
import { serveFetchHandler } from "./support/fetch-handler-server.js";
import { FEED_ORIGIN, releaseManifest, sha256 } from "./support/release-manifest.js";
import { temporaryDirectory } from "./support/temporary-directory.js";

Object.defineProperty(globalThis, "FixedLengthStream", { value: LocalFixedLengthStream, configurable: true });

const MANUAL = path.resolve("scripts/publish-update.mjs");

const CI = path.resolve("scripts/publish-feed.mjs");

const BRIDGE = path.resolve("tests/fixtures/manual-fetch-bridge.mjs");

const startSchema = z.object({ status: z.literal("created"), uploadId: z.string(), stagingKey: z.string() });

const partSchema = z.object({ partNumber: z.number().int().positive(), etag: z.string() });

function run(script: string, cwd: string, env: NodeJS.ProcessEnv, loader?: string) {
  return new Promise<{ readonly status: number | null; readonly output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(loader ? ["--import", pathToFileURL(loader).href] : []), script], {
      cwd,
      env,
    });

    let output = "";
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

describe("actual release publishers against local storage", () => {
  function workspace(body = "AAAA") {
    const root = temporaryDirectory("permit-monitor-manual-");
    const out = path.join(root, "work", "out", "make", "squirrel.windows", "x64");
    mkdirSync(out, { recursive: true });
    const macFile = path.join(root, "work", "out", "make", "PermitMonitor-mac-arm64.zip");
    writeFileSync(path.join(out, "PermitMonitorSetup.exe"), body);
    writeFileSync(path.join(out, "release-manifest.json"), releaseManifest("0.8.0", body));
    writeFileSync(macFile, "Mac archive");

    return { root, cwd: path.join(root, "work"), macFile, aws: installFakeAwsCli(root) };
  }

  async function serve(bucket: MemoryBucket) {
    const env: FeedEnv = { BUCKET: bucket, UPLOAD_TOKEN: "local-token" };
    const requests: string[] = [];

    const server = await serveFetchHandler((request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);

      return worker.fetch(request, env);
    }, FEED_ORIGIN);

    return { env, requests, failures: server.failures, origin: server.origin };
  }

  function manualEnv(origin: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      UPDATE_SERVER_URL: FEED_ORIGIN,
      UPDATE_UPLOAD_TOKEN: "local-token",
      FAKE_UPDATE_ORIGIN: origin,
    };
  }

  it("publishes both platforms through the actual manual script and safely retries", async () => {
    const work = workspace();
    const bucket = new MemoryBucket();
    const local = await serve(bucket);
    const result = await run(MANUAL, work.cwd, manualEnv(local.origin), BRIDGE);
    expect(result.status, result.output).toBe(0);
    expect(bucket.storedText("PermitMonitorSetup-0.8.0.exe")).toBe("AAAA");
    expect(bucket.storedText("PermitMonitor-0.8.0-mac-arm64.zip")).toBe("Mac archive");
    expect(bucket.storedText("release-manifest.json")).toBe(releaseManifest("0.8.0", "AAAA"));
    const rerun = await run(MANUAL, work.cwd, manualEnv(local.origin), BRIDGE);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("skipped");
    expect(bucket.openUploads).toBe(0);
    expect(local.failures).toEqual([]);
  });

  it.each([MANUAL, CI])("refuses a missing local Mac archive before uploading anything (%s)", async (script) => {
    const work = workspace();
    unlinkSync(work.macFile);
    const bucket = new MemoryBucket();
    const local = await serve(bucket);

    const result = await run(
      script,
      work.cwd,
      { ...manualEnv(local.origin), R2_ENDPOINT: "https://r2.example.test" },
      script === MANUAL ? BRIDGE : undefined,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("matching Mac archive is missing");
    expect(local.requests).toEqual([]);
    expect(bucket.storedText("release-manifest.json")).toBeNull();
  });

  it("keeps the old manifest and downloadable Mac when the manual Mac artifact conflicts", async () => {
    const work = workspace();
    const bucket = new MemoryBucket();
    bucket.seed("release-manifest.json", releaseManifest("0.7.0", "old"), "application/json");
    bucket.seed("PermitMonitor-0.7.0-mac-arm64.zip", "old Mac", "application/zip", sha256("old Mac"));
    bucket.seed("PermitMonitor-0.8.0-mac-arm64.zip", "other Mac", "application/zip", sha256("other Mac"));
    const local = await serve(bucket);
    const result = await run(MANUAL, work.cwd, manualEnv(local.origin), BRIDGE);
    expect(result.status).not.toBe(0);
    expect(bucket.storedText("release-manifest.json")).toBe(releaseManifest("0.7.0", "old"));
    const redirect = await worker.fetch(new Request(`${FEED_ORIGIN}/mac`), local.env);
    expect(redirect.headers.get("location")).toBe(`${FEED_ORIGIN}/PermitMonitor-0.7.0-mac-arm64.zip`);
    expect(
      (await worker.fetch(new Request(`${FEED_ORIGIN}/PermitMonitor-0.7.0-mac-arm64.zip`), local.env)).status,
    ).toBe(200);
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "arbitrates actual CI/manual publishers at a barrier (identical=%s)",
    async (identical) => {
      const work = workspace();
      const bucket = new FileFeedBucket(path.join(work.aws.store, FEED_BUCKET));
      const local = await serve(bucket);
      const gate = path.join(work.root, "gate");

      const publishing = run(CI, work.cwd, { ...fakeAwsEnvironment(work.aws), FAKE_AWS_GATE_DIR: gate });

      const deadline = Date.now() + 8_000;

      while (!existsSync(path.join(gate, "ready"))) {
        if (Date.now() >= deadline) throw new Error("CI publisher never reached its conditional artifact write");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const winner = identical ? "AAAA" : "BBBB";
      const claim = { sha256: sha256(winner), size: 4 };

      const response = await worker.fetch(
        new Request(`${FEED_ORIGIN}/upload/PermitMonitorSetup-0.8.0.exe`, {
          method: "POST",
          headers: { authorization: "Bearer local-token" },
          body: JSON.stringify(claim),
        }),
        local.env,
      );

      const start = startSchema.parse(await response.json());
      const session = new URLSearchParams({ uploadId: start.uploadId, stagingKey: start.stagingKey });
      const url = `${FEED_ORIGIN}/upload/PermitMonitorSetup-0.8.0.exe?${session}`;

      const part = partSchema.parse(
        await (
          await worker.fetch(
            new Request(`${url}&partNumber=1`, {
              method: "PUT",
              headers: { authorization: "Bearer local-token" },
              body: winner,
            }),
            local.env,
          )
        ).json(),
      );

      expect(
        (
          await worker.fetch(
            new Request(url, {
              method: "POST",
              headers: { authorization: "Bearer local-token" },
              body: JSON.stringify({ ...claim, parts: [part] }),
            }),
            local.env,
          )
        ).status,
      ).toBe(200);
      writeFileSync(path.join(gate, "continue"), "continue");
      const result = await publishing;
      expect(result.status, result.output).toBe(identical ? 0 : 1);
      expect(readFileSync(path.join(work.aws.store, FEED_BUCKET, "PermitMonitorSetup-0.8.0.exe"), "utf8")).toBe(winner);

      if (identical)
        expect(readFileSync(path.join(work.aws.store, FEED_BUCKET, "release-manifest.json"), "utf8")).toBe(
          releaseManifest("0.8.0", winner),
        );
      else expect(existsSync(path.join(work.aws.store, FEED_BUCKET, "release-manifest.json"))).toBe(false);
      expect(local.failures).toEqual([]);
    },
    20_000,
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "preserves a CI winner while the actual manual publisher is paused (identical=%s)",
    async (identical) => {
      const ciWork = workspace("AAAA");
      const manualWork = workspace(identical ? "AAAA" : "BBBB");
      let reached: () => void = () => {};

      let release: () => void = () => {};

      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });

      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      class PausedWorkerBucket extends FileFeedBucket {
        override async put(key: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions) {
          if (key.endsWith(".exe")) {
            reached();
            await barrier;
          }

          return super.put(key, value, options);
        }
      }

      const bucket = new PausedWorkerBucket(path.join(ciWork.aws.store, FEED_BUCKET));
      const local = await serve(bucket);
      const manual = run(MANUAL, manualWork.cwd, manualEnv(local.origin), BRIDGE);
      await ready;

      const ci = await run(CI, ciWork.cwd, fakeAwsEnvironment(ciWork.aws));

      expect(ci.status, ci.output).toBe(0);
      release();
      const result = await manual;
      expect(result.status, result.output).toBe(identical ? 0 : 1);
      expect(readFileSync(path.join(ciWork.aws.store, FEED_BUCKET, "PermitMonitorSetup-0.8.0.exe"), "utf8")).toBe(
        "AAAA",
      );
      expect(readFileSync(path.join(ciWork.aws.store, FEED_BUCKET, "release-manifest.json"), "utf8")).toBe(
        releaseManifest("0.8.0", "AAAA"),
      );
      expect(local.failures).toEqual([]);
    },
    20_000,
  );
});
