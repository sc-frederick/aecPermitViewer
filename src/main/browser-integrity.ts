import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isBrowserDiagnosticFile } from "../shared/browser-payload.js";

const browserManifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

const CONCURRENCY = 4;

const READ_CHUNK_BYTES = 1024 * 1024;

async function filesIn(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "sha256-manifest.json") continue;
    const relative = path.posix.join(prefix, entry.name);

    if (entry.isFile() && isBrowserDiagnosticFile(relative)) continue;

    if (entry.isDirectory()) files.push(...(await filesIn(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Browser payload contains an unexpected entry");
  }

  return files;
}

export async function verifyBrowserPayload(directory: string): Promise<void> {
  const parsed = browserManifestSchema.safeParse(
    JSON.parse(await readFile(path.join(directory, "sha256-manifest.json"), "utf8")),
  );

  if (!parsed.success) throw new Error("Browser payload manifest is invalid");
  const manifest = parsed.data;
  const expected = manifest.files.map((entry) => entry.path).sort();
  const actual = (await filesIn(directory)).sort();

  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error("Browser payload file list differs from the packaged manifest");
  }

  if (manifest.files.some((entry) => !/^[a-f0-9]{64}$/.test(entry.sha256)))
    throw new Error("Browser payload hash is invalid");
  const pending = manifest.files.values();
  let failed = false;

  const verifyNext = async (): Promise<void> => {
    while (!failed) {
      const step = pending.next();

      if (step.done) return;
      const entry = step.value;

      try {
        const hash = createHash("sha256");
        const file = path.join(directory, ...entry.path.split("/"));

        for await (const chunk of createReadStream(file, { highWaterMark: READ_CHUNK_BYTES })) hash.update(chunk);

        if (!timingSafeEqual(hash.digest(), Buffer.from(entry.sha256, "hex")))
          throw new Error("Browser payload file integrity failed");
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, verifyNext));
  const rejected = results.find((result) => result.status === "rejected");

  if (rejected) throw rejected.reason;
}
