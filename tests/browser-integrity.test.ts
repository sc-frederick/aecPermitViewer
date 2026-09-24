import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBrowserPayload } from "../src/main/browser-integrity.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bundled browser integrity", () => {
  it("accepts the staged file list and rejects changed or additional files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "permit-browser-test-"));
    temporary.push(directory);
    const content = "browser binary fixture";
    await writeFile(path.join(directory, "chrome.exe"), content);
    await writeFile(path.join(directory, "sha256-manifest.json"), JSON.stringify({ version: 1, files: [
      { path: "chrome.exe", sha256: createHash("sha256").update(content).digest("hex") },
    ] }));
    await expect(verifyBrowserPayload(directory)).resolves.toBeUndefined();
    await writeFile(path.join(directory, "chrome.exe"), "changed");
    await expect(verifyBrowserPayload(directory)).rejects.toThrow("integrity");
    await writeFile(path.join(directory, "extra.dll"), "unexpected");
    await expect(verifyBrowserPayload(directory)).rejects.toThrow("file list");
  });
});
