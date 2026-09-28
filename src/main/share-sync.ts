// Keeps a shared list current on both ends: the publisher sends its list after changes, at most once a minute, and a
// follower fetches it every few minutes. Neither ever throws into the app; problems become a short message for Settings.
import { z } from "zod";
import { parseSharedList, type SharedList } from "./share-list.js";
import { ListTooLarge, openList, sealList, type ShareService } from "./share-service.js";

/** A publication waits this long after a change, so a burst of changes goes out together. */
const PUBLISH_SETTLE_MS = 3_000;

/** The shortest gap between publications. */
export const PUBLISH_INTERVAL_MS = 60_000;

/** How soon a failed publication or fetch is tried again. */
export const RETRY_MS = 5 * 60_000;

/** How often a follower asks for a newer list. */
export const FOLLOW_INTERVAL_MS = 5 * 60_000;

type Report = (operation: string, cause: unknown) => void;

/** Sends one app's list whenever it has changed since the last publication. */
export class SharePublisher {
  /** When the service last accepted the list from this app run. */
  publishedAt: string | null = null;
  /** Why the latest publication failed, until one succeeds. */
  problem: string | null = null;

  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastJson: string | null = null;
  private lastAttemptAt = 0;
  private stopped = false;

  /**
   * @param buildList - The list to publish, as JSON; called at most once per publication.
   * @param changed - `publishedAt` or `problem` changed.
   */
  constructor(
    private readonly service: ShareService,
    private readonly writeKey: string,
    private readonly contentKey: Uint8Array,
    private readonly buildList: () => string,
    private readonly changed: () => void,
    private readonly report: Report,
  ) {}

  /** Something in the list may have changed: publish soon, once the interval since the last attempt has passed. */
  notify(): void {
    this.schedule(Math.max(PUBLISH_SETTLE_MS, this.lastAttemptAt + PUBLISH_INTERVAL_MS - Date.now()));
  }

  /** Stops publishing. A publication under way finishes, but its result is ignored. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.publish().finally(() => { this.running = null; });
    }, delay);
    this.timer.unref();
  }

  private setState(publishedAt: string | null, problem: string | null): void {
    if (publishedAt === this.publishedAt && problem === this.problem) return;
    this.publishedAt = publishedAt;
    this.problem = problem;
    this.changed();
  }

  private async publish(): Promise<void> {
    this.lastAttemptAt = Date.now();
    let json: string;

    try {
      json = this.buildList();
    } catch (cause) {
      this.report("share:build", cause);
      this.setState(this.publishedAt, "Couldn't read the list to share. Retrying.");
      this.schedule(RETRY_MS);

      return;
    }

    if (json === this.lastJson) return;

    try {
      const reply = await this.service.publish(this.writeKey, sealList(json, this.contentKey));

      if (this.stopped) return;

      if (reply._tag === "retry") {
        this.schedule(reply.afterSeconds * 1000);

        return;
      }

      this.lastJson = json;
      this.setState(reply.publishedAt, null);
    } catch (cause) {
      if (this.stopped) return;
      this.report("share:publish", cause);
      this.setState(this.publishedAt, cause instanceof ListTooLarge
        ? "The list is too large to share." : "Couldn't reach the sharing service. Retrying.");
      this.schedule(RETRY_MS);
    }
  }
}

/** The last list a follower received, kept so the app shows it at start without waiting for the network. */
export const cachedListSchema = z.object({ revision: z.number().int().positive(), publishedAt: z.string(), json: z.string() });

export type CachedList = z.infer<typeof cachedListSchema>;

/** A first fetch with a new share code: the list it opens, or why it doesn't open one. */
export type Probe =
  | { _tag: "ok"; cache: CachedList }
  | { _tag: "absent" }
  | { _tag: "undecryptable" }
  | { _tag: "unreadable" };

/** Why a fetched list can't be shown, as Settings says it. */
const FOLLOW_PROBLEMS = {
  absent: "The shared list was removed. Ask for a new code.",
  undecryptable: "This code no longer opens the shared list. Ask for a new code.",
  unreadable: "This shared list needs a newer version of Permit Monitor.",
  unreachable: "Couldn't reach the sharing service. Retrying.",
} as const;

/** Opens and parses a fetched list. */
function readList(sealed: Uint8Array, contentKey: Uint8Array): { _tag: "ok"; json: string; list: SharedList } | { _tag: "undecryptable" } | { _tag: "unreadable" } {
  const opened = openList(sealed, contentKey);

  if (opened._tag !== "ok") return opened;

  try {
    return { _tag: "ok", json: opened.json, list: parseSharedList(opened.json) };
  } catch {
    return { _tag: "unreadable" };
  }
}

/** Fetches the list a share code opens, without following it. Rejects when the service can't be reached. */
export async function probeShare(service: ShareService, readToken: string, contentKey: Uint8Array): Promise<Probe> {
  const reply = await service.fetch(readToken, null);

  if (reply._tag !== "found") return { _tag: "absent" };
  const read = readList(reply.sealed, contentKey);

  if (read._tag !== "ok") return read;

  return { _tag: "ok", cache: { revision: reply.revision, publishedAt: reply.publishedAt, json: read.json } };
}

/** Keeps a followed list current. */
export class ShareFollower {
  /** The latest list, or null before one has been read. */
  list: SharedList | null = null;
  /** When the publisher sent the list shown. */
  publishedAt: string | null = null;
  /** When this app last heard from the service about the list. */
  checkedAt: string | null = null;
  /** Why the latest fetch didn't bring a list, until one does. */
  problem: string | null = null;

  private revision: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  /**
   * @param cached - The list received earlier, shown until a fetch brings a newer one. A cache that no longer parses is
   *   ignored.
   * @param save - Keeps a newly received list for the next start.
   * @param updated - A newer list replaced `before` (null when none was shown).
   * @param changed - Anything the window shows about the list changed.
   */
  constructor(
    private readonly service: ShareService,
    private readonly readToken: string,
    private readonly contentKey: Uint8Array,
    cached: CachedList | null,
    private readonly save: (cache: CachedList) => void,
    private readonly updated: (before: SharedList | null, after: SharedList) => void,
    private readonly changed: () => void,
    private readonly report: Report,
  ) {
    if (!cached) return;

    try {
      this.list = parseSharedList(cached.json);
      this.revision = cached.revision;
      this.publishedAt = cached.publishedAt;
    } catch (cause) {
      report("share:cache", cause);
    }
  }

  /** Fetches now, then every FOLLOW_INTERVAL_MS. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, FOLLOW_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Asks for a newer list. A call while a fetch is under way shares it. Never rejects. */
  refresh(): Promise<void> {
    this.running ??= this.fetch().finally(() => { this.running = null; });

    return this.running;
  }

  private async fetch(): Promise<void> {
    try {
      const reply = await this.service.fetch(this.readToken, this.revision);

      if (this.stopped) return;
      this.checkedAt = new Date().toISOString();

      if (reply._tag === "absent") {
        this.problem = FOLLOW_PROBLEMS.absent;
      } else if (reply._tag === "unchanged") {
        this.problem = null;
      } else {
        const read = readList(reply.sealed, this.contentKey);

        if (read._tag === "ok") {
          const before = this.list;
          this.list = read.list;
          this.revision = reply.revision;
          this.publishedAt = reply.publishedAt;
          this.problem = null;
          this.save({ revision: reply.revision, publishedAt: reply.publishedAt, json: read.json });
          this.updated(before, read.list);
        } else {
          this.problem = FOLLOW_PROBLEMS[read._tag];
        }
      }
    } catch (cause) {
      if (this.stopped) return;
      this.report("share:fetch", cause);
      this.problem = FOLLOW_PROBLEMS.unreachable;
    }

    this.changed();
  }
}
