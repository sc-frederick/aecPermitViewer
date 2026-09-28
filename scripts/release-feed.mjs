import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseManifest } from "../infra/update-server/src/manifest.ts";

// The local release that both publication scripts upload: the installer built by make:win and the manifest
// written by sign-release-manifest.mjs. The feed's rules live in infra/update-server/src/release-policy.ts.

/** The installer the release job or a person publishes. */
export const installerPath = path.resolve("out/make/squirrel.windows/x64/PermitMonitorSetup.exe");

/** The signed manifest describing `installerPath`. */
export const manifestPath = path.resolve("out/make/squirrel.windows/x64/release-manifest.json");

/** Hex SHA-256 of a file, read as a stream so an ~800 MB installer isn't held in memory. */
export async function sha256File(file) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  return hash.digest("hex");
}

/**
 * Reads the signed manifest and checks that it names the versioned installer key and describes the local
 * installer's exact bytes. Returns `{ text, payload, key }`; throws when the files disagree, since publishing
 * them would give clients an installer that fails verification.
 */
export async function readLocalRelease() {
  const text = await readFile(manifestPath, "utf8");
  const payload = parseManifest(text);

  if (!payload) throw new Error(`${manifestPath} is malformed; run scripts/sign-release-manifest.mjs again.`);
  const key = `PermitMonitorSetup-${payload.version.text}.exe`;

  if (new URL(payload.url).pathname !== `/${key}`) throw new Error(`The signed manifest points at ${payload.url}, not ${key}.`);
  const { size } = await stat(installerPath);

  if (size !== payload.size || (await sha256File(installerPath)) !== payload.sha256) {
    throw new Error("The local installer does not match the signed manifest; sign it again.");
  }

  return { text, payload, key };
}
