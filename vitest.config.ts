import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees with their own copies of the suite; only this checkout's tests run.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Renderer and worker tests launch the staged browser. Playwright reads this when it loads, so it is set before any
    // test file imports it, and a copy in the user's Playwright cache is never used instead.
    env: { PLAYWRIGHT_BROWSERS_PATH: path.resolve("vendor/playwright-browsers") },
  },
});
