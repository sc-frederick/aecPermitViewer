import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck, type CheckOperation, type CheckWorker, type WorkerStart } from "../src/main/check-runner.js";
import { classifyCause } from "../src/main/diagnostics.js";
import { HILLSBOROUGH_ID, type PermitRow } from "../src/shared/permit.js";
import type { MainToWorker, WorkerToMain } from "../src/shared/worker-protocol.js";

const RUN_ID = "run-1";

const PERMIT: PermitRow = {
  id: "00000000-0000-4000-8000-000000000001", jurisdictionId: HILLSBOROUGH_ID, permitNumber: "HC-BLD-26-0087599",
  projectNumber: null, reviews: null, monitoringEnabled: true, lastStatus: null, lastObservedAt: null, lastRecordUrl: null,
  latestAttemptAt: null, latestOutcome: null, nextDueAt: null, checking: true,
};

const RECORD_URL = "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** How the stand-in worker answers what main sends it. `environment` is what the worker process was started with. */
type WorkerScript = (message: MainToWorker, worker: TestWorker, environment: NodeJS.ProcessEnv) => void;

/** A stand-in for the worker process: it follows a script, and exits once main cancels the run. */
class TestWorker implements CheckWorker {
  private readonly messageListeners: Array<(message: WorkerToMain) => void> = [];
  private readonly exitListeners: Array<() => void> = [];

  constructor(private readonly script: WorkerScript, private readonly environment: NodeJS.ProcessEnv) {}

  send(message: MainToWorker): void {
    if (message.kind === "cancel") {
      setImmediate(() => this.exit());

      return;
    }

    this.script(message, this, this.environment);
  }

  kill(): void {
    this.exit();
  }

  onMessage(listener: (message: WorkerToMain) => void): void {
    this.messageListeners.push(listener);
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener);
  }

  onError(): void {
    // This stand-in never reports a fatal error.
  }

  /** Delivers a message to main on a later turn, as a real process would. */
  emit(message: WorkerToMain): void {
    setImmediate(() => {
      for (const listener of this.messageListeners) listener(message);
    });
  }

  private exit(): void {
    for (const listener of this.exitListeners.splice(0)) listener();
  }
}

/** Runs one check against a scripted worker, collecting what it reported. */
function check(start: (environment: NodeJS.ProcessEnv) => WorkerStart, removeCache?: (cachePath: string) => Promise<void>) {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "permit-monitor-check-"));
  directories.push(cacheRoot);
  const reports: Array<{ operation: CheckOperation; code: string | null }> = [];

  const active = runCheck({ runId: RUN_ID, permit: PERMIT, key: "test-key-not-used", browserPath: "/browsers", cacheRoot,
    startWorker: start,
    report: (operation, cause) => {
      reports.push({ operation, code: classifyCause(cause).code });
    }, removeCache });

  return { active, reports, cachePath: path.join(cacheRoot, RUN_ID) };
}

function scripted(script: WorkerScript): (environment: NodeJS.ProcessEnv) => WorkerStart {
  return (environment) => ({ _tag: "started", worker: new TestWorker(script, environment) });
}

const verified: WorkerToMain = { kind: "verified", runId: RUN_ID, displayedNumber: PERMIT.permitNumber, statusLabel: "Record Status:",
  statusValue: "In Process", reviews: null, observedAt: "2026-09-28T12:00:00.000Z", recordUrl: RECORD_URL, browserVersion: "140.0" };

describe("running a check", () => {
  it("carries per-review evidence through main's verification", async () => {
    const reviews = [{ process: "Natural Resources Review", status: "Corrections Required", date: "2026-09-24", dueDate: "2026-09-22" }];

    const { active } = check(scripted((message, worker) => {
      if (message.kind === "start") worker.emit({ ...verified, reviews });
    }));

    expect(await active.result).toMatchObject({ outcome: "success", observation: { statusValue: "In Process", reviews } });
    await active.closed;
  });

  it("saves a verified record as a success with its observation, then removes the run's cache", async () => {
    const { active, reports, cachePath } = check(scripted((message, worker) => {
      if (message.kind === "start") worker.emit(verified);
    }));

    const result = await active.result;
    await active.closed;

    expect(result).toMatchObject({ outcome: "success", browserVersion: "140.0",
      observation: { verifiedPermitNumber: PERMIT.permitNumber, statusValue: "In Process", recordUrl: RECORD_URL } });
    expect(existsSync(cachePath)).toBe(false);
    expect(reports).toEqual([]);
  });

  it("records a local failure while handling a worker message as a browser error, not a TypeSafe outage", async () => {
    const { active, reports } = check(scripted((message, worker) => {
      if (message.kind === "start") {
        worker.emit({ kind: "observation", runId: RUN_ID, observation: {
          phase: "results", location: "permit-search", fingerprint: "page-1", headings: [], formLabels: [], visibleControls: [],
          resultNumbers: [PERMIT.permitNumber], recentActions: [],
          candidates: [{ id: "open-result", description: "Open the exact result", established: true }],
        } });
      }

      // The worker's channel closed before main could send the chosen step.
      if (message.kind === "choose") throw Object.assign(new Error("channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
    }));

    expect((await active.result).outcome).toBe("browser_error");
    await active.closed;
    expect(reports).toEqual([{ operation: "handle-message", code: "ERR_IPC_CHANNEL_CLOSED" }]);
  });

  it("still closes, and reports it, when the run's cache can't be removed", async () => {
    const { active, reports, cachePath } = check(scripted((message, worker) => {
      if (message.kind === "start") worker.emit({ kind: "failed", runId: RUN_ID, outcome: "not_found_in_supported_search" });
    }), async () => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });

    expect((await active.result).outcome).toBe("not_found_in_supported_search");
    await active.closed;
    expect(reports).toEqual([{ operation: "cache-cleanup", code: "EACCES" }]);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("ends as a browser error when the worker process can't start, and still removes the cache", async () => {
    const { active, reports, cachePath } = check(() => ({ _tag: "failed", cause: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) }));

    expect(await active.result).toEqual({ outcome: "browser_error", actionCount: 0, requestCount: 0, actualModel: null, browserVersion: null });
    await active.closed;
    expect(reports).toEqual([{ operation: "start-worker", code: "ENOENT" }]);
    expect(existsSync(cachePath)).toBe(false);
  });
});
