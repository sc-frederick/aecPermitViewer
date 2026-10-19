import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { jsonText, parseManifest, sha256Hex } from "../infra/update-server/src/manifest.ts";
import { decideInstallerUpload, decideManifestReplacement } from "../infra/update-server/src/release-policy.ts";
import { createReadStream } from "node:fs";
import { installerPath, macZipPath, manifestPath, readLocalMac, readLocalRelease } from "./release-feed.mjs";

const endpoint = process.env.R2_ENDPOINT;

const bucket = process.env.R2_BUCKET ?? "permitmon-updates";

if (!endpoint) throw new Error("R2_ENDPOINT is not set.");

const MANIFEST = "release-manifest.json";

const INSTALLER_TYPE = "application/vnd.microsoft.portable-executable";

const ZIP_TYPE = "application/zip";

const NOT_FOUND = /\(404\)|NoSuchKey|Not Found/;

const headText = jsonText.pipe(
  z.object({
    ContentLength: z.number().int().nonnegative(),
    ETag: z.string().min(1),
    Metadata: z.object({ sha256: z.string().optional() }).optional(),
  }),
);

function aws(args, sink) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", [...args, "--endpoint-url", endpoint], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => (sink ? sink(chunk) : stdout.push(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);

    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function failure(action, result) {
  return new Error(`${action} failed (exit ${result.code}): ${result.stderr.trim()}`);
}

async function headInstaller(key) {
  const result = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"]);

  if (result.code !== 0) {
    if (NOT_FOUND.test(result.stderr)) return null;

    throw failure(`HEAD ${key}`, result);
  }

  const head = headText.parse(result.stdout);
  const recorded = head.Metadata?.sha256;

  return {
    size: head.ContentLength,
    sha256: recorded !== undefined && sha256Hex.safeParse(recorded).success ? recorded : null,
  };
}

async function hashStored(key) {
  const hash = createHash("sha256");

  const result = await aws(["s3", "cp", `s3://${bucket}/${key}`, "-", "--only-show-errors"], (chunk) =>
    hash.update(chunk),
  );

  if (result.code !== 0) throw failure(`Download ${key}`, result);

  return hash.digest("hex");
}

async function decideStored(key, claim) {
  const decision = decideInstallerUpload(await headInstaller(key), claim);

  if (decision._tag !== "unverified") return decision;
  process.stdout.write(`${key} is stored without a recorded hash; hashing the stored copy.\n`);

  return decideInstallerUpload({ size: claim.size, sha256: await hashStored(key) }, claim);
}

async function publishedManifest() {
  const headResult = await aws(["s3api", "head-object", "--bucket", bucket, "--key", MANIFEST, "--output", "json"]);

  if (headResult.code !== 0) {
    if (NOT_FOUND.test(headResult.stderr)) return null;

    throw failure(`HEAD ${MANIFEST}`, headResult);
  }

  const etag = headText.parse(headResult.stdout).ETag;
  const result = await aws(["s3", "cp", `s3://${bucket}/${MANIFEST}`, "-", "--only-show-errors"]);

  if (result.code !== 0) throw failure(`Download ${MANIFEST}`, result);

  const payload = parseManifest(result.stdout);

  if (!payload) throw new Error(`The published ${MANIFEST} is unreadable; inspect the feed and replace it by hand.`);

  return { version: payload.version, text: result.stdout, etag };
}

async function uploadManifest(etag) {
  const condition = etag ? ["--if-match", etag] : ["--if-none-match", "*"];

  const result = await aws([
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    MANIFEST,
    "--body",
    manifestPath,
    "--content-type",
    "application/json",
    ...condition,
  ]);

  if (result.code !== 0) throw failure(`Upload ${MANIFEST}`, result);
}

async function publishOnce(file, key, contentType, claim) {
  const decision = await decideStored(key, claim);

  if (decision._tag === "conflict") {
    throw new Error(
      `${key} is already published with different bytes (${decision.reason}). Release a new version instead.`,
    );
  }

  if (decision._tag === "already_published") {
    process.stdout.write(`${key} is already published with these bytes; skipped.\n`);

    return;
  }

  // R2 checks `--if-none-match` when the bytes commit, so it also holds against a concurrent Worker upload. The S3
  // API verifies integrity through Content-MD5; the Workers binding verifies the claimed SHA-256 as well.
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");

  for await (const chunk of createReadStream(file)) {
    md5.update(chunk);
    sha256.update(chunk);
  }

  if (sha256.digest("hex") !== claim.sha256)
    throw new Error(`${key} changed after validation; rebuild and sign the release again.`);

  const result = await aws([
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    file,
    "--content-type",
    contentType,
    "--metadata",
    `sha256=${claim.sha256}`,
    "--content-md5",
    md5.digest("base64"),
    "--if-none-match",
    "*",
  ]);

  if (result.code !== 0) {
    if (!/PreconditionFailed|ConditionalRequestConflict|\b412\b|\b409\b/.test(result.stderr))
      throw failure(`Upload ${key}`, result);
    const winner = await decideStored(key, claim);

    if (winner._tag !== "already_published")
      throw new Error(`${key} is already published with different bytes; release a new version instead.`);
    process.stdout.write(`${key} was published concurrently with these bytes; skipped.\n`);

    return;
  }

  const stored = await headInstaller(key);

  if (!stored || stored.size !== claim.size || stored.sha256 !== claim.sha256)
    throw new Error(`Uploaded ${key} does not match the local file.`);
  process.stdout.write(`Uploaded ${key}.\n`);
}

const release = await readLocalRelease();

const mac = await readLocalMac(release.payload.version.text);

await publishOnce(installerPath, release.key, INSTALLER_TYPE, {
  size: release.payload.size,
  sha256: release.payload.sha256,
});

await publishOnce(macZipPath, mac.key, ZIP_TYPE, mac);

const published = await publishedManifest();

const manifest = decideManifestReplacement(published, { version: release.payload.version, text: release.text });

if (manifest._tag === "conflict") {
  throw new Error(
    `A different manifest for ${manifest.published} is already published. Release a new version instead.`,
  );
}

if (manifest._tag === "stale") {
  process.stdout.write(
    `::warning::The feed already offers ${manifest.published}; left it in place instead of moving back to ${release.payload.version.text}.\n`,
  );
} else if (manifest._tag === "unchanged") {
  process.stdout.write(`The feed already offers this ${release.payload.version.text} manifest; skipped.\n`);
} else {
  await uploadManifest(published?.etag);
  process.stdout.write(`Published ${release.payload.version.text} to the update feed.\n`);
}
