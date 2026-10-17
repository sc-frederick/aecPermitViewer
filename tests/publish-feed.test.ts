import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAwsEnvironment, FEED_BUCKET, installFakeAwsCli } from "./support/fake-aws-cli.js";
import { releaseManifest, sha256 } from "./support/release-manifest.js";
import { temporaryDirectory } from "./support/temporary-directory.js";

const SCRIPT = path.resolve("scripts/publish-feed.mjs");

// The release job runs on Linux, and the fake CLI is reached through a shell wrapper on PATH.
describe.skipIf(process.platform === "win32")("CI publication to R2", () => {
  /** A release job workspace, a fake bucket, and an `aws` on PATH that writes to it. */
  function workspace() {
    const root = temporaryDirectory("permit-monitor-feed-");
    const aws = installFakeAwsCli(root);
    const bucket = path.join(aws.store, FEED_BUCKET);
    const out = path.join(root, "work", "out", "make", "squirrel.windows", "x64");
    mkdirSync(out, { recursive: true });

    return {
      /** Writes a signed installer, its manifest, and a placeholder Mac zip to the job's output directory. */
      build(version: string, installer: string): void {
        writeFileSync(path.join(out, "PermitMonitorSetup.exe"), installer);
        writeFileSync(path.join(out, "release-manifest.json"), releaseManifest(version, installer));
        writeFileSync(path.join(root, "work", "out", "make", "PermitMonitor-mac-arm64.zip"), `mac ${version}`);
      },
      /** Replaces the Mac zip with the bytes the macOS job would build. */
      buildMac(zip: string): void {
        writeFileSync(path.join(root, "work", "out", "make", "PermitMonitor-mac-arm64.zip"), zip);
      },
      /** Swaps the built installer after signing, leaving the manifest describing the original bytes. */
      replaceInstaller(installer: string): void {
        writeFileSync(path.join(out, "PermitMonitorSetup.exe"), installer);
      },
      /** Stores an object as an earlier release left it; omit `sha256` to model one stored without a recorded hash. */
      seed(key: string, body: string, metadata: { sha256?: string } = {}): void {
        writeFileSync(path.join(bucket, key), body);
        writeFileSync(
          path.join(bucket, `${key}.meta.json`),
          JSON.stringify({ contentType: "application/octet-stream", metadata }),
        );
      },
      stored(key: string): string | null {
        const file = path.join(bucket, key);

        return existsSync(file) ? readFileSync(file, "utf8") : null;
      },
      recordedSha256(key: string): string | undefined {
        return JSON.parse(readFileSync(path.join(bucket, `${key}.meta.json`), "utf8")).metadata.sha256;
      },
      writes(): string[] {
        const log = path.join(aws.store, "writes.log");

        return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      },
      publish(fail?: string, racedManifest?: string) {
        const env = fakeAwsEnvironment(aws);

        if (fail) env.FAKE_AWS_FAIL = fail;

        if (racedManifest) {
          const file = path.join(root, "raced-manifest.json");
          writeFileSync(file, racedManifest);
          env.FAKE_AWS_RACE_MANIFEST = file;
        }

        const result = spawnSync(process.execPath, [SCRIPT], { cwd: path.join(root, "work"), env, encoding: "utf8" });

        return { status: result.status, output: `${result.stdout}${result.stderr}` };
      },
    };
  }

  it("uploads the installer with its hash, then the manifest", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    const result = feed.publish();
    expect(result.status, result.output).toBe(0);
    expect(feed.stored("PermitMonitorSetup-0.8.0.exe")).toBe("eight");
    expect(feed.recordedSha256("PermitMonitorSetup-0.8.0.exe")).toBe(sha256("eight"));
    expect(feed.stored("release-manifest.json")).toBe(releaseManifest("0.8.0", "eight"));
    expect(feed.writes()).toEqual([
      `${FEED_BUCKET}/PermitMonitorSetup-0.8.0.exe`,
      `${FEED_BUCKET}/PermitMonitor-0.8.0-mac-arm64.zip`,
      `${FEED_BUCKET}/release-manifest.json`,
    ]);
  });

  it("uploads the Mac zip before the manifest and never replaces it with other bytes", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    feed.buildMac("mac eight");
    const result = feed.publish();
    expect(result.status, result.output).toBe(0);
    expect(feed.stored("PermitMonitor-0.8.0-mac-arm64.zip")).toBe("mac eight");
    expect(feed.recordedSha256("PermitMonitor-0.8.0-mac-arm64.zip")).toBe(sha256("mac eight"));
    expect(feed.writes()).toEqual([
      `${FEED_BUCKET}/PermitMonitorSetup-0.8.0.exe`,
      `${FEED_BUCKET}/PermitMonitor-0.8.0-mac-arm64.zip`,
      `${FEED_BUCKET}/release-manifest.json`,
    ]);

    feed.buildMac("MAC EIGHT");
    const rebuilt = feed.publish();
    expect(rebuilt.status).not.toBe(0);
    expect(rebuilt.output).toContain("already published with different bytes");
    expect(feed.stored("PermitMonitor-0.8.0-mac-arm64.zip")).toBe("mac eight");
  });

  it("skips every write when an identical release is rerun", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    feed.publish();
    const rerun = feed.publish();
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("skipped");
    expect(feed.writes()).toHaveLength(3);
  });

  it("fails without writing when a rebuilt installer differs from the published one", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    feed.publish();
    feed.build("0.8.0", "EIGHT");
    const rerun = feed.publish();
    expect(rerun.status).not.toBe(0);
    expect(rerun.output).toContain("already published with different bytes");
    expect(feed.stored("PermitMonitorSetup-0.8.0.exe")).toBe("eight");
    expect(feed.stored("release-manifest.json")).toBe(releaseManifest("0.8.0", "eight"));
  });

  it("keeps the newer manifest when an older release finishes last", () => {
    const feed = workspace();
    feed.build("0.9.0", "nine");
    feed.publish();
    feed.build("0.8.0", "eight");
    const older = feed.publish();
    expect(older.status, older.output).toBe(0);
    expect(older.output).toContain("::warning::");
    expect(feed.stored("PermitMonitorSetup-0.8.0.exe")).toBe("eight");
    expect(feed.stored("release-manifest.json")).toBe(releaseManifest("0.9.0", "nine"));
  });

  it("does not replace a newer manifest first published during the final upload", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    const newer = releaseManifest("0.9.0", "nine");
    const result = feed.publish(undefined, newer);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("PreconditionFailed");
    expect(feed.stored("release-manifest.json")).toBe(newer);
  });

  it("does not replace a manifest that changed after its etag was read", () => {
    const feed = workspace();
    feed.seed("release-manifest.json", releaseManifest("0.7.0", "seven"));
    feed.build("0.8.0", "eight");
    const newer = releaseManifest("0.9.0", "nine");
    const result = feed.publish(undefined, newer);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("PreconditionFailed");
    expect(feed.stored("release-manifest.json")).toBe(newer);
  });

  it("orders versions numerically", () => {
    const feed = workspace();
    feed.build("0.9.0", "nine");
    feed.publish();
    feed.build("0.10.0", "ten");
    expect(feed.publish().status).toBe(0);
    expect(feed.stored("release-manifest.json")).toBe(releaseManifest("0.10.0", "ten"));
  });

  it("hashes an installer stored without a recorded hash before accepting it as identical", () => {
    const feed = workspace();
    feed.seed("PermitMonitorSetup-0.7.0.exe", "seven");
    feed.build("0.7.0", "seven");
    const identical = feed.publish();
    expect(identical.status, identical.output).toBe(0);
    expect(feed.writes()).toEqual([
      `${FEED_BUCKET}/PermitMonitor-0.7.0-mac-arm64.zip`,
      `${FEED_BUCKET}/release-manifest.json`,
    ]);

    const other = workspace();
    other.seed("PermitMonitorSetup-0.7.0.exe", "SEVEN");
    other.build("0.7.0", "seven");
    expect(other.publish().status).not.toBe(0);
    expect(other.stored("PermitMonitorSetup-0.7.0.exe")).toBe("SEVEN");
  });

  it("fails without writing when the bucket can't be read", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    const result = feed.publish("head-object");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("InternalError");
    expect(feed.writes()).toEqual([]);
  });

  it("refuses an installer that doesn't match its signed manifest", () => {
    const feed = workspace();
    feed.build("0.8.0", "eight");
    feed.replaceInstaller("EIGHT");
    const result = feed.publish();
    expect(result.status).not.toBe(0);
    expect(feed.writes()).toEqual([]);
  });
});
