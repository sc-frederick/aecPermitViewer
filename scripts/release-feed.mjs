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

/** The zipped Mac app from the macOS package job. Both publishers require it before promoting the common version. */
export const macZipPath = path.resolve("out/make/PermitMonitor-mac-arm64.zip");

/** The feed key for a version's Mac zip. The Worker's `/mac` link redirects to it. */
export function macZipKey(version) {
  return `PermitMonitor-${version}-mac-arm64.zip`;
}

/** Hex SHA-256 of a file, read as a stream so a ~280 MB installer isn't held in memory. */
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

  if (new URL(payload.url).pathname !== `/${key}`)
    throw new Error(`The signed manifest points at ${payload.url}, not ${key}.`);
  const { size } = await stat(installerPath);

  if (size !== payload.size || (await sha256File(installerPath)) !== payload.sha256) {
    throw new Error("The local installer does not match the signed manifest; sign it again.");
  }

  return { text, payload, key };
}

/** The matching local Mac artifact, required so a publication cannot break the common feed's Mac download. */
export async function readLocalMac(version) {
  let size;

  try {
    size = (await stat(macZipPath)).size;
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;

    throw new Error(
      `The matching Mac archive is missing: put the mac-app artifact at ${macZipPath} before publishing.`,
    );
  }

  if (size === 0) throw new Error("The matching Mac archive is empty.");

  return { key: macZipKey(version), size, sha256: await sha256File(macZipPath) };
}
