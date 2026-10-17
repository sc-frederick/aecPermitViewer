import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isBrowserDiagnosticFile } from "../src/shared/browser-payload.ts";

const browserPath = path.resolve("vendor/playwright-browsers");

mkdirSync(browserPath, { recursive: true });

// The worker and tests only launch the headless shell, so the full Chromium (about 400 MB) stays out of the installer.
// On macOS it is also an app bundle full of symlinks, which the payload check refuses.
const result = spawnSync(
  process.execPath,
  [path.resolve("node_modules/playwright/cli.js"), "install", "chromium", "--only-shell"],
  {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);

async function filesIn(directory, prefix = "") {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "sha256-manifest.json") continue;
    const relative = path.posix.join(prefix, entry.name);

    // Tests on Windows can leave Chromium's debug.log here. It changes between runs, so it is deleted rather than
    // hashed; every other browser file is hashed.
    if (entry.isFile() && isBrowserDiagnosticFile(relative)) {
      await unlink(path.join(directory, entry.name));

      continue;
    }

    if (entry.isDirectory()) files.push(...(await filesIn(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected browser payload entry: ${relative}`);
  }

  return files;
}

const entries = [];

for (const relative of (await filesIn(browserPath)).sort()) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path.join(browserPath, ...relative.split("/")))) hash.update(chunk);
  entries.push({ path: relative, sha256: hash.digest("hex") });
}

await writeFile(path.join(browserPath, "sha256-manifest.json"), JSON.stringify({ version: 1, files: entries }));

process.stdout.write(`Recorded integrity hashes for ${entries.length} browser files.\n`);
