import * as z from "zod/mini";

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlRow {
  readonly [column: string]: SqlValue;
}

export interface RoomStorage {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): SqlRow[] } };
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

export const RETENTION_MS = 180 * 86_400_000;

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

function firstRevision(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));

  return (high & 0xffff) * 2 ** 32 + low + 1;
}

const tableCountSchema = z.object({ tables: z.number() });

export class ShareRoom {
  constructor(private readonly storage: RoomStorage) {}

  private hasTable(): boolean {
    const row = this.storage.sql
      .exec("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name = 'list'")
      .toArray()[0];

    return tableCountSchema.parse(row).tables > 0;
  }

  private latest(): { revision: number; publishedAt: string } | null {
    if (!this.hasTable()) return null;
    const row = this.storage.sql.exec("SELECT revision, published_at FROM list WHERE id = 1").toArray()[0];

    if (!row) return null;
    const parsed = storedRevisionSchema.parse(row);

    return { revision: parsed.revision, publishedAt: parsed.published_at };
  }

  exists(): boolean {
    return this.latest() !== null;
  }

  async publish(body: ArrayBuffer, now: number): Promise<PublishResult> {
    const latest = this.latest();

    if (latest) {
      const wait = Date.parse(latest.publishedAt) + MIN_PUBLISH_INTERVAL_MS - now;

      if (wait > 0) return { _tag: "too_soon", retryAfterSeconds: Math.ceil(wait / 1000) };
    }

    const revision = latest ? latest.revision + 1 : firstRevision();
    const publishedAt = new Date(now).toISOString();
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS list (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      body BLOB NOT NULL
    )`);
    this.storage.sql.exec(
      `INSERT INTO list (id, revision, published_at, body) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, published_at = excluded.published_at, body = excluded.body`,
      revision,
      publishedAt,
      body,
    );
    await this.storage.setAlarm(now + RETENTION_MS);

    return { _tag: "published", revision, publishedAt };
  }

  read(knownRevision: number | null): ReadResult {
    const latest = this.latest();

    if (!latest) return { _tag: "absent" };

    if (latest.revision === knownRevision) return { _tag: "unchanged", revision: latest.revision };
    const row = this.storage.sql.exec("SELECT revision, published_at, body FROM list WHERE id = 1").toArray()[0];

    if (!row) return { _tag: "absent" };
    const parsed = storedListSchema.parse(row);

    return { _tag: "found", revision: parsed.revision, publishedAt: parsed.published_at, body: parsed.body };
  }

  async remove(): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }
}
