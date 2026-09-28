// One shared list: the latest encrypted copy its publisher sent, with a revision number that grows by one per
// publication. The room never sees the list's contents or any key; it stores and returns opaque bytes.
// zod/mini keeps the Worker bundle small; the full zod build is most of an otherwise ~10 KB Worker.
import * as z from "zod/mini";

/** A value SQLite storage accepts or returns: BLOBs come back as ArrayBuffer. */
export type SqlValue = string | number | null | ArrayBuffer;

/** A result row, keyed by column name. */
export interface SqlRow { readonly [column: string]: SqlValue }

/**
 * The part of a SQLite-backed Durable Object's storage the room uses. Cloudflare's DurableObjectStorage satisfies it
 * structurally, and tests supply one backed by node:sqlite. See
 * https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/.
 */
export interface RoomStorage {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): SqlRow[] } };
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

/** A list nobody has published to for this long is deleted, so abandoned shares don't stay stored forever. */
export const RETENTION_MS = 180 * 86_400_000;

/** The shortest gap between two publications. The app publishes at most once a minute. */
export const MIN_PUBLISH_INTERVAL_MS = 10_000;

export type PublishResult =
  | { readonly _tag: "published"; readonly revision: number; readonly publishedAt: string }
  | { readonly _tag: "too_soon"; readonly retryAfterSeconds: number };

export type ReadResult =
  | { readonly _tag: "absent" }
  | { readonly _tag: "unchanged"; readonly revision: number }
  | { readonly _tag: "found"; readonly revision: number; readonly publishedAt: string; readonly body: ArrayBuffer };

const storedRevisionSchema = z.object({
  revision: z.number().check(z.int(), z.positive()),
  published_at: z.string(),
});

const storedListSchema = z.extend(storedRevisionSchema, { body: z.instanceof(ArrayBuffer) });

const tableCountSchema = z.object({ tables: z.number() });

/**
 * The room's rules over its storage. Every method runs its SQL synchronously, so calls never interleave mid-write.
 * Only publishing creates the table, so a read with a token nobody published to stores nothing, and a room emptied by
 * `remove` or its retention alarm stays empty until the next publication.
 */
export class ShareRoom {
  constructor(private readonly storage: RoomStorage) {}

  private hasTable(): boolean {
    const row = this.storage.sql.exec("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name = 'list'").toArray()[0];

    return tableCountSchema.parse(row).tables > 0;
  }

  private latest(): { revision: number; publishedAt: string } | null {
    if (!this.hasTable()) return null;
    const row = this.storage.sql.exec("SELECT revision, published_at FROM list WHERE id = 1").toArray()[0];

    if (!row) return null;
    const parsed = storedRevisionSchema.parse(row);

    return { revision: parsed.revision, publishedAt: parsed.published_at };
  }

  /** Replaces the stored list and pushes its deletion date back, unless the last publication was too recent. */
  async publish(body: ArrayBuffer, now: number): Promise<PublishResult> {
    const latest = this.latest();

    if (latest) {
      const wait = Date.parse(latest.publishedAt) + MIN_PUBLISH_INTERVAL_MS - now;

      if (wait > 0) return { _tag: "too_soon", retryAfterSeconds: Math.ceil(wait / 1000) };
    }

    const revision = (latest?.revision ?? 0) + 1;
    const publishedAt = new Date(now).toISOString();
    // One row: only the latest publication is kept.
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS list (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      body BLOB NOT NULL
    )`);
    this.storage.sql.exec(`INSERT INTO list (id, revision, published_at, body) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, published_at = excluded.published_at, body = excluded.body`,
    revision, publishedAt, body);
    await this.storage.setAlarm(now + RETENTION_MS);

    return { _tag: "published", revision, publishedAt };
  }

  /** The stored list, or only its revision when the caller already has that one. */
  read(knownRevision: number | null): ReadResult {
    const latest = this.latest();

    if (!latest) return { _tag: "absent" };

    if (latest.revision === knownRevision) return { _tag: "unchanged", revision: latest.revision };
    const row = this.storage.sql.exec("SELECT revision, published_at, body FROM list WHERE id = 1").toArray()[0];

    if (!row) return { _tag: "absent" };
    const parsed = storedListSchema.parse(row);

    return { _tag: "found", revision: parsed.revision, publishedAt: parsed.published_at, body: parsed.body };
  }

  /** Deletes the list and everything else the room stored. */
  async remove(): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }
}
