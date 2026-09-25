import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

interface BrowserManifest {
  version: number;
  files: Array<{ path: string; sha256: string }>;
}

/** Files hashed at once; overlapping reads keeps the disk busy while earlier chunks are hashed. */
const CONCURRENCY = 4;
const READ_CHUNK_BYTES = 1024 * 1024;

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
  if (manifest.files.some((entry) => !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error("Browser payload hash is invalid");
  let next = 0;
  let failed = false;
  const verifyNext = async (): Promise<void> => {
    while (!failed && next < manifest.files.length) {
      const entry = manifest.files[next++]!;
      try {
        const hash = createHash("sha256");
        const file = path.join(directory, ...entry.path.split("/"));
        for await (const chunk of createReadStream(file, { highWaterMark: READ_CHUNK_BYTES })) hash.update(chunk);
        if (!timingSafeEqual(hash.digest(), Buffer.from(entry.sha256, "hex"))) throw new Error("Browser payload file integrity failed");
      } catch (error) {
        // The other readers stop at their next file.
        failed = true;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, verifyNext));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}
