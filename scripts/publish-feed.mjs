import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { jsonText, parseManifest, sha256Hex } from "../infra/update-server/src/manifest.ts";
import { decideInstallerUpload, decideManifestReplacement } from "../infra/update-server/src/release-policy.ts";
import { installerPath, manifestPath, readLocalRelease } from "./release-feed.mjs";

// CI publishing path (.github/workflows/windows.yml). Cloudflare challenges GitHub's runners on the Worker
// hosts, so this writes to R2's S3 endpoint with the AWS CLI. It applies the Worker's upload rules: a
// versioned installer is written once (an identical rerun is skipped, different bytes fail the job), and the
// manifest only moves to a newer version. The workflow serializes CI releases, and the manifest's final
// conditional write refuses a concurrent change through the manual publisher.

const endpoint = process.env.R2_ENDPOINT;

const bucket = process.env.R2_BUCKET ?? "permitmon-updates";

if (!endpoint) throw new Error("R2_ENDPOINT is not set.");

const MANIFEST = "release-manifest.json";

const INSTALLER_TYPE = "application/vnd.microsoft.portable-executable";

const NOT_FOUND = /\(404\)|NoSuchKey|Not Found/;

const headText = jsonText.pipe(z.object({
  ContentLength: z.number().int().nonnegative(),
  ETag: z.string().min(1),
  Metadata: z.object({ sha256: z.string().optional() }).optional(),
}));

/**
 * Runs the AWS CLI against the R2 endpoint and resolves with its exit code and output. Rejects only when the
 * CLI can't be started. With `sink`, stdout goes there instead of being buffered.
 */
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

/** The stored installer's size and recorded hash, or null when the key is absent. */
async function headInstaller(key) {
  const result = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"]);

  if (result.code !== 0) {
    if (NOT_FOUND.test(result.stderr)) return null;

    throw failure(`HEAD ${key}`, result);
  }

  const head = headText.parse(result.stdout);
  const recorded = head.Metadata?.sha256;

  return { size: head.ContentLength, sha256: recorded !== undefined && sha256Hex.safeParse(recorded).success ? recorded : null };
}

/** Hashes a stored object by streaming it through the CLI. Only needed for installers stored before hashes were recorded. */
async function hashStored(key) {
  const hash = createHash("sha256");
  const result = await aws(["s3", "cp", `s3://${bucket}/${key}`, "-", "--only-show-errors"], (chunk) => hash.update(chunk));

  if (result.code !== 0) throw failure(`Download ${key}`, result);

  return hash.digest("hex");
}

/** The published manifest and its version, or null before the first release. */
async function publishedManifest() {
  // Read the etag before the body: if the object changes during either read, the conditional write fails closed.
  const headResult = await aws(["s3api", "head-object", "--bucket", bucket, "--key", MANIFEST, "--output", "json"]);

  if (headResult.code !== 0) {
    if (NOT_FOUND.test(headResult.stderr)) return null;

    throw failure(`HEAD ${MANIFEST}`, headResult);
  }

  const etag = headText.parse(headResult.stdout).ETag;
  const result = await aws(["s3", "cp", `s3://${bucket}/${MANIFEST}`, "-", "--only-show-errors"]);

  if (result.code !== 0) throw failure(`Download ${MANIFEST}`, result);

  const payload = parseManifest(result.stdout);

  // Replacing an unreadable manifest would bypass the version rule, so that is left to a person.
  if (!payload) throw new Error(`The published ${MANIFEST} is unreadable; inspect the feed and replace it by hand.`);

  return { version: payload.version, text: result.stdout, etag };
}

/** Writes the manifest only if the version decision still applies to the same published object. */
async function uploadManifest(etag) {
  const condition = etag ? ["--if-match", etag] : ["--if-none-match", "*"];

  const result = await aws(["s3api", "put-object", "--bucket", bucket, "--key", MANIFEST,
    "--body", manifestPath, "--content-type", "application/json", ...condition]);

  if (result.code !== 0) throw failure(`Upload ${MANIFEST}`, result);
}

async function upload(file, key, contentType, extra) {
  const result = await aws(["s3", "cp", file, `s3://${bucket}/${key}`, "--content-type", contentType, "--only-show-errors", ...extra]);

  if (result.code !== 0) throw failure(`Upload ${key}`, result);
}

const release = await readLocalRelease();

const claim = { size: release.payload.size, sha256: release.payload.sha256 };

let installer = decideInstallerUpload(await headInstaller(release.key), claim);

if (installer._tag === "unverified") {
  process.stdout.write(`${release.key} is stored without a recorded hash; hashing the stored copy.\n`);
  installer = decideInstallerUpload({ size: claim.size, sha256: await hashStored(release.key) }, claim);
}

if (installer._tag === "conflict") {
  throw new Error(`${release.key} is already published with different bytes (${installer.reason}). Release a new version instead.`);
}

if (installer._tag === "upload") {
  await upload(installerPath, release.key, INSTALLER_TYPE, ["--metadata", `sha256=${claim.sha256}`]);
  const stored = await headInstaller(release.key);

  if (!stored || stored.size !== claim.size || stored.sha256 !== claim.sha256) throw new Error(`Uploaded ${release.key} does not match the local installer.`);
  process.stdout.write(`Uploaded ${release.key}.\n`);
} else {
  process.stdout.write(`${release.key} is already published with these bytes; skipped.\n`);
}

const published = await publishedManifest();

const manifest = decideManifestReplacement(published, { version: release.payload.version, text: release.text });

if (manifest._tag === "conflict") {
  throw new Error(`A different manifest for ${manifest.published} is already published. Release a new version instead.`);
}

if (manifest._tag === "stale") {
  process.stdout.write(`::warning::The feed already offers ${manifest.published}; left it in place instead of moving back to ${release.payload.version.text}.\n`);
} else if (manifest._tag === "unchanged") {
  process.stdout.write(`The feed already offers this ${release.payload.version.text} manifest; skipped.\n`);
} else {
  await uploadManifest(published?.etag);
  process.stdout.write(`Published ${release.payload.version.text} to the update feed.\n`);
}
