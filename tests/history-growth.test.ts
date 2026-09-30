import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildSharedListAsync, parseSharedList } from "../src/main/share-list.js";
import { PermitStore } from "../src/main/store.js";

// Run with npm run benchmark:history. Fixtures model 75 permits, three daily checks and 20 reviews per check.
describe("history growth benchmark", () => {
  it("materializes only the retained daily window as discarded history grows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "permit-history-growth-"));
    const file = path.join(root, "data.sqlite");
    const store = new PermitStore(file);
    const db = new DatabaseSync(file);
    const ids: string[] = [];

    const reviewJson = JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ process: `Review ${index}`,
      status: "Corrections Required", date: "2026-09-01", dueDate: "2026-09-01" })));

    const run = db.prepare(`INSERT INTO check_runs (id, permit_id, started_at, finished_at, outcome, app_version, adapter_version,
      prompt_version, requested_model, playwright_version) VALUES (?, ?, ?, ?, 'success', 'test', 'test', 'test', 'test', 'test')`);

    const observed = db.prepare(`INSERT INTO status_observations (id, run_id, permit_id, verified_permit_number, status_label,
      status_value, observed_at, record_url, extractor_version, reviews) VALUES (?, ?, ?, 'X', 'Status', 'In Process', ?, 'https://example.test', 'test', ?)`);

    try {
      for (let index = 0; index < 75; index += 1) {
        const added = store.addPermit(`HC-BLD-26-${String(index).padStart(7, "0")}`);

        if (added._tag !== "ok") throw added.error;
        ids.push(added.value);
      }

      for (const [from, to] of [[0, 365], [365, 1095]]) {
        if (from === undefined || to === undefined) throw new Error("fixture range missing");
        db.exec("BEGIN");

        for (const permitId of ids) {
          for (let day = from; day < to; day += 1) {
            for (let slot = 0; slot < 3; slot += 1) {
              const id = `${permitId}-${day}-${slot}`;
              const at = new Date(Date.UTC(2026, 8, 29, 12 + slot) - day * 86_400_000).toISOString();
              run.run(id, permitId, at, at);
              observed.run(`o-${id}`, id, permitId, at, reviewJson);
            }
          }
        }

        db.exec("COMMIT");
        let reads = 0;
        let maxPermitMs = 0;
        let maxTurnMs = 0;
        let ticks = 0;
        let lastTick = performance.now();

        const heartbeat = setInterval(() => {
          const now = performance.now();
          maxTurnMs = Math.max(maxTurnMs, now - lastTick);
          lastTick = now;
          ticks += 1;
        }, 1);

        const start = performance.now();

        const json = await buildSharedListAsync(store.listPermits(), (id) => {
          const permitStart = performance.now();
          const history = store.dailyHistory(id, 120);
          maxPermitMs = Math.max(maxPermitMs, performance.now() - permitStart);
          reads += history.observations.length;

          return history;
        }, null);

        const elapsedMs = performance.now() - start;
        maxTurnMs = Math.max(maxTurnMs, performance.now() - lastTick);
        clearInterval(heartbeat);
        const list = parseSharedList(json);

        const result = { rawObservations: 75 * to * 3, materializedObservations: reads, timerTicks: ticks,
          elapsedMs: Math.round(elapsedMs), maxPermitMs: Math.round(maxPermitMs), maxTurnMs: Math.round(maxTurnMs), jsonBytes: Buffer.byteLength(json) };

        console.log(JSON.stringify(result));
        writeFileSync(path.join(tmpdir(), `aec-history-${to}.json`), JSON.stringify(result));
        expect(ticks).toBeGreaterThan(0);
        expect(maxTurnMs).toBeLessThan(100);
        expect(reads).toBe(75 * 120);
        expect(list.histories.size).toBe(75);
        expect(maxPermitMs).toBeLessThan(100);
      }
    } finally { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
