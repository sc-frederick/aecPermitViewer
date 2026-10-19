import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}
