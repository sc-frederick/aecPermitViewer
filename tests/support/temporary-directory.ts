import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/**
 * Create an empty directory in the system temp folder that is removed, with everything in it, when the running test
 * finishes. Removal runs after the test's `afterEach` hooks, so anything those hooks close is closed first.
 *
 * @param prefix - The start of the directory's name, so a leftover directory shows which test made it.
 * @returns The directory's absolute path.
 * @throws Error when called outside a running test or its `beforeEach` hook.
 */
export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}
