import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseManifest } from "../infra/update-server/src/manifest.ts";

export const installerPath = path.resolve("out/make/squirrel.windows/x64/PermitMonitorSetup.exe");

export const manifestPath = path.resolve("out/make/squirrel.windows/x64/release-manifest.json");

export const macZipPath = path.resolve("out/make/PermitMonitor-mac-arm64.zip");

export function macZipKey(version) {
  return `PermitMonitor-${version}-mac-arm64.zip`;
}

export async function sha256File(file) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  return hash.digest("hex");
}

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
