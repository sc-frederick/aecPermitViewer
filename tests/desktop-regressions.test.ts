import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckQueue } from "../src/main/check-queue.js";
import { addAndCheck } from "../src/main/permit-commands.js";
import { recordCheckEvent } from "../src/main/notifications.js";
import { serialBroadcast } from "../src/main/serial-broadcast.js";
import { PermitStore } from "../src/main/store.js";
import type { RunOutcome } from "../src/shared/permit.js";
import { checkScope, getAutomatedJurisdiction, type JurisdictionId } from "../src/shared/jurisdictions.js";
import { defined } from "./support/defined.js";

const directories: string[] = [];

const RUN = { appVersion: "test", playwrightVersion: "test", requestedModel: "test", promptVersion: "test" };

function newStore() {
  const root = mkdtempSync(path.join(tmpdir(), "permit-events-"));
  directories.push(root);

  return { store: new PermitStore(path.join(root, "data.sqlite")), file: path.join(root, "data.sqlite") };
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("completed check announcements", () => {
  it("uses prior completed outcomes through the real start/finish sequence", () => {
    vi.useFakeTimers();
    const { store } = newStore();
    const added = store.addPermit("HC-BLD-26-0087599");

    if (added._tag !== "ok") throw added.error;
    const id = added.value;
    const events: Array<string | null> = [];

    try {
      const outcomes: RunOutcome[] = ["blocked", "blocked", "timeout", "success", "blocked", "success", "success"];

      for (const [index, outcome] of outcomes.entries()) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 29, 10, index)));
        const runId = store.startRun({ permitId: id, ...RUN });
        expect(store.getPermit(id)?.latestOutcome).toBeNull();

        const event = recordCheckEvent(store, {
          runId,
          permitId: id,
          outcome,
          actionCount: 0,
          requestCount: 0,
          actualModel: null,
          browserVersion: null,
          observation: {
            verifiedPermitNumber: "HC-BLD-26-0087599",
            statusLabel: "Record Status",
            statusValue: index === 6 ? "Issued" : "In Process",
            reviews: null,
            observedAt: new Date().toISOString(),
            recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?id=1",
          },
        });

        events.push(event?.kind ?? null);
      }

      expect(events).toEqual(["check-failed", null, null, "first-status", "check-failed", null, "status-changed"]);
      expect(store.history(id).observations).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("treats an interrupted recovered run as an existing failure without replaying a startup notice", () => {
    const { store, file } = newStore();
    const added = store.addPermit("HC-BLD-26-0087599");

    if (added._tag !== "ok") throw added.error;
    store.startRun({ permitId: added.value, ...RUN });
    store.close();
    const reopened = new PermitStore(file);

    try {
      expect(reopened.getPermit(added.value)?.latestOutcome).toBe("browser_error");
      const runId = reopened.startRun({ permitId: added.value, ...RUN });
      expect(
        recordCheckEvent(reopened, {
          runId,
          permitId: added.value,
          outcome: "blocked",
          actionCount: 0,
          requestCount: 0,
          actualModel: null,
          browserVersion: null,
        }),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  });
});

describe("permit insertion broadcasts", () => {
  it("announces each manual jurisdiction without requiring a later mutation and coalesces automated queue snapshots", async () => {
    const { store } = newStore();
    const snapshots: Array<{ permits: number; checking: number }> = [];
    const publications: number[] = [];
    const started: string[] = [];
    let finish: () => void = () => undefined;
    let queue: CheckQueue;

    const broadcast = serialBroadcast(async () => {
      const permits = store.listPermits(queue.checkingIds());
      publications.push(permits.length);
      snapshots.push({ permits: permits.length, checking: permits.filter((permit) => permit.checking).length });
    });

    queue = new CheckQueue({
      scopeOf: (id) => {
        const permit = store.getPermit(id);
        const profile = permit && getAutomatedJurisdiction(permit.jurisdictionId);

        return profile ? checkScope(profile) : null;
      },
      scheduledEligible: () => true,
      readKey: async () => "fixture",
      start: (id) => {
        started.push(id);

        const finished = new Promise<RunOutcome>((resolve) => {
          finish = () => resolve("success");
        });

        return { finished, cancel: finish };
      },
      defer: () => undefined,
      keyUnavailable: () => undefined,
      saveFailed: () => undefined,
      changed: () => {
        void broadcast();
      },
    });

    try {
      const manual: JurisdictionId[] = ["palm-bay-building", "orange-county-building", "baker-county-building"];

      for (const [index, jurisdiction] of manual.entries()) {
        expect(
          addAndCheck(
            store,
            queue,
            () => {
              void broadcast();
            },
            `BLD2024-0123${index}`,
            jurisdiction,
          )._tag,
        ).toBe("ok");
        await broadcast();
        expect(snapshots.at(-1)).toEqual({ permits: index + 1, checking: 0 });
        expect(publications.at(-1)).toBe(index + 1);
      }

      expect(started).toEqual([]);

      const automated = addAndCheck(
        store,
        queue,
        () => {
          void broadcast();
        },
        "HC-BLD-26-0087599",
        "hillsborough-county-building",
      );

      if (automated._tag !== "ok") throw automated.error;
      await broadcast();
      expect(started).toEqual([automated.value]);
      expect(snapshots).toHaveLength(4);
      expect(snapshots.at(-1)).toEqual({ permits: 4, checking: 1 });
      expect(defined(store.getPermit(automated.value), "saved permit").permitNumber).toBe("HC-BLD-26-0087599");
      expect(
        addAndCheck(
          store,
          queue,
          () => {
            void broadcast();
          },
          "HC-BLD-26-0087599",
          "hillsborough-county-building",
        )._tag,
      ).toBe("err");
      expect(snapshots).toHaveLength(4);
      finish();
      await queue.stop();
      await broadcast();
    } finally {
      store.close();
    }
  });
});
