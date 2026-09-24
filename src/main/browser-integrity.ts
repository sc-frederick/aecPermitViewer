import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

interface BrowserManifest {
  version: number;
  files: Array<{ path: string; sha256: string }>;
}

async function filesIn(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "sha256-manifest.json") continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Browser payload contains an unexpected entry");
  }
  return files;
}

export async function verifyBrowserPayload(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(directory, "sha256-manifest.json"), "utf8")) as BrowserManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("Browser payload manifest is invalid");
  const expected = manifest.files.map((entry) => entry.path);
  const actual = (await filesIn(directory)).sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error("Browser payload file list differs from the packaged manifest");
  }
  for (const entry of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Browser payload hash is invalid");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, ...entry.path.split("/")))) hash.update(chunk);
    const expectedHash = Buffer.from(entry.sha256, "hex");
    if (!timingSafeEqual(hash.digest(), expectedHash)) throw new Error("Browser payload file integrity failed");
  }
}
