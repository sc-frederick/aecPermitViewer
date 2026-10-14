import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBrowserPayload } from "../src/main/browser-integrity.js";
import { defined } from "./support/defined.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bundled browser integrity", () => {
  it("accepts Chromium's changing Windows diagnostic log while rejecting extra code and a log symlink", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "permit-browser-log-test-"));
    temporary.push(directory);
    const content = "browser binary fixture";
    await writeFile(path.join(directory, "chrome.exe"), content);
    await writeFile(path.join(directory, "sha256-manifest.json"), JSON.stringify({ version: 1, files: [
      { path: "chrome.exe", sha256: createHash("sha256").update(content).digest("hex") },
    ] }));
    const folder = path.join(directory, "chromium_headless_shell-1243", "chrome-headless-shell-win64");
    await mkdir(folder, { recursive: true });
    const log = path.join(folder, "debug.log");
    await writeFile(log, "GPU diagnostics");
    await expect(verifyBrowserPayload(directory)).resolves.toBeUndefined();
    await writeFile(log, "Changed diagnostics");
    await expect(verifyBrowserPayload(directory)).resolves.toBeUndefined();
    const extra = path.join(folder, "extra.dll");
    await writeFile(extra, "unexpected code");
    await expect(verifyBrowserPayload(directory)).rejects.toThrow("file list");
    await rm(extra);
    await rm(log);

    // Creating Windows symlinks requires privileges the test runner may not have.
    if (process.platform !== "win32") {
      await symlink(path.join(directory, "chrome.exe"), log);
      await expect(verifyBrowserPayload(directory)).rejects.toThrow("unexpected entry");
    }
  });

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

  it("checks every file when there are more files than parallel readers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "permit-browser-test-"));
    temporary.push(directory);
    const names = Array.from({ length: 12 }, (_, index) => `file-${String(index).padStart(2, "0")}.bin`);

    for (const name of names) await writeFile(path.join(directory, name), name);
    const manifest = { version: 1, files: names.map((name) => ({ path: name, sha256: createHash("sha256").update(name).digest("hex") })) };
    await writeFile(path.join(directory, "sha256-manifest.json"), JSON.stringify(manifest));
    await expect(verifyBrowserPayload(directory)).resolves.toBeUndefined();
    await writeFile(path.join(directory, defined(names[10], "an eleventh payload file")), "changed");
    await expect(verifyBrowserPayload(directory)).rejects.toThrow("integrity");
  });
});
