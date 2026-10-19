import { build } from "esbuild";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isBrowserDiagnosticFile } from "../src/shared/browser-payload.ts";

await mkdir("dist", { recursive: true });

await rm("dist/chunks", { recursive: true, force: true });

const stagedBrowser = "vendor/playwright-browsers";

if (existsSync(stagedBrowser)) {
  for (const entry of await readdir(stagedBrowser, { withFileTypes: true })) {
    const relative = `${entry.name}/chrome-headless-shell-win64/debug.log`;
    const diagnostic = path.join(stagedBrowser, ...relative.split("/"));

    if (
      entry.isDirectory() &&
      isBrowserDiagnosticFile(relative) &&
      existsSync(diagnostic) &&
      (await lstat(diagnostic)).isFile()
    ) {
      await unlink(diagnostic);
    }
  }
}

const updateConfig = {
  feedUrl: process.env.UPDATE_FEED_URL ?? "",
  publicKeySpkiBase64: process.env.UPDATE_PUBLIC_KEY_SPKI_BASE64 ?? "",
  expectedPublisher: process.env.UPDATE_EXPECTED_PUBLISHER ?? "",
};

if (process.env.RELEASE_BUILD === "1" && (!updateConfig.feedUrl || !updateConfig.publicKeySpkiBase64)) {
  throw new Error("A release build requires the update feed URL and public key.");
}

await writeFile("dist/update-config.json", JSON.stringify(updateConfig));

await writeFile("dist/sync-config.json", JSON.stringify({ serviceUrl: process.env.SHARE_SERVICE_URL ?? "" }));

const { version: playwrightVersion } = createRequire(import.meta.url)("playwright/package.json");

const shared = {
  bundle: true,
  sourcemap: false,
  target: "node24",
  platform: "node",
  format: "cjs",
  external: ["electron", "playwright"],
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main.cjs",
    define: { PLAYWRIGHT_VERSION: JSON.stringify(playwrightVersion) },
  }),
  build({ ...shared, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs" }),
  build({ ...shared, entryPoints: ["src/worker/index.ts"], outfile: "dist/worker.cjs" }),
  build({
    entryPoints: { renderer: "src/renderer/index.ts" },
    outdir: "dist",
    bundle: true,
    target: "es2022",
    platform: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    chunkNames: "chunks/[name]-[hash]",
  }),
  copyFile("src/renderer/index.html", "dist/index.html"),
  copyFile("src/renderer/styles.css", "dist/styles.css"),
  copyFile("src/main/authenticode.ps1", "dist/authenticode.ps1"),
  cp("assets", "dist/assets", {
    recursive: true,
    filter: (source) => !source.endsWith(".ico") && !source.endsWith(".icns") && !source.endsWith("install-splash.gif"),
  }),
]);
