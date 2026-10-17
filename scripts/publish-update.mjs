import { open } from "node:fs/promises";
import { z } from "zod";
import { parseManifest } from "../infra/update-server/src/manifest.ts";
import { decideManifestReplacement } from "../infra/update-server/src/release-policy.ts";
import { installerPath, macZipPath, readLocalMac, readLocalRelease } from "./release-feed.mjs";

// Manual publishing path: uploads both platform artifacts and then the signed manifest through the update
// server Worker (infra/update-server). Run after sign-release-manifest.mjs, from a network that
// Cloudflare doesn't challenge (GitHub's runners are challenged; CI writes to R2 directly with
// publish-feed.mjs). The Worker refuses different bytes for a published artifact and a manifest
// that isn't newer than the live one; this script checks the manifest rule first so it doesn't
// upload ~280 MB only to be refused.
const server = process.env.UPDATE_SERVER_URL;

const token = process.env.UPDATE_UPLOAD_TOKEN;

if (!server || !token || new URL(server).protocol !== "https:")
  throw new Error("Update upload configuration is incomplete.");

const PART_BYTES = 64 * 1024 * 1024;

const auth = { authorization: `Bearer ${token}` };

const startSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("published") }),
  z.object({ status: z.literal("created"), uploadId: z.string().min(1), stagingKey: z.string().min(1) }),
]);

const partSchema = z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) });

const publishedSchema = z.object({ status: z.enum(["published", "unchanged"]) });

async function call(method, pathname, body, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const init = { method, headers: auth };

      if (body !== undefined) init.body = body;
      const response = await fetch(new URL(pathname, server), init);

      if (response.ok) return response;
      const message = `${method} ${pathname} failed: ${response.status} ${await response.text()}`;

      if (response.status < 500 || attempt >= attempts) throw Object.assign(new Error(message), { final: true });
      process.stdout.write(`${message}; retrying\n`);
    } catch (cause) {
      if (cause.final || attempt >= attempts) throw cause;
      process.stdout.write(`${method} ${pathname} errored: ${cause.message}; retrying\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
}

const release = await readLocalRelease();

const mac = await readLocalMac(release.payload.version.text);

const { key } = release;

const version = release.payload.version.text;

const live = await fetch(new URL("/release-manifest.json", server), { cache: "no-store" });

if (live.status !== 404) {
  if (!live.ok) throw new Error(`Reading the live manifest failed: ${live.status}`);
  const text = await live.text();
  const payload = parseManifest(text);

  if (!payload) throw new Error("The live manifest is unreadable; inspect the feed before publishing.");

  const decision = decideManifestReplacement(
    { version: payload.version, text },
    { version: release.payload.version, text: release.text },
  );

  if (decision._tag === "stale")
    throw new Error(`The feed already offers ${decision.published}, which is newer than ${version}.`);

  if (decision._tag === "conflict")
    throw new Error(`A different ${version} manifest is already published. Release a new version instead.`);
}

/** Uploads one artifact into private staging, then asks storage to publish its bytes conditionally. */
async function publishArtifact(filePath, key, claim) {
  const start = startSchema.parse(await (await call("POST", `/upload/${key}`, JSON.stringify(claim))).json());

  if (start.status === "published") {
    process.stdout.write(`${key} is already published with these bytes; skipped.\n`);
  } else {
    const { uploadId, stagingKey } = start;
    const session = new URLSearchParams({ uploadId, stagingKey }).toString();
    const file = await open(filePath, "r");
    const parts = [];

    try {
      const { size } = await file.stat();

      for (let offset = 0, partNumber = 1; offset < size; offset += PART_BYTES, partNumber += 1) {
        const chunk = Buffer.alloc(Math.min(PART_BYTES, size - offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);

        if (bytesRead !== chunk.length) throw new Error("Short read from release artifact");
        const query = `${session}&partNumber=${partNumber}`;
        parts.push(partSchema.parse(await (await call("PUT", `/upload/${key}?${query}`, chunk)).json()));
        process.stdout.write(
          `Uploaded part ${partNumber} (${Math.min(offset + chunk.length, size)} of ${size} bytes).\n`,
        );
      }

      await call("POST", `/upload/${key}?${session}`, JSON.stringify({ ...claim, parts }));
    } catch (cause) {
      await call("DELETE", `/upload/${key}?${session}`, undefined, 1).catch(() => {});
      throw cause;
    } finally {
      await file.close();
    }
  }
}

await publishArtifact(installerPath, key, { sha256: release.payload.sha256, size: release.payload.size });

await publishArtifact(macZipPath, mac.key, { sha256: mac.sha256, size: mac.size });

const published = publishedSchema.parse(
  await (await call("PUT", "/upload/release-manifest.json", release.text)).json(),
);

const current = await (await fetch(new URL("/release-manifest.json", server), { cache: "no-store" })).text();

if (current !== release.text) throw new Error("Published manifest does not match the signed manifest.");

process.stdout.write(
  `${published.status === "unchanged" ? "Already published" : "Published"} ${version} at ${new URL(`/${key}`, server)}.\n`,
);
