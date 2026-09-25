import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PermitStore } from "../src/main/store.js";
import { HILLSBOROUGH_ID } from "../src/shared/permit.js";
import { JURISDICTIONS } from "../src/shared/jurisdictions.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function newStore(): PermitStore {
  const directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-test-"));
  directories.push(directory);

  return new PermitStore(path.join(directory, "data.sqlite"));
}

/** Runs raw SQL on the newest store's file over a second connection, for states the store's API never writes. */
function withDatabase<T>(work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(directories[directories.length - 1]!, "data.sqlite"));

  try {
    return work(db);
  } finally {
    db.close();
  }
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

describe("jurisdiction persistence", () => {
  it("seeds each supported profile and associates permits and run metadata with their profile", () => {
    const store = newStore();

    try {
      const profile = JURISDICTIONS.find((entry) => entry.id !== HILLSBOROUGH_ID);
      expect(profile).toBeDefined();
      const permitId = store.addPermit("TEST-123", profile!.id);
      expect(store.getPermit(permitId)?.jurisdictionId).toBe(profile!.id);
      const runId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
      store.finishRun({ runId, permitId, outcome: "blocked", actionCount: 0, requestCount: 0,
        actualModel: null, browserVersion: null });
      withDatabase((db) => {
        expect(db.prepare("SELECT adapter_version AS version FROM check_runs WHERE id = ?").get(runId))
          .toEqual({ version: profile!.adapterVersion });
        expect(db.prepare("SELECT COUNT(*) AS count FROM jurisdiction_profiles").get())
          .toEqual({ count: JURISDICTIONS.length });
      });
    } finally {
      store.close();
    }
  });

  it.each([1, 2])("restores missing profiles when opening a version %i database", (version) => {
    const store = newStore();
    const directory = directories[directories.length - 1]!;
    const filePath = path.join(directory, "data.sqlite");
    store.close();
    withDatabase((db) => {
      db.exec("DELETE FROM jurisdiction_profiles");
      db.exec(`PRAGMA user_version = ${version}`);
    });
    const migrated = new PermitStore(filePath);

    try {
      withDatabase((db) => expect(db.prepare("SELECT COUNT(*) AS count FROM jurisdiction_profiles").get())
        .toEqual({ count: JURISDICTIONS.length }));
    } finally {
      migrated.close();
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
      withDatabase((db) => db.exec("UPDATE settings SET value = 'daily' WHERE key = 'monitoring'"));
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
      withDatabase((db) => db.prepare("UPDATE permits SET next_due_at = ? WHERE id = ?")
        .run(new Date(2026, 8, 25, 10, 0).toISOString(), permitId));
      store.alignSchedule(now);
      expect(store.getPermit(permitId)?.nextDueAt).toBe(new Date(2026, 8, 24, 12, 30).toISOString());
    } finally {
      store.close();
    }
  });

  it("stores custom check times and pulls due times forward to the new schedule", () => {
    const store = newStore();

    try {
      expect(store.getCheckTimes()).toEqual([{ hour: 8, minute: 30 }, { hour: 12, minute: 30 }, { hour: 16, minute: 30 }]);
      const permitId = store.addPermit("HC-BLD-26-0087599");
      withDatabase((db) => db.prepare("UPDATE permits SET next_due_at = ? WHERE id = ?")
        .run(new Date(2026, 8, 24, 12, 30).toISOString(), permitId));
      store.setCheckTimes([{ hour: 7, minute: 0 }, { hour: 10, minute: 15 }], new Date(2026, 8, 24, 9, 0));
      expect(store.getCheckTimes()).toEqual([{ hour: 7, minute: 0 }, { hour: 10, minute: 15 }]);
      expect(store.getPermit(permitId)?.nextDueAt).toBe(new Date(2026, 8, 24, 10, 15).toISOString());
    } finally {
      store.close();
    }
  });
});

describe("hand-checked permits", () => {
  it("stay out of scheduled checks and record entered statuses as observations", () => {
    const store = newStore();

    try {
      const permitId = store.addPermit("BLD2024-01234", "orange-county-building");
      expect(store.getPermit(permitId)?.monitoringEnabled).toBe(false);
      expect(store.duePermitIds(new Date().toISOString())).not.toContain(permitId);
      expect(() => store.setPermitMonitoring(permitId, true)).toThrow();

      store.recordManualStatus({ permitId, status: "Issued", appVersion: "test",
        recordUrl: "https://fasttrack.ocfl.net/OnlineServices/PermitsAllTypes.aspx" });
      const permit = store.getPermit(permitId);
      expect(permit).toMatchObject({ lastStatus: "Issued", latestOutcome: "success",
        lastRecordUrl: "https://fasttrack.ocfl.net/OnlineServices/PermitsAllTypes.aspx" });
      const history = store.history(permitId);
      expect(history.runs).toHaveLength(1);
      expect(history.observations[0]).toMatchObject({ statusValue: "Issued", verifiedPermitNumber: "BLD2024-01234" });
    } finally {
      store.close();
    }
  });

  it("refuses an entered status for an automated permit", () => {
    const store = newStore();

    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      expect(() => store.recordManualStatus({ permitId, status: "Issued", appVersion: "test",
        recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapHome.aspx" })).toThrow();
    } finally {
      store.close();
    }
  });
});

describe("project numbers", () => {
  it("saves, trims, and clears a permit's project number", () => {
    const store = newStore();

    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      expect(store.getPermit(permitId)?.projectNumber).toBeNull();
      expect(store.setProjectNumber(permitId, " 28069 ")).toBe(true);
      expect(store.getPermit(permitId)?.projectNumber).toBe("28069");
      store.setProjectNumber(permitId, "");
      expect(store.getPermit(permitId)?.projectNumber).toBeNull();
      expect(store.setProjectNumber("00000000-0000-4000-8000-000000000000", "28069")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("adds the project column to a version 2 database and keeps its permits", () => {
    const store = newStore();
    const directory = directories[directories.length - 1]!;
    const filePath = path.join(directory, "data.sqlite");
    let permitId = "";

    try {
      permitId = store.addPermit("HC-BLD-26-0087599");
    } finally {
      store.close();
    }

    withDatabase((db) => {
      db.exec("ALTER TABLE permits DROP COLUMN project_number");
      db.exec("PRAGMA user_version = 2");
    });

    const migrated = new PermitStore(filePath);

    try {
      expect(migrated.getPermit(permitId)).toMatchObject({ permitNumber: "HC-BLD-26-0087599", projectNumber: null });
      migrated.setProjectNumber(permitId, "28069");
      expect(migrated.getPermit(permitId)?.projectNumber).toBe("28069");
    } finally {
      migrated.close();
    }
  });
});

describe("lookups", () => {
  it("reads one permit exactly as the list shows it", () => {
    const store = newStore();

    try {
      const first = store.addPermit("HC-BLD-26-0087599");
      const second = store.addPermit("HC-BLD-26-0087600");
      store.setProjectNumber(second, "28069");
      const runId = store.startRun({ permitId: second, appVersion: "test", playwrightVersion: "test" });
      store.finishRun({ runId, permitId: second, outcome: "blocked", actionCount: 0, requestCount: 0,
        actualModel: null, browserVersion: null });

      for (const permit of store.listPermits()) expect(store.getPermit(permit.id)).toEqual(permit);
      expect(store.getPermit(first)?.permitNumber).toBe("HC-BLD-26-0087599");
      expect(store.getPermit("00000000-0000-4000-8000-000000000000")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports the browser version from the most recent run that recorded one", () => {
    const store = newStore();

    try {
      const permitId = store.addPermit("HC-BLD-26-0087599");
      expect(store.latestBrowserVersion()).toBeNull();

      for (const browserVersion of ["139.0", "140.0", null]) {
        const runId = store.startRun({ permitId, appVersion: "test", playwrightVersion: "test" });
        store.finishRun({ runId, permitId, outcome: "blocked", actionCount: 0, requestCount: 0, actualModel: null, browserVersion });
      }

      expect(store.latestBrowserVersion()).toBe("140.0");

      const plan = withDatabase((db) => db.prepare(`EXPLAIN QUERY PLAN SELECT browser_version FROM check_runs
        WHERE browser_version IS NOT NULL ORDER BY started_at DESC LIMIT 1`).all());

      expect(plan.map((step) => step.detail).join(" ")).toContain("idx_runs_started");
    } finally {
      store.close();
    }
  });
});
