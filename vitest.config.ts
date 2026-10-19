import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    env: { PLAYWRIGHT_BROWSERS_PATH: path.resolve("vendor/playwright-browsers") },
  },
});
