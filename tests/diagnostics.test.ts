import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCause, DiagnosticLog, type Diagnostic } from "../src/main/diagnostics.js";
import { PermitStore } from "../src/main/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-diagnostics-"));
  directories.push(directory);

  return directory;
}

/** The driver error a real store keeps as the cause when the same permit is added twice. */
function duplicatePermitError(): Error {
  const store = new PermitStore(path.join(temporaryDirectory(), "data.sqlite"));

  try {
    store.addPermit("HC-BLD-26-0087599");
    const again = store.addPermit("HC-BLD-26-0087599");

    if (again._tag === "err" && again.error.cause instanceof Error) return again.error.cause;
  } finally {
    store.close();
  }

  throw new Error("Adding a duplicate permit should have failed");
}

function readEntries(file: string): Diagnostic[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line): Diagnostic => JSON.parse(line));
}

describe("classifying causes", () => {
  it("recognizes a SQLite constraint failure from the driver's structured fields", () => {
    expect(classifyCause(duplicatePermitError())).toMatchObject({ class: "sqlite", code: "ERR_SQLITE_ERROR", errcode: 2067 });
  });

  it("recognizes a failed system call", async () => {
    const missing = path.join(temporaryDirectory(), "missing");
    const cause = await rename(missing, `${missing}.moved`).catch((cause: unknown) => cause);

    expect(classifyCause(cause)).toMatchObject({ class: "system", code: "ENOENT", syscall: "rename" });
  });

  it("marks programming errors as defects and anything thrown that isn't an Error as unclassified", () => {
    expect(classifyCause(new TypeError("x is undefined")).class).toBe("defect");
    expect(classifyCause("plain text")).toEqual({ class: "unclassified", name: "non-error", tag: null, code: null, errcode: null, syscall: null });
  });

  it("keeps an app error's tag", () => {
    class KeyStorageUnavailable extends Error {
      readonly _tag = "KeyStorageUnavailable" as const;
    }

    expect(classifyCause(new KeyStorageUnavailable("unavailable"))).toMatchObject({ class: "tagged", tag: "KeyStorageUnavailable" });
  });
});

describe("the diagnostic log", () => {
  it("records the operation, run, and classified cause, but never the message or free-text fields", () => {
    const file = path.join(temporaryDirectory(), "logs", "diagnostics.jsonl");
    const log = new DiagnosticLog(file, () => new Date("2026-09-28T12:00:00.000Z"));
    const leaky = Object.assign(new Error("key sk-live-secret at C:\\Users\\someone"), { code: "not an identifier: sk-live-secret" });

    log.record("permit:add-and-check", null, duplicatePermitError());
    log.record("check:cache-cleanup", "run-1", leaky);

    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk-live-secret");
    expect(text).not.toContain("someone");
    expect(readEntries(file)).toEqual([
      { at: "2026-09-28T12:00:00.000Z", operation: "permit:add-and-check", runId: null,
        cause: { class: "sqlite", name: "Error", tag: null, code: "ERR_SQLITE_ERROR", errcode: 2067, syscall: null } },
      { at: "2026-09-28T12:00:00.000Z", operation: "check:cache-cleanup", runId: "run-1",
        cause: { class: "unclassified", name: "Error", tag: null, code: null, errcode: null, syscall: null } },
    ]);
  });

  it("moves a full log aside instead of growing it", () => {
    const file = path.join(temporaryDirectory(), "diagnostics.jsonl");
    writeFileSync(file, "x".repeat(300 * 1024));

    new DiagnosticLog(file).record("permit:snapshot", null, new TypeError("boom"));

    expect(statSync(`${file}.1`).size).toBe(300 * 1024);
    expect(readEntries(file).map((entry) => entry.cause.class)).toEqual(["defect"]);
  });

  it("stays quiet when the log can't be written", () => {
    const blocker = path.join(temporaryDirectory(), "not-a-directory");
    writeFileSync(blocker, "");

    expect(() => new DiagnosticLog(path.join(blocker, "diagnostics.jsonl")).record("permit:snapshot", null, new Error("x"))).not.toThrow();
  });
});
