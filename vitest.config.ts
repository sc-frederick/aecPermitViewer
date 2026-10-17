import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worktrees under .claude/ hold their own copies of the suite; only this checkout's tests run.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Integration tests on real SQLite and files need headroom for Windows CI disk stalls. Performance budgets are
    // asserted separately.
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    // Renderer and worker tests launch the staged browser. Playwright reads this when it loads, so it is set before any
    // test file imports it, and a copy in the user's Playwright cache is never used instead.
    env: { PLAYWRIGHT_BROWSERS_PATH: path.resolve("vendor/playwright-browsers") },
  },
});
