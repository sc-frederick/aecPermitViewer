import { describe, expect, it } from "vitest";
import { dailyHistory } from "../src/shared/history.js";
import type { CheckRunRow, ObservationRow, RunOutcome } from "../src/shared/permit.js";

function run(id: string, startedAt: string, outcome: RunOutcome | null): CheckRunRow {
  return {
    id,
    permitId: "p",
    startedAt,
    finishedAt: outcome ? startedAt : null,
    outcome,
    actionCount: 0,
    requestCount: 0,
  };
}

function observed(runId: string, observedAt: string, statusValue: string): ObservationRow {
  return {
    id: `o-${runId}`,
    runId,
    permitId: "p",
    verifiedPermitNumber: "X",
    statusLabel: "Status",
    statusValue,
    reviews: null,
    observedAt,
    recordUrl: "https://example.test",
  };
}

const dayOf = (value: string) => value.slice(0, 10);

describe("daily history", () => {
  it("collapses a day's checks into its latest status", () => {
    const runs = [
      run("c", "2026-09-24T16:43", "success"),
      run("b", "2026-09-24T12:41", "success"),
      run("a", "2026-09-24T12:08", "success"),
    ];

    const observations = [
      observed("c", "2026-09-24T16:43", "Issued"),
      observed("b", "2026-09-24T12:41", "In Process"),
      observed("a", "2026-09-24T12:08", "In Process"),
    ];

    const days = dailyHistory({ runs, observations }, dayOf);
    expect(days).toHaveLength(1);
    expect(days[0]?.observation?.statusValue).toBe("Issued");
  });

  it("keeps one entry per day, newest first", () => {
    const runs = [run("b", "2026-09-25T09:00", "success"), run("a", "2026-09-24T09:00", "success")];

    const observations = [
      observed("b", "2026-09-25T09:00", "In Process"),
      observed("a", "2026-09-24T09:00", "In Process"),
    ];

    expect(dailyHistory({ runs, observations }, dayOf).map((day) => day.run.id)).toEqual(["b", "a"]);
  });

  it("prefers the day's latest read status over a later failed check", () => {
    const runs = [run("b", "2026-09-24T16:00", "blocked"), run("a", "2026-09-24T09:00", "success")];
    const days = dailyHistory({ runs, observations: [observed("a", "2026-09-24T09:00", "In Process")] }, dayOf);
    expect(days).toHaveLength(1);
    expect(days[0]?.observation?.statusValue).toBe("In Process");
  });

  it("shows the latest check on a day with no successful read", () => {
    const runs = [run("b", "2026-09-24T16:00", "blocked"), run("a", "2026-09-24T09:00", "browser_error")];
    const days = dailyHistory({ runs, observations: [] }, dayOf);
    expect(days.map((day) => day.run.id)).toEqual(["b"]);
  });
});
