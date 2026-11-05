// Seeds a benchmark copy's database with a realistic permit list before the app starts. Run by perf/permits.bench.ts
// with the same PERMIT_MONITOR_DATA_DIR the app gets; it writes only inside that folder.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PermitStore } from "../src/main/store.js";
import type { JurisdictionId } from "../src/shared/jurisdictions.js";
import type { ReviewEntry } from "../src/shared/reviews.js";

const directory = process.env.PERMIT_MONITOR_DATA_DIR?.trim();

if (!directory) throw new Error("Set PERMIT_MONITOR_DATA_DIR to the benchmark copy's private folder.");

// The layout dataRoot() and databasePath() in src/main/paths.ts give an isolated run.
const databaseFile = path.join(path.resolve(directory), "PermitMonitorData", "data", "permits.sqlite");

const PERMITS = 75;

const DAYS = 30;

const fixtureInstant = Date.parse("2026-10-30T16:00:00.000Z");

const jurisdictions: ReadonlyArray<{ id: JurisdictionId; prefix: string; statuses: ReadonlyArray<string> }> = [
  {
    id: "hillsborough-county-building",
    prefix: "HC-BLD-26-",
    statuses: ["In Process", "Awaiting Client Reply", "Issued"],
  },
  { id: "tampa-building", prefix: "BLD-26-", statuses: ["In Process", "Awaiting Client Reply", "Complete"] },
  { id: "pasco-county-building", prefix: "PR26-", statuses: ["Plan Review In Process", "Awaiting Revisions"] },
  { id: "pinellas-county-building", prefix: "BCP-2026-", statuses: ["In Review", "Awaiting Payment", "Issued"] },
  { id: "polk-county-building", prefix: "BR-2026-", statuses: ["In Review", "Fees Due", "Inspections"] },
  { id: "swfwmd-erp", prefix: "43047", statuses: ["Incomplete", "Issued"] },
];

const reviews = (permit: number): ReviewEntry[] =>
  ["Building", "Zoning", "Fire", "Stormwater"].map((process, index) => ({
    process,
    status: (permit + index) % 4 === 0 ? "Corrections Required" : "Approved",
    date: "2026-09-01",
    dueDate: null,
  }));

if (!existsSync(databaseFile)) {
  const store = new PermitStore(databaseFile);
  const timestamps: Array<{ runId: string; at: string }> = [];

  try {
    store.setMonitoring("manual");

    for (let permit = 0; permit < PERMITS; permit += 1) {
      const jurisdiction = jurisdictions[permit % jurisdictions.length];

      if (!jurisdiction) throw new Error("No jurisdiction");
      const permitNumber = `${jurisdiction.prefix}${String(100_000 + permit).padStart(7, "0")}`;
      const added = store.addPermit(permitNumber, jurisdiction.id);

      if (added._tag !== "ok") throw added.error;

      if (permit % 5 !== 4) store.setProjectNumber(added.value, String(28_000 + Math.floor(permit / 6)));

      for (let day = DAYS - 1; day >= 0; day -= 1) {
        const at = new Date(fixtureInstant - day * 86_400_000).toISOString();

        const runId = store.startRun({
          permitId: added.value,
          appVersion: "bench",
          playwrightVersion: "bench",
          requestedModel: "bench",
          promptVersion: "bench",
        });

        timestamps.push({ runId, at });

        const status = jurisdiction.statuses[(permit + Math.floor(day / 10)) % jurisdiction.statuses.length];

        if (!status) throw new Error("No status");
        store.finishRun({
          runId,
          permitId: added.value,
          outcome: "success",
          actionCount: 0,
          requestCount: 0,
          actualModel: null,
          browserVersion: null,
          observation: {
            verifiedPermitNumber: permitNumber,
            statusLabel: "Record Status",
            statusValue: status,
            reviews: jurisdiction.id === "swfwmd-erp" ? null : reviews(permit),
            observedAt: at,
            recordUrl: `https://example.test/records/${permitNumber}`,
          },
        });
      }
    }
  } finally {
    store.close();
  }

  // The store timestamps runs when they execute. History groups by the run's start, so backdate those timestamps
  // too: changing only observedAt collapses all thirty days into today's single entry. Both variants use fixed dates.
  const database = new DatabaseSync(databaseFile);

  try {
    const update = database.prepare(
      "UPDATE check_runs SET started_at = ?, finished_at = ?, duration_ms = 0 WHERE id = ?",
    );

    database.exec("BEGIN");

    for (const { runId, at } of timestamps) update.run(at, at, runId);
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const verified = new PermitStore(databaseFile);

  try {
    const permits = verified.listPermits();

    if (permits.length !== PERMITS || permits.some((permit) => verified.dailyHistory(permit.id).runs.length !== DAYS))
      throw new Error("The benchmark fixture must contain 75 permits with 30 displayed days each.");
  } finally {
    verified.close();
  }
}
