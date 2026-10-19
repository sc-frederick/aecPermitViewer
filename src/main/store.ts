import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { reviewsSchema } from "../shared/review-schema.js";
import {
  HILLSBOROUGH_ID,
  MANUAL_STATUS_LABEL,
  permitComparisonValue,
  runOutcomeSchema,
  type CheckRunRow,
  type ObservationRow,
  type PermitHistory,
  type PermitRow,
  type RunOutcome,
} from "../shared/permit.js";
import {
  getJurisdiction,
  isManualJurisdiction,
  JURISDICTIONS,
  type JurisdictionId,
  type JurisdictionProfile,
} from "../shared/jurisdictions.js";
import {
  DEFAULT_CHECK_TIMES,
  formatCheckTime,
  nextDueAfter,
  nextSlotAfter,
  normalizeCheckTimes,
  type CheckTimes,
} from "../shared/schedule.js";

const SCHEMA_VERSION = 5;

const userVersionSchema = z.object({ user_version: z.number() });

const columnSchema = z.object({ name: z.string() });

const jurisdictionRefSchema = z.object({ jurisdictionId: z.string() });

const dueSchema = z.object({ id: z.string(), jurisdictionId: z.string() });

const previousAttemptSchema = z.object({ latestAttemptAt: z.string(), latestOutcome: runOutcomeSchema });

const scheduleDeadlineSchema = z.object({
  id: z.string(),
  nextDueAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: runOutcomeSchema.nullable(),
});

const startedSchema = z.object({ startedAt: z.string() });

const settingSchema = z.object({ value: z.string() });

const changeCountSchema = z.object({ changes: z.number() });

const storedReviewsSchema = z
  .string()
  .transform((value) => JSON.parse(value))
  .pipe(reviewsSchema);

const storedPermitSchema = z.object({
  id: z.string(),
  jurisdiction_id: z.string(),
  permit_number: z.string(),
  project_number: z.string().nullable(),
  monitoring_enabled: z.number(),
  last_status: z.string().nullable(),
  reviews: storedReviewsSchema.nullable(),
  last_observed_at: z.string().nullable(),
  last_record_url: z.string().nullable(),
  latest_attempt_at: z.string().nullable(),
  latest_outcome: runOutcomeSchema.nullable(),
  next_due_at: z.string().nullable(),
});

type StoredPermit = z.infer<typeof storedPermitSchema>;

const checkRunSchema = z.object({
  id: z.string(),
  permitId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: runOutcomeSchema.nullable(),
  actionCount: z.number(),
  requestCount: z.number(),
}) satisfies z.ZodType<CheckRunRow>;

const observationSchema = z.object({
  id: z.string(),
  runId: z.string(),
  permitId: z.string(),
  verifiedPermitNumber: z.string(),
  statusLabel: z.string(),
  statusValue: z.string(),
  reviews: storedReviewsSchema,
  observedAt: z.string(),
  recordUrl: z.string(),
}) satisfies z.ZodType<ObservationRow>;

/**
 * How node:sqlite reports a UNIQUE constraint violation: its generic code plus SQLite's extended result code
 * SQLITE_CONSTRAINT_UNIQUE (2067). The message text isn't a stable contract, so it isn't matched.
 */
const uniqueViolationSchema = z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(2067) });

export class AlreadyTracked extends Error {
  readonly _tag = "AlreadyTracked" as const;
  readonly jurisdictionId: JurisdictionId;
  readonly permitNumber: string;

  constructor(jurisdictionId: JurisdictionId, permitNumber: string, cause: unknown) {
    super(`Permit ${permitNumber} is already tracked for ${jurisdictionId}.`, { cause });
    this.name = "AlreadyTracked";
    this.jurisdictionId = jurisdictionId;
    this.permitNumber = permitNumber;
  }
}

export type AddPermitResult = { _tag: "ok"; value: string } | { _tag: "err"; error: AlreadyTracked };

interface RunCompletion {
  runId: string;
  permitId: string;
  outcome: RunOutcome;
  actionCount: number;
  requestCount: number;
  actualModel: string | null;
  browserVersion: string | null;
  observation?: Omit<ObservationRow, "id" | "runId" | "permitId">;
}

function userVersion(db: DatabaseSync): number {
  return userVersionSchema.parse(db.prepare("PRAGMA user_version").get()).user_version;
}

const RUN_COLUMNS = `id, permit_id AS permitId, started_at AS startedAt, finished_at AS finishedAt, outcome,
  action_count AS actionCount, request_count AS requestCount`;

const OBSERVATION_COLUMNS = `id, run_id AS runId, permit_id AS permitId, verified_permit_number AS verifiedPermitNumber,
  status_label AS statusLabel, status_value AS statusValue, observed_at AS observedAt, record_url AS recordUrl, reviews`;

const PERMIT_SELECT = `
  SELECT p.id, p.jurisdiction_id, p.permit_number, p.project_number, p.monitoring_enabled,
    o.status_value AS last_status, o.observed_at AS last_observed_at, o.reviews,
    p.last_record_url, r.started_at AS latest_attempt_at, r.outcome AS latest_outcome, p.next_due_at
  FROM permits p
  LEFT JOIN status_observations o ON o.id = p.last_observation_id
  LEFT JOIN check_runs r ON r.id = p.last_attempt_id`;

function mapPermit(row: StoredPermit, checking: boolean): PermitRow | null {
  const jurisdiction = getJurisdiction(row.jurisdiction_id);

  if (!jurisdiction) return null;

  return {
    id: row.id,
    jurisdictionId: jurisdiction.id,
    permitNumber: row.permit_number,
    projectNumber: row.project_number,
    monitoringEnabled: row.monitoring_enabled === 1,
    lastStatus: row.last_status,
    reviews: row.reviews,
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
  private readonly statements = new Map<string, StatementSync>();

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });

    if (existsSync(filePath)) {
      const prior = new DatabaseSync(filePath, { readOnly: true });

      try {
        const version = userVersion(prior);

        // VACUUM INTO writes one standalone file through SQLite, so commits still sitting in the WAL after an abrupt
        // exit are included. Copying the main file alone would leave them out.
        if (version < SCHEMA_VERSION)
          prior.prepare("VACUUM INTO ?").run(`${filePath}.before-v${version + 1}-${Date.now()}.bak`);
      } finally {
        prior.close();
      }
    }

    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.syncProfiles();
    this.recoverInterruptedRuns();
  }

  private migrate(): void {
    const version = userVersion(this.db);

    if (version > SCHEMA_VERSION) throw new Error("Database was created by a newer app version.");

    if (version === 0)
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
        this.db.exec("PRAGMA user_version = 1");
      });

    if (version < 2) this.db.exec("PRAGMA user_version = 2");

    const columns = this.db
      .prepare("PRAGMA table_info(permits)")
      .all()
      .map((column) => columnSchema.parse(column));

    if (!columns.some((column) => column.name === "project_number"))
      this.db.exec("ALTER TABLE permits ADD COLUMN project_number TEXT");

    if (version < 3) this.db.exec("PRAGMA user_version = 3");

    if (version < 4)
      this.transaction(() => {
        const observationColumns = this.db
          .prepare("PRAGMA table_info(status_observations)")
          .all()
          .map((column) => columnSchema.parse(column));

        if (!observationColumns.some((column) => column.name === "reviews")) {
          this.db.exec("ALTER TABLE status_observations ADD COLUMN reviews TEXT NOT NULL DEFAULT 'null'");
        }

        this.db.exec("PRAGMA user_version = 4");
      });

    if (version < 5)
      this.transaction(() => {
        this.db.exec("DROP INDEX IF EXISTS idx_runs_started");

        if (columns.some((column) => column.name === "interval_hours"))
          this.db.exec("ALTER TABLE permits DROP COLUMN interval_hours");

        this.db.exec("PRAGMA user_version = 5");
      });

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_success_permit_started ON check_runs(permit_id, started_at DESC) WHERE outcome = 'success'",
    );
  }

  private syncProfiles(): void {
    const MATCHING_RULES: Partial<Record<JurisdictionProfile["portalFamily"], string>> = {
      click2gov: "click2gov-serial-1",
      wmis: "wmis-serial-1",
      epermit: "epermit-number-sequence-1",
      regpermitting: "exact-uppercase-1",
    };

    const seed = this.db.prepare(`INSERT INTO jurisdiction_profiles
      (id, display_name, authority_type, portal_family, official_start_url,
      tenant, supported_module, coverage_note, adapter_version, matching_rule_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
        authority_type = excluded.authority_type, portal_family = excluded.portal_family,
        official_start_url = excluded.official_start_url, tenant = excluded.tenant,
        supported_module = excluded.supported_module, coverage_note = excluded.coverage_note,
        adapter_version = excluded.adapter_version, matching_rule_version = excluded.matching_rule_version`);

    this.transaction(() => {
      for (const profile of JURISDICTIONS)
        seed.run(
          profile.id,
          profile.label,
          profile.authorityType,
          profile.portalFamily,
          profile.startUrl,
          profile.tenant,
          profile.module,
          profile.coverageNote,
          profile.adapterVersion,
          MATCHING_RULES[profile.portalFamily] ?? "exact-1",
        );
    });
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  changeCount(): number {
    return changeCountSchema.parse(this.sql("SELECT total_changes() AS changes").get()).changes;
  }

  private sql(source: string): StatementSync {
    let statement = this.statements.get(source);

    if (!statement) {
      statement = this.db.prepare(source);
      this.statements.set(source, statement);
    }

    return statement;
  }

  private row<T>(schema: z.ZodType<T>, source: string, ...params: SQLInputValue[]): T | null {
    const row = this.sql(source).get(...params);

    return row ? schema.parse(row) : null;
  }

  private rows<T>(schema: z.ZodType<T>, source: string, ...params: SQLInputValue[]): T[] {
    return this.sql(source)
      .all(...params)
      .map((row) => schema.parse(row));
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
    this.sql(
      `UPDATE check_runs SET finished_at = ?, outcome = 'browser_error',
      safe_error_code = 'interrupted' WHERE finished_at IS NULL AND outcome IS NULL`,
    ).run(new Date().toISOString());
  }

  addPermit(permitNumber: string, jurisdictionId: JurisdictionId = HILLSBOROUGH_ID): AddPermitResult {
    if (!getJurisdiction(jurisdictionId)) throw new Error("Unsupported jurisdiction");
    const id = randomUUID();

    try {
      this.sql(
        `INSERT INTO permits (id, jurisdiction_id, permit_number, comparison_value, created_at, monitoring_enabled)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        jurisdictionId,
        permitNumber,
        permitComparisonValue(permitNumber, jurisdictionId),
        new Date().toISOString(),
        isManualJurisdiction(jurisdictionId) ? 0 : 1,
      );
    } catch (cause) {
      if (uniqueViolationSchema.safeParse(cause).success) {
        return { _tag: "err", error: new AlreadyTracked(jurisdictionId, permitNumber, cause) };
      }

      throw cause;
    }

    return { _tag: "ok", value: id };
  }

  listPermits(checkingIds: ReadonlySet<string> = new Set()): PermitRow[] {
    return this.rows(storedPermitSchema, `${PERMIT_SELECT} ORDER BY p.created_at DESC`).flatMap(
      (row) => mapPermit(row, checkingIds.has(row.id)) ?? [],
    );
  }

  getPermit(id: string): PermitRow | null {
    const row = this.row(storedPermitSchema, `${PERMIT_SELECT} WHERE p.id = ?`, id);

    return row ? mapPermit(row, false) : null;
  }

  getPermitBeforeRun(permitId: string, runId: string): PermitRow | null {
    const permit = this.getPermit(permitId);

    if (!permit) return null;

    const previous = this.row(
      previousAttemptSchema,
      `SELECT started_at AS latestAttemptAt, outcome AS latestOutcome
      FROM check_runs WHERE permit_id = ? AND id <> ? AND outcome IS NOT NULL
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      permitId,
      runId,
    );

    return {
      ...permit,
      latestAttemptAt: previous?.latestAttemptAt ?? null,
      latestOutcome: previous?.latestOutcome ?? null,
    };
  }

  startRun(input: {
    permitId: string;
    appVersion: string;
    playwrightVersion: string;
    requestedModel: string;
    promptVersion: string;
  }): string {
    const adapterVersion = this.jurisdictionAdapterVersion(input.permitId);
    const id = randomUUID();
    this.transaction(() => {
      this.sql(
        `INSERT INTO check_runs
        (id, permit_id, started_at, app_version, adapter_version, prompt_version, requested_model, playwright_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.permitId,
        new Date().toISOString(),
        input.appVersion,
        adapterVersion,
        input.promptVersion,
        input.requestedModel,
        input.playwrightVersion,
      );
      this.sql("UPDATE permits SET last_attempt_id = ? WHERE id = ?").run(id, input.permitId);
    });

    return id;
  }

  finishRun(input: RunCompletion): void {
    this.transaction(() => this.completeRun(input));
  }

  private completeRun(input: RunCompletion): void {
    const finishedAt = new Date().toISOString();
    const started = this.row(startedSchema, "SELECT started_at AS startedAt FROM check_runs WHERE id = ?", input.runId);

    if (!started) throw new Error("Check run not found");
    this.sql(
      `UPDATE check_runs SET finished_at = ?, outcome = ?, safe_error_code = ?,
      action_count = ?, request_count = ?, duration_ms = ?, actual_model = ?, browser_version = ? WHERE id = ?`,
    ).run(
      finishedAt,
      input.outcome,
      input.outcome === "success" ? null : input.outcome,
      input.actionCount,
      input.requestCount,
      Date.parse(finishedAt) - Date.parse(started.startedAt),
      input.actualModel,
      input.browserVersion,
      input.runId,
    );

    if (input.outcome === "success" && input.observation) {
      const observationId = randomUUID();
      const observation = input.observation;
      this.sql(
        `INSERT INTO status_observations
        (id, run_id, permit_id, verified_permit_number, status_label, status_value, observed_at, record_url, extractor_version, reviews)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        observationId,
        input.runId,
        input.permitId,
        observation.verifiedPermitNumber,
        observation.statusLabel,
        observation.statusValue,
        observation.observedAt,
        observation.recordUrl,
        this.jurisdictionAdapterVersion(input.permitId),
        JSON.stringify(observation.reviews),
      );
      this.sql(
        `UPDATE permits SET last_observation_id = ?, last_record_url = ?,
        next_due_at = ? WHERE id = ?`,
      ).run(
        observationId,
        observation.recordUrl,
        nextDueAfter(new Date(), "success", this.getCheckTimes()).toISOString(),
        input.permitId,
      );
    } else {
      this.sql("UPDATE permits SET next_due_at = ? WHERE id = ?").run(
        nextDueAfter(new Date(), input.outcome, this.getCheckTimes()).toISOString(),
        input.permitId,
      );
    }
  }

  recordManualStatus(input: { permitId: string; status: string; recordUrl: string; appVersion: string }): void {
    const permit = this.getPermit(input.permitId);

    if (!permit || !isManualJurisdiction(permit.jurisdictionId)) throw new Error("Permit is not checked by hand");
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.sql(
        `INSERT INTO check_runs
        (id, permit_id, started_at, app_version, adapter_version, prompt_version, requested_model, playwright_version)
        VALUES (?, ?, ?, ?, 'manual-1', 'manual', 'manual', 'none')`,
      ).run(runId, input.permitId, now, input.appVersion);
      this.sql("UPDATE permits SET last_attempt_id = ? WHERE id = ?").run(runId, input.permitId);
      this.completeRun({
        runId,
        permitId: input.permitId,
        outcome: "success",
        actionCount: 0,
        requestCount: 0,
        actualModel: null,
        browserVersion: null,
        observation: {
          verifiedPermitNumber: permit.permitNumber,
          statusLabel: MANUAL_STATUS_LABEL,
          statusValue: input.status,
          reviews: null,
          observedAt: now,
          recordUrl: input.recordUrl,
        },
      });
    });
  }

  history(permitId: string): PermitHistory {
    const runs = this.rows(
      checkRunSchema,
      `SELECT ${RUN_COLUMNS} FROM check_runs WHERE permit_id = ? ORDER BY started_at DESC`,
      permitId,
    );

    const observations = this.rows(
      observationSchema,
      `SELECT ${OBSERVATION_COLUMNS} FROM status_observations WHERE permit_id = ? ORDER BY observed_at DESC`,
      permitId,
    );

    return { runs, observations };
  }

  dailyHistory(permitId: string, days = 120, before: string | null = null): PermitHistory {
    if (!Number.isInteger(days) || days < 1 || days > 120) throw new Error("Invalid history page size");
    const runs: CheckRunRow[] = [];
    const observations: ObservationRow[] = [];
    let cursor = before ?? "9999-12-31T23:59:59.999Z";

    const runSelect = `SELECT ${RUN_COLUMNS} FROM check_runs r`;
    const observationSelect = `SELECT ${OBSERVATION_COLUMNS} FROM status_observations WHERE run_id = ?`;

    for (let index = 0; index < days; index += 1) {
      const latest = this.row(
        checkRunSchema,
        `${runSelect} WHERE r.permit_id = ? AND r.started_at < ?
        ORDER BY r.started_at DESC LIMIT 1`,
        permitId,
        cursor,
      );

      if (!latest) break;
      const date = new Date(latest.startedAt);
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();

      const latestObservation =
        latest.outcome === "success" ? this.row(observationSchema, observationSelect, latest.id) : null;

      const chosen = latestObservation
        ? latest
        : (this.row(
            checkRunSchema,
            `${runSelect} WHERE r.permit_id = ? AND r.started_at >= ?
        AND r.started_at < ? AND r.outcome = 'success'
        AND EXISTS (SELECT 1 FROM status_observations o WHERE o.run_id = r.id)
        ORDER BY r.started_at DESC LIMIT 1`,
            permitId,
            start,
            cursor,
          ) ?? latest);

      runs.push(chosen);

      const observation = latestObservation ?? this.row(observationSchema, observationSelect, chosen.id);

      if (observation) observations.push(observation);
      cursor = start;
    }

    const older = this.row(
      startedSchema,
      `SELECT started_at AS startedAt FROM check_runs
      WHERE permit_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT 1`,
      permitId,
      cursor,
    );

    return { runs, observations, nextBefore: older ? cursor : null };
  }

  getObservation(id: string): ObservationRow | null {
    return this.row(observationSchema, `SELECT ${OBSERVATION_COLUMNS} FROM status_observations WHERE id = ?`, id);
  }

  getObservationJurisdictionId(id: string): JurisdictionId | null {
    const row = this.row(
      jurisdictionRefSchema,
      `SELECT p.jurisdiction_id AS jurisdictionId FROM status_observations o
      JOIN permits p ON p.id = o.permit_id WHERE o.id = ?`,
      id,
    );

    return row ? (getJurisdiction(row.jurisdictionId)?.id ?? null) : null;
  }

  private jurisdictionAdapterVersion(permitId: string): string {
    const row = this.row(
      jurisdictionRefSchema,
      "SELECT jurisdiction_id AS jurisdictionId FROM permits WHERE id = ?",
      permitId,
    );

    const profile = row ? getJurisdiction(row.jurisdictionId) : null;

    if (!profile) throw new Error("Permit jurisdiction is not configured");

    return profile.adapterVersion;
  }

  setMonitoring(mode: "manual" | "scheduled"): void {
    this.putSetting("monitoring", mode);
  }

  getMonitoring(): "manual" | "scheduled" {
    const row = this.row(settingSchema, "SELECT value FROM settings WHERE key = 'monitoring'");

    return row?.value === "manual" ? "manual" : "scheduled";
  }

  getCheckTimes(): CheckTimes {
    const row = this.row(settingSchema, "SELECT value FROM settings WHERE key = 'check_times'");
    const stored = row ? normalizeCheckTimes(row.value.split(",")) : null;

    return stored ?? DEFAULT_CHECK_TIMES;
  }

  setCheckTimes(times: CheckTimes, now: Date): void {
    this.transaction(() => {
      const previousTimes = this.getCheckTimes();
      this.putSetting("check_times", times.map(formatCheckTime).join(","));

      const future = this.rows(
        scheduleDeadlineSchema,
        `SELECT p.id, p.next_due_at AS nextDueAt, r.finished_at AS finishedAt, r.outcome
        FROM permits p LEFT JOIN check_runs r ON r.id = p.last_attempt_id WHERE p.next_due_at > ?`,
        now.toISOString(),
      );

      const next = nextSlotAfter(now, times);

      for (const permit of future) {
        const retry =
          permit.outcome === "api_unavailable" &&
          permit.finishedAt &&
          permit.nextDueAt === nextDueAfter(new Date(permit.finishedAt), "api_unavailable", previousTimes).toISOString()
            ? new Date(Date.parse(permit.finishedAt) + 3_600_000)
            : next;

        const due = retry > now && retry < next ? retry : next;
        this.sql("UPDATE permits SET next_due_at = ? WHERE id = ?").run(due.toISOString(), permit.id);
      }
    });
  }

  getFlag(key: string, fallback: boolean): boolean {
    const row = this.row(settingSchema, "SELECT value FROM settings WHERE key = ?", key);

    return row ? row.value === "1" : fallback;
  }

  setFlag(key: string, value: boolean): void {
    this.putSetting(key, value ? "1" : "0");
  }

  getText(key: string): string | null {
    return this.row(settingSchema, "SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
  }

  setText(key: string, value: string | null): void {
    if (value === null) this.sql("DELETE FROM settings WHERE key = ?").run(key);
    else this.putSetting(key, value);
  }

  private putSetting(key: string, value: string): void {
    this.sql(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  duePermitIds(now: string): string[] {
    return this.rows(
      dueSchema,
      `SELECT id, jurisdiction_id AS jurisdictionId FROM permits WHERE monitoring_enabled = 1
      AND (next_due_at IS NULL OR next_due_at <= ?) ORDER BY next_due_at`,
      now,
    ).flatMap((row) => (isManualJurisdiction(row.jurisdictionId) ? [] : [row.id]));
  }

  deferDue(id: string, slot: Date): void {
    const value = slot.toISOString();
    this.sql("UPDATE permits SET next_due_at = ? WHERE id = ? AND (next_due_at IS NULL OR next_due_at < ?)").run(
      value,
      id,
      value,
    );
  }

  removePermit(id: string): boolean {
    return this.sql("DELETE FROM permits WHERE id = ?").run(id).changes === 1;
  }

  alignSchedule(now: Date): void {
    const slot = nextSlotAfter(now, this.getCheckTimes()).toISOString();
    this.sql("UPDATE permits SET next_due_at = ? WHERE next_due_at > ?").run(slot, slot);
  }

  setProjectNumber(id: string, projectNumber: string | null): boolean {
    return (
      this.sql("UPDATE permits SET project_number = ? WHERE id = ?").run(projectNumber?.trim() || null, id).changes ===
      1
    );
  }

  setPermitMonitoring(id: string, enabled: boolean): void {
    const permit = this.getPermit(id);

    if (enabled && permit && isManualJurisdiction(permit.jurisdictionId)) throw new Error("Permit is checked by hand");
    this.sql("UPDATE permits SET monitoring_enabled = ?, next_due_at = ? WHERE id = ?").run(
      enabled ? 1 : 0,
      enabled ? new Date().toISOString() : null,
      id,
    );
  }
}
