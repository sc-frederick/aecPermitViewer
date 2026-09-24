import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HILLSBOROUGH_ID,
  HILLSBOROUGH_LABEL,
  START_URL,
  type CheckRunRow,
  type ObservationRow,
  type PermitHistory,
  type PermitRow,
  type RunOutcome,
} from "../shared/permit.js";
import { nextDueAfter, nextSlotAfter } from "../shared/schedule.js";

interface StoredPermit {
  id: string;
  jurisdiction_id: typeof HILLSBOROUGH_ID;
  permit_number: string;
  monitoring_enabled: number;
  last_status: string | null;
  last_observed_at: string | null;
  last_record_url: string | null;
  latest_attempt_at: string | null;
  latest_outcome: RunOutcome | null;
  next_due_at: string | null;
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version);
}

function mapPermit(row: StoredPermit, checking: boolean): PermitRow {
  return {
    id: row.id,
    jurisdictionId: row.jurisdiction_id,
    permitNumber: row.permit_number,
    monitoringEnabled: row.monitoring_enabled === 1,
    lastStatus: row.last_status,
    lastObservedAt: row.last_observed_at,
    lastRecordUrl: row.last_record_url,
    latestAttemptAt: row.latest_attempt_at,
    latestOutcome: row.latest_outcome,
    nextDueAt: row.next_due_at,
    checking,
  };
}

export class PermitStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      const prior = new DatabaseSync(filePath, { readOnly: true });
      const version = userVersion(prior);
      prior.close();
      if (version < 1) copyFileSync(filePath, `${filePath}.before-v1-${Date.now()}.bak`);
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.recoverInterruptedRuns();
  }

  private migrate(): void {
    const version = userVersion(this.db);
    if (version > 1) throw new Error("Database was created by a newer app version.");
    if (version === 1) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE jurisdiction_profiles (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          authority_type TEXT NOT NULL,
          portal_family TEXT NOT NULL,
          official_start_url TEXT NOT NULL,
          tenant TEXT NOT NULL,
          supported_module TEXT NOT NULL,
          coverage_note TEXT NOT NULL,
          adapter_version TEXT NOT NULL,
          matching_rule_version TEXT NOT NULL
        );
        CREATE TABLE permits (
          id TEXT PRIMARY KEY,
          jurisdiction_id TEXT NOT NULL,
          permit_number TEXT NOT NULL,
          comparison_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          monitoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_enabled IN (0,1)),
          interval_hours INTEGER NOT NULL DEFAULT 24,
          next_due_at TEXT,
          last_attempt_id TEXT,
          last_observation_id TEXT,
          last_record_url TEXT,
          FOREIGN KEY (jurisdiction_id) REFERENCES jurisdiction_profiles(id),
          UNIQUE (jurisdiction_id, comparison_value)
        );
        CREATE TABLE check_runs (
          id TEXT PRIMARY KEY,
          permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT,
          safe_error_code TEXT,
          action_count INTEGER NOT NULL DEFAULT 0,
          request_count INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          app_version TEXT NOT NULL,
          adapter_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          requested_model TEXT NOT NULL,
          actual_model TEXT,
          playwright_version TEXT NOT NULL,
          browser_version TEXT
        );
        CREATE TABLE status_observations (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES check_runs(id) ON DELETE CASCADE,
          permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
          verified_permit_number TEXT NOT NULL,
          status_label TEXT NOT NULL,
          status_value TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          record_url TEXT NOT NULL,
          extractor_version TEXT NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX idx_runs_permit_started ON check_runs(permit_id, started_at DESC);
        CREATE INDEX idx_observations_permit_observed ON status_observations(permit_id, observed_at DESC);
      `);
      this.db.prepare(`INSERT INTO jurisdiction_profiles
        (id, display_name, authority_type, portal_family, official_start_url,
        tenant, supported_module, coverage_note, adapter_version, matching_rule_version)
        VALUES (?, ?, 'county-government', 'accela-hillsgovhub', ?, 'HCFL', 'Building',
        'Public HillsGovHub records from January 20, 2021 onward; some exempt records are not public.',
        'hillsborough-1', 'exact-1')`).run(HILLSBOROUGH_ID, HILLSBOROUGH_LABEL, START_URL);
      this.db.exec("PRAGMA user_version = 1");
    });
  }

  close(): void {
    this.db.close();
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recoverInterruptedRuns(): void {
    this.db.prepare(`UPDATE check_runs SET finished_at = ?, outcome = 'browser_error',
      safe_error_code = 'interrupted' WHERE finished_at IS NULL AND outcome IS NULL`)
      .run(new Date().toISOString());
  }

  addPermit(permitNumber: string): string {
    const id = randomUUID();
    // New permits join the scheduled checks by default; each can be excluded from its details.
    this.db.prepare(`INSERT INTO permits (id, jurisdiction_id, permit_number, comparison_value, created_at, monitoring_enabled)
      VALUES (?, ?, ?, ?, ?, 1)`).run(id, HILLSBOROUGH_ID, permitNumber, permitNumber, new Date().toISOString());
    return id;
  }

  listPermits(checkingIds: ReadonlySet<string> = new Set()): PermitRow[] {
    const rows = this.db.prepare(`
      SELECT p.id, p.jurisdiction_id, p.permit_number, p.monitoring_enabled,
        o.status_value AS last_status, o.observed_at AS last_observed_at,
        p.last_record_url, r.started_at AS latest_attempt_at, r.outcome AS latest_outcome, p.next_due_at
      FROM permits p
      LEFT JOIN status_observations o ON o.id = p.last_observation_id
      LEFT JOIN check_runs r ON r.id = p.last_attempt_id
      ORDER BY p.created_at DESC
    `).all() as unknown as StoredPermit[];
    return rows.map((row) => mapPermit(row, checkingIds.has(row.id)));
  }

  getPermit(id: string): PermitRow | null {
    return this.listPermits().find((permit) => permit.id === id) ?? null;
  }

  startRun(input: {
    permitId: string;
    appVersion: string;
    playwrightVersion: string;
  }): string {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO check_runs
        (id, permit_id, started_at, app_version, adapter_version, prompt_version, requested_model, playwright_version)
        VALUES (?, ?, ?, ?, 'hillsborough-1', 'navigation-1', 'jev-1.13.0', ?)`)
        .run(id, input.permitId, new Date().toISOString(), input.appVersion, input.playwrightVersion);
      this.db.prepare("UPDATE permits SET last_attempt_id = ? WHERE id = ?").run(id, input.permitId);
    });
    return id;
  }

  finishRun(input: {
    runId: string;
    permitId: string;
    outcome: RunOutcome;
    actionCount: number;
    requestCount: number;
    actualModel: string | null;
    browserVersion: string | null;
    observation?: Omit<ObservationRow, "id" | "runId" | "permitId">;
  }): void {
    this.transaction(() => {
      const finishedAt = new Date().toISOString();
      const started = this.db.prepare("SELECT started_at AS startedAt FROM check_runs WHERE id = ?")
        .get(input.runId) as unknown as { startedAt: string } | undefined;
      if (!started) throw new Error("Check run not found");
      this.db.prepare(`UPDATE check_runs SET finished_at = ?, outcome = ?, safe_error_code = ?,
        action_count = ?, request_count = ?, duration_ms = ?, actual_model = ?, browser_version = ? WHERE id = ?`)
        .run(finishedAt, input.outcome,
          input.outcome === "success" ? null : input.outcome,
          input.actionCount, input.requestCount, Date.parse(finishedAt) - Date.parse(started.startedAt),
          input.actualModel, input.browserVersion, input.runId);
      if (input.outcome === "success" && input.observation) {
        const observationId = randomUUID();
        const observation = input.observation;
        this.db.prepare(`INSERT INTO status_observations
          (id, run_id, permit_id, verified_permit_number, status_label, status_value, observed_at, record_url, extractor_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hillsborough-1')`)
          .run(observationId, input.runId, input.permitId, observation.verifiedPermitNumber,
            observation.statusLabel, observation.statusValue, observation.observedAt, observation.recordUrl);
        this.db.prepare(`UPDATE permits SET last_observation_id = ?, last_record_url = ?,
          next_due_at = ? WHERE id = ?`).run(observationId, observation.recordUrl,
            nextDueAfter(new Date(), "success").toISOString(), input.permitId);
      } else {
        this.db.prepare("UPDATE permits SET next_due_at = ? WHERE id = ?")
          .run(nextDueAfter(new Date(), input.outcome).toISOString(), input.permitId);
      }
    });
  }

  history(permitId: string): PermitHistory {
    const runs = this.db.prepare(`SELECT id, permit_id AS permitId, started_at AS startedAt,
      finished_at AS finishedAt, outcome, action_count AS actionCount,
      request_count AS requestCount FROM check_runs WHERE permit_id = ? ORDER BY started_at DESC`)
      .all(permitId) as unknown as CheckRunRow[];
    const observations = this.db.prepare(`SELECT id, run_id AS runId, permit_id AS permitId,
      verified_permit_number AS verifiedPermitNumber, status_label AS statusLabel,
      status_value AS statusValue, observed_at AS observedAt, record_url AS recordUrl
      FROM status_observations WHERE permit_id = ? ORDER BY observed_at DESC`)
      .all(permitId) as unknown as ObservationRow[];
    return { runs, observations };
  }

  getObservation(id: string): ObservationRow | null {
    return this.db.prepare(`SELECT id, run_id AS runId, permit_id AS permitId,
      verified_permit_number AS verifiedPermitNumber, status_label AS statusLabel,
      status_value AS statusValue, observed_at AS observedAt, record_url AS recordUrl
      FROM status_observations WHERE id = ?`).get(id) as unknown as ObservationRow | undefined ?? null;
  }

  setMonitoring(mode: "manual" | "scheduled"): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('monitoring', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
  }

  getMonitoring(): "manual" | "scheduled" {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'monitoring'").get() as unknown as { value: string } | undefined;
    // Scheduled checks are the default. "daily" is how earlier versions stored the same choice.
    return row?.value === "manual" ? "manual" : "scheduled";
  }

  getFlag(key: string, fallback: boolean): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as unknown as { value: string } | undefined;
    return row ? row.value === "1" : fallback;
  }

  setFlag(key: string, value: boolean): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value ? "1" : "0");
  }

  latestBrowserVersion(): string | null {
    const row = this.db.prepare(`SELECT browser_version AS version FROM check_runs
      WHERE browser_version IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get() as unknown as { version: string } | undefined;
    return row?.version ?? null;
  }

  duePermitIds(now: string): string[] {
    return (this.db.prepare(`SELECT id FROM permits WHERE monitoring_enabled = 1
      AND (next_due_at IS NULL OR next_due_at <= ?) ORDER BY next_due_at`).all(now) as unknown as Array<{ id: string }>).map((row) => row.id);
  }

  removePermit(id: string): boolean {
    return this.db.prepare("DELETE FROM permits WHERE id = ?").run(id).changes === 1;
  }

  /** Pulls due times set under the old 24-hour rule forward to the next business-hours slot. */
  alignSchedule(now: Date): void {
    const slot = nextSlotAfter(now).toISOString();
    this.db.prepare("UPDATE permits SET next_due_at = ? WHERE next_due_at > ?").run(slot, slot);
  }

  setPermitMonitoring(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE permits SET monitoring_enabled = ?, next_due_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, enabled ? new Date().toISOString() : null, id);
  }
}
