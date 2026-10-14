import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PermitStore } from "../src/main/store.js";
import { dailyHistory } from "../src/shared/history.js";
import { defined } from "./support/defined.js";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "permit-daily-"));
  const file = path.join(root, "data.sqlite");
  const store = new PermitStore(file);
  const db = new DatabaseSync(file);
  const added = store.addPermit("HC-BLD-26-0087599");

  if (added._tag !== "ok") throw added.error;

  return { store, db, id: added.value, close: () => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function seed(db: DatabaseSync, permitId: string, times: readonly string[]) {
  const run = db.prepare(`INSERT INTO check_runs (id, permit_id, started_at, finished_at, outcome, app_version, adapter_version,
    prompt_version, requested_model, playwright_version) VALUES (?, ?, ?, ?, ?, 'test', 'test', 'test', 'test', 'test')`);

  const observed = db.prepare(`INSERT INTO status_observations (id, run_id, permit_id, verified_permit_number, status_label,
    status_value, observed_at, record_url, extractor_version, reviews) VALUES (?, ?, ?, 'X', 'Status', ?, ?, 'https://example.test', 'test', ?)`);

  db.exec("BEGIN");

  try {
    for (const [index, time] of times.entries()) {
      const id = `${permitId}-${index}`;
      const success = index % 3 === 0;
      run.run(id, permitId, time, time, success ? "success" : "blocked");

      if (success) observed.run(`o-${id}`, id, permitId, `Status ${index}`, new Date(Date.parse(time) + 3_600_000).toISOString(),
        JSON.stringify([{ process: "Stormwater Review", status: "Corrections Required", date: time.slice(0, 10), dueDate: null }]));
    }

    db.exec("COMMIT");
  } catch (cause) { db.exec("ROLLBACK"); throw cause; }
}

describe("bounded daily store reads", () => {
  it("keeps daily picks for verified successes, failed checks, missing observations and equal timestamps", () => {
    const { store, db, id, close } = setup();

    try {
      const times = Array.from({ length: 15 }, (_, index) => new Date(Date.UTC(2026, 8, 1 + Math.floor(index / 3),
        12, index < 12 ? index % 3 : 0)).toISOString());
      seed(db, id, times);
      db.prepare("UPDATE check_runs SET outcome = 'success' WHERE id IN (?, ?)").run(`${id}-2`, `${id}-8`);
      db.prepare("UPDATE status_observations SET run_id = ? WHERE run_id = ?").run(`${id}-2`, `${id}-0`);
      db.prepare("DELETE FROM status_observations WHERE run_id = ?").run(`${id}-9`);

      const expected = dailyHistory(store.history(id));

      const page = store.dailyHistory(id);
      expect(page.runs.map((run) => run.id)).toEqual([12, 11, 6, 3, 2].map((index) => `${id}-${index}`));
      expect(page.runs).toEqual(expected.map((day) => day.run));
      expect(page.observations).toEqual(expected.flatMap((day) => day.observation ? [day.observation] : []));
    } finally { close(); }
  });

  it("matches dailyHistory picks, reviews and ordering across UTC boundaries and DST", () => {
    const { store, db, id, close } = setup();

    try {
      seed(db, id, ["2026-10-30T12:00:00.000Z", "2026-10-31T23:45:00.000Z", "2026-11-01T00:15:00.000Z",
        "2026-11-01T04:15:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z",
        "2026-11-01T07:30:00.000Z", "2026-11-02T00:15:00.000Z", "2026-11-03T12:00:00.000Z"]);
      const expected = dailyHistory(store.history(id));
      const page = store.dailyHistory(id);
      expect(page.runs).toEqual(expected.map((day) => day.run));
      expect(page.observations).toEqual(expected.flatMap((day) => day.observation ? [day.observation] : []));
      expect(page.nextBefore).toBeNull();
      expect(store.history(id).runs).toHaveLength(9);
    } finally { close(); }
  });

  it("paginates whole days without dropping earlier successes on a page boundary", () => {
    const { store, db, id, close } = setup();

    try {
      const times = Array.from({ length: 410 }, (_, index) => new Date(Date.UTC(2026, 0, 1, 12) + index * 8 * 3_600_000).toISOString());
      seed(db, id, times);
      const expected = dailyHistory(store.history(id));
      const first = store.dailyHistory(id, 120);
      expect(first.runs).toHaveLength(120);
      const cursor = defined(first.nextBefore, "older page cursor");
      const second = store.dailyHistory(id, 120, cursor);
      expect([...first.runs, ...second.runs]).toEqual(expected.map((day) => day.run));
      expect([...first.observations, ...second.observations]).toEqual(expected.flatMap((day) => day.observation ? [day.observation] : []));
      expect(second.nextBefore).toBeNull();
      expect(store.dailyHistory("missing")).toEqual({ runs: [], observations: [], nextBefore: null });
      expect(() => store.dailyHistory(id, 121)).toThrow("Invalid history page size");
    } finally { close(); }
  });

  it("does not parse malformed review JSON in discarded historical or same-day rows", () => {
    const { store, db, id, close } = setup();

    try {
      seed(db, id, ["2026-09-01T10:00:00.000Z", "2026-09-29T08:00:00.000Z", "2026-09-29T09:00:00.000Z", "2026-09-29T16:00:00.000Z"]);
      db.prepare("UPDATE status_observations SET reviews = 'broken json' WHERE run_id = ?").run(`${id}-0`);
      expect(store.dailyHistory(id, 1).runs[0]?.id).toBe(`${id}-3`);
      expect(store.dailyHistory(id, 1).observations[0]?.reviews).toHaveLength(1);
      expect(() => store.history(id)).toThrow();
    } finally { close(); }
  });
});
