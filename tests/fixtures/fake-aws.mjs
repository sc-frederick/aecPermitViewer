import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Stands in for the AWS CLI in tests of scripts/publish-feed.mjs, supporting only the commands that script
// runs. Objects live under FAKE_AWS_ROOT as <bucket>/<key>, each with a <key>.meta.json sidecar, and every
// write is appended to FAKE_AWS_ROOT/writes.log. FAKE_AWS_FAIL names a subcommand that fails like an outage.

const root = process.env.FAKE_AWS_ROOT ?? "";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}

function objectFile(url) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(url);

  if (!match) throw new Error(`not an S3 URL: ${url}`);

  return path.join(root, match[1] ?? "", match[2] ?? "");
}

function exit(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function requireObject(file) {
  if (!existsSync(file)) exit("An error occurred (404) when calling the HeadObject operation: Not Found", 254);
}

function etag(file) {
  return `"${createHash("md5").update(readFileSync(file)).digest("hex")}"`;
}

if (process.env.FAKE_AWS_FAIL === args[1]) exit("An error occurred (InternalError) when calling the operation: We encountered an internal error.", 255);

if (args[0] === "s3api" && args[1] === "head-object") {
  const file = path.join(root, option("--bucket") ?? "", option("--key") ?? "");
  requireObject(file);
  const meta = JSON.parse(readFileSync(`${file}.meta.json`, "utf8"));
  process.stdout.write(JSON.stringify({ ContentLength: statSync(file).size, ContentType: meta.contentType,
    Metadata: meta.metadata, ETag: etag(file) }));
} else if (args[0] === "s3api" && args[1] === "put-object") {
  const key = option("--key") ?? "";
  const file = path.join(root, option("--bucket") ?? "", key);
  const raced = process.env.FAKE_AWS_RACE_MANIFEST;
  mkdirSync(path.dirname(file), { recursive: true });

  if (key === "release-manifest.json" && raced) {
    copyFileSync(raced, file);
    writeFileSync(`${file}.meta.json`, JSON.stringify({ contentType: "application/json", metadata: {} }));
  }

  if ((option("--if-none-match") === "*" && existsSync(file)) ||
    (option("--if-match") && (!existsSync(file) || etag(file) !== option("--if-match")))) {
    exit("An error occurred (PreconditionFailed) when calling the PutObject operation: 412", 254);
  }

  copyFileSync(option("--body") ?? "", file);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ contentType: option("--content-type"), metadata: {} }));
  appendFileSync(path.join(root, "writes.log"), `${path.relative(root, file)}\n`);
} else if (args[0] === "s3" && args[1] === "cp" && args[3] === "-") {
  const file = objectFile(args[2] ?? "");
  requireObject(file);
  createReadStream(file).pipe(process.stdout);
} else if (args[0] === "s3" && args[1] === "cp") {
  const file = objectFile(args[3] ?? "");
  const metadata = {};

  for (const pair of (option("--metadata") ?? "").split(",")) {
    const [name, value] = pair.split("=");

    if (name && value !== undefined) metadata[name] = value;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  copyFileSync(args[2] ?? "", file);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ contentType: option("--content-type"), metadata }));
  appendFileSync(path.join(root, "writes.log"), `${path.relative(root, file)}\n`);
} else {
  exit(`fake aws: unsupported command ${args.join(" ")}`, 2);
}
