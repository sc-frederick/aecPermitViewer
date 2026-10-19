import * as z from "zod/mini";
import { SHARE_BODY_MAX_BYTES } from "../../../src/shared/share-protocol.js";
import type { RoomStorage } from "./room.js";

const MINUTE_MS = 60_000;

const DAY_MS = 86_400_000;

const positiveLimit = z.coerce.number().check(z.int(), z.positive(), z.maximum(1_000_000));

/** Parsed deployment limits, configured with the corresponding Wrangler variables. */
export const admissionLimitsSchema = z.object({
  sourceWritesPerMinute: positiveLimit,
  sourceCreationsPerDay: positiveLimit,
  deploymentCreationsPerDay: positiveLimit,
  registeredRooms: positiveLimit,
  trackedSources: positiveLimit,
});

/** The validated limits used by an admission budget. */
export type AdmissionLimits = z.infer<typeof admissionLimitsSchema>;

/** Defaults mirrored in wrangler.jsonc; tests use the same production policy unless they lower a limit. */
export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  sourceWritesPerMinute: 60,
  sourceCreationsPerDay: 5,
  deploymentCreationsPerDay: 100,
  registeredRooms: 1024,
  trackedSources: 4096,
};

/** A quota rejection. Creation-only rejections still let an existing room with no admission record (legacy) update. */
export type AdmissionDenied = {
  readonly _tag: "denied";
  readonly reason: "source_writes" | "tracked_sources" | "source_creations" | "deployment_creations" | "room_capacity";
  readonly retryAfterSeconds: number;
};

/** Admission before reading the request body, or the atomic reservation immediately before a new room is written. */
export type AdmissionResult = { readonly _tag: "allowed"; readonly registered: boolean } | AdmissionDenied;

/** The narrow admission port reached by the HTTP router. */
export interface AdmissionApi {
  check(roomName: string, source: string): Promise<AdmissionResult>;
  register(roomName: string, source: string): Promise<AdmissionResult>;
}

const countSchema = z.object({ count: z.number() });

const sourceSchema = z.object({
  write_window: z.number(),
  writes: z.number(),
  creation_window: z.number(),
  creations: z.number(),
});

const deploymentSchema = z.object({ creation_window: z.number(), creations: z.number() });

function denied(reason: AdmissionDenied["reason"], until: number, now: number): AdmissionDenied {
  return { _tag: "denied", reason, retryAfterSeconds: Math.max(1, Math.min(3600, Math.ceil((until - now) / 1000))) };
}

/**
 * Strongly consistent, bounded SQLite admission policy. Each operation runs its SQL without an await, so Durable
 * Object input/output gates make the read/check/write sequence atomic across concurrent callers and object restarts.
 */
export class ShareAdmission {
  /** Initializes the fixed coordinator schema; limits must already have passed admissionLimitsSchema. */
  constructor(
    private readonly storage: RoomStorage,
    private readonly limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS,
  ) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS admitted_rooms (name TEXT PRIMARY KEY)");
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS admission_sources (
      source TEXT PRIMARY KEY, write_window INTEGER NOT NULL, writes INTEGER NOT NULL,
      creation_window INTEGER NOT NULL, creations INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS admission_deployment (
      id INTEGER PRIMARY KEY CHECK (id = 1), creation_window INTEGER NOT NULL, creations INTEGER NOT NULL
    )`);
  }

  private registered(name: string): boolean {
    return this.storage.sql.exec("SELECT name FROM admitted_rooms WHERE name = ?", name).toArray().length > 0;
  }

  private source(source: string, now: number): z.infer<typeof sourceSchema> | AdmissionDenied {
    const minute = Math.floor(now / MINUTE_MS);
    const day = Math.floor(now / DAY_MS);
    this.storage.sql.exec("DELETE FROM admission_sources WHERE creation_window < ? AND write_window < ?", day, minute);

    const row = this.storage.sql
      .exec("SELECT write_window, writes, creation_window, creations FROM admission_sources WHERE source = ?", source)
      .toArray()[0];

    if (row) return sourceSchema.parse(row);

    const tracked = countSchema.parse(
      this.storage.sql.exec("SELECT count(*) AS count FROM admission_sources").toArray()[0],
    ).count;

    if (tracked >= this.limits.trackedSources) return denied("tracked_sources", (day + 1) * DAY_MS, now);
    this.storage.sql.exec("INSERT INTO admission_sources VALUES (?, ?, 0, ?, 0)", source, minute, day);

    return { write_window: minute, writes: 0, creation_window: day, creations: 0 };
  }

  private creationLimit(source: z.infer<typeof sourceSchema>, now: number): AdmissionDenied | null {
    const day = Math.floor(now / DAY_MS);
    const until = (day + 1) * DAY_MS;

    if (source.creation_window === day && source.creations >= this.limits.sourceCreationsPerDay)
      return denied("source_creations", until, now);

    const row = this.storage.sql
      .exec("SELECT creation_window, creations FROM admission_deployment WHERE id = 1")
      .toArray()[0];

    const deployment = row ? deploymentSchema.parse(row) : null;

    if (deployment?.creation_window === day && deployment.creations >= this.limits.deploymentCreationsPerDay)
      return denied("deployment_creations", until, now);

    const rooms = countSchema.parse(
      this.storage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()[0],
    ).count;

    return rooms >= this.limits.registeredRooms ? denied("room_capacity", now + 3_600_000, now) : null;
  }

  /** Charges a write request before any room or body access; known rooms do not consume creation quotas. */
  check(name: string, source: string, now: number): AdmissionResult {
    const state = this.source(source, now);

    if ("_tag" in state) return state;
    const minute = Math.floor(now / MINUTE_MS);
    const writes = state.write_window === minute ? state.writes : 0;

    if (writes >= this.limits.sourceWritesPerMinute) return denied("source_writes", (minute + 1) * MINUTE_MS, now);
    this.storage.sql.exec(
      "UPDATE admission_sources SET write_window = ?, writes = ? WHERE source = ?",
      minute,
      writes + 1,
      source,
    );

    if (this.registered(name)) return { _tag: "allowed", registered: true };

    return this.creationLimit(state, now) ?? { _tag: "allowed", registered: false };
  }

  /**
   * Rechecks quotas after body validation and reserves the room's slot before its first publication. A room that is
   * already registered is allowed without charging again.
   */
  register(name: string, source: string, now: number): AdmissionResult {
    if (this.registered(name)) return { _tag: "allowed", registered: true };
    const state = this.source(source, now);

    if ("_tag" in state) return state;
    const limited = this.creationLimit(state, now);

    if (limited) return limited;
    const day = Math.floor(now / DAY_MS);
    const creations = state.creation_window === day ? state.creations : 0;
    this.storage.sql.exec("INSERT INTO admitted_rooms VALUES (?)", name);
    this.storage.sql.exec(
      "UPDATE admission_sources SET creation_window = ?, creations = ? WHERE source = ?",
      day,
      creations + 1,
      source,
    );
    this.storage.sql.exec(
      `INSERT INTO admission_deployment VALUES (1, ?, 1)
      ON CONFLICT(id) DO UPDATE SET creation_window = excluded.creation_window,
      creations = CASE WHEN admission_deployment.creation_window = excluded.creation_window THEN admission_deployment.creations + 1 ELSE 1 END`,
      day,
    );

    const registeredRooms = countSchema.parse(
      this.storage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()[0],
    ).count;

    console.info(
      JSON.stringify({
        event: "share_admitted",
        registeredRooms,
        roomCapacity: this.limits.registeredRooms,
        maximumCiphertextBytes: this.limits.registeredRooms * SHARE_BODY_MAX_BYTES,
      }),
    );

    return { _tag: "allowed", registered: true };
  }
}
