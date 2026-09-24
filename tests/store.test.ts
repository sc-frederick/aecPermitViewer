import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermitStore } from "../src/main/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function newStore(): PermitStore {
  const directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-test-"));
  directories.push(directory);
  return new PermitStore(path.join(directory, "data.sqlite"));
}

describe("observation history", () => {
  it("keeps a prior verified status and timestamp after a failed attempt", () => {
    const store = newStore();
    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      const successId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
      const observedAt = "2026-09-24T12:00:00.000Z";
      store.finishRun({
        runId: successId, permitId, outcome: "success", actionCount: 2, requestCount: 2,
        actualModel: "jev-1.13.0", browserVersion: "test",
        observation: {
          verifiedPermitNumber: "HC-BLD-26-0087599", statusLabel: "Record Status:",
          statusValue: "In Process", observedAt,
          recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL",
        },
      });
      const failureId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
      store.finishRun({ runId: failureId, permitId, outcome: "blocked", actionCount: 0,
        requestCount: 0, actualModel: null, browserVersion: null });
      const permit = store.getPermit(permitId);
      expect(permit).toMatchObject({ lastStatus: "In Process", lastObservedAt: observedAt, latestOutcome: "blocked" });
      expect(store.history(permitId).observations).toHaveLength(1);
      expect(store.history(permitId).runs).toHaveLength(2);
      const observation = store.history(permitId).observations[0]!;
      expect(store.getObservation(observation.id)?.recordUrl).toBe(observation.recordUrl);
    } finally {
      store.close();
    }
  });

  it("records unchanged successful observations as separate evidence", () => {
    const store = newStore();
    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      for (const observedAt of ["2026-09-24T12:00:00.000Z", "2026-09-25T12:00:00.000Z"]) {
        const runId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
        store.finishRun({ runId, permitId, outcome: "success", actionCount: 1, requestCount: 1,
          actualModel: "jev-1.13.0", browserVersion: "test",
          observation: { verifiedPermitNumber: "HC-BLD-26-0087599", statusLabel: "Record Status:",
            statusValue: "In Process", observedAt,
            recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL" },
        });
      }
      expect(store.history(permitId).observations).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("permit removal", () => {
  it("deletes a permit with its runs and observations", () => {
    const store = newStore();
    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      const runId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
      store.finishRun({ runId, permitId, outcome: "success", actionCount: 1, requestCount: 1,
        actualModel: "jev-1.13.0", browserVersion: "test",
        observation: { verifiedPermitNumber: "HC-BLD-26-0087599", statusLabel: "Record Status:",
          statusValue: "In Process", observedAt: "2026-09-24T12:00:00.000Z",
          recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL" },
      });
      const observationId = store.history(permitId).observations[0]!.id;
      expect(store.removePermit(permitId)).toBe(true);
      expect(store.getPermit(permitId)).toBeNull();
      expect(store.history(permitId)).toEqual({ runs: [], observations: [] });
      expect(store.getObservation(observationId)).toBeNull();
      expect(store.removePermit(permitId)).toBe(false);
      expect(store.addPermit("HC-BLD-26-0087599")).toBeTruthy();
    } finally {
      store.close();
    }
  });
});

describe("scheduled checks", () => {
  it("includes new permits, defaults to scheduled mode, and reads the earlier 'daily' setting", () => {
    const store = newStore();
    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      expect(store.getPermit(permitId)?.monitoringEnabled).toBe(true);
      expect(store.getMonitoring()).toBe("scheduled");
      store.setMonitoring("manual");
      expect(store.getMonitoring()).toBe("manual");
      (store as unknown as { db: { prepare(sql: string): { run(): void } } }).db
        .prepare("UPDATE settings SET value = 'daily' WHERE key = 'monitoring'").run();
      expect(store.getMonitoring()).toBe("scheduled");
    } finally {
      store.close();
    }
  });

  it("schedules the next check at a business-hours slot and pulls old 24-hour due times forward", () => {
    const store = newStore();
    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      const runId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
      store.finishRun({ runId, permitId, outcome: "blocked", actionCount: 0, requestCount: 0, actualModel: null, browserVersion: null });
      const due = new Date(store.getPermit(permitId)!.nextDueAt!);
      expect([[8, 30], [12, 30], [16, 30]]).toContainEqual([due.getHours(), due.getMinutes()]);

      const now = new Date(2026, 8, 24, 10, 0);
      store.setPermitMonitoring(permitId, true);
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
        .prepare("UPDATE permits SET next_due_at = ? WHERE id = ?").run(new Date(2026, 8, 25, 10, 0).toISOString(), permitId);
      store.alignSchedule(now);
      expect(store.getPermit(permitId)?.nextDueAt).toBe(new Date(2026, 8, 24, 12, 30).toISOString());
    } finally {
      store.close();
    }
  });
});
