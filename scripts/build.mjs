import { build } from "esbuild";
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const updateConfig = {
  feedUrl: process.env.UPDATE_FEED_URL ?? "",
  publicKeySpkiBase64: process.env.UPDATE_PUBLIC_KEY_SPKI_BASE64 ?? "",
  expectedPublisher: process.env.UPDATE_EXPECTED_PUBLISHER ?? "",
};
// expectedPublisher stays empty for unsigned builds; the signed manifest is then the only update check.
if (process.env.RELEASE_BUILD === "1" && (!updateConfig.feedUrl || !updateConfig.publicKeySpkiBase64)) {
  throw new Error("A release build requires the update feed URL and public key.");
}
await writeFile("dist/update-config.json", JSON.stringify(updateConfig));

const shared = {
  bundle: true,
  sourcemap: false,
  target: "node24",
  platform: "node",
  format: "cjs",
  external: ["electron", "playwright"],
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs" }),
  build({ ...shared, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs" }),
  build({ ...shared, entryPoints: ["src/worker/index.ts"], outfile: "dist/worker.cjs" }),
  build({ entryPoints: ["src/renderer/index.ts"], outfile: "dist/renderer.js", bundle: true, target: "es2022", platform: "browser", format: "iife" }),
  copyFile("src/renderer/index.html", "dist/index.html"),
  copyFile("src/renderer/styles.css", "dist/styles.css"),
  copyFile("src/main/authenticode.ps1", "dist/authenticode.ps1"),
  cp("assets", "dist/assets", { recursive: true, filter: (source) => !source.endsWith(".ico") }),
]);
