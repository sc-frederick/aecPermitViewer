import { z } from "zod";
import { nextSlotAfter, type CheckTimes } from "../shared/schedule.js";
import { parseSharedList, type SharedList } from "./share-list.js";
import { ListTooLarge, openList, sealListAsync, type ShareService } from "./share-service.js";

/** How long the list has to sit unchanged, with no checks queued or running, before it is sent. */
export const PUBLISH_SETTLE_MS = 2 * 60_000;

/** How soon a failed publication or fetch is tried again. */
export const RETRY_MS = 15 * 60_000;

/** How long after each of the publisher's check times a follower asks for a newer copy; long enough for most runs. */
export const FOLLOW_DELAY_MS = 90 * 60_000;

/** How often a follower asks when the publisher has no check schedule. */
export const UNSCHEDULED_FOLLOW_MS = 3 * 3_600_000;

type Report = (operation: string, cause: unknown) => void;

/**
 * When a follower next fetches: FOLLOW_DELAY_MS after the earliest publisher check time whose fetch is still ahead, or
 * UNSCHEDULED_FOLLOW_MS from now when there is no schedule.
 */
export function nextFetchAt(schedule: CheckTimes | null, now: Date): Date {
  if (!schedule) return new Date(now.getTime() + UNSCHEDULED_FOLLOW_MS);

  return new Date(nextSlotAfter(new Date(now.getTime() - FOLLOW_DELAY_MS), schedule).getTime() + FOLLOW_DELAY_MS);
}

/** Result of a requested sync: why it failed, as Settings shows it, or null. */
export type SyncProblem = string | null;

/** Sends one app's list when it has changed and its checks have finished. */
export class SharePublisher {
  /** When the service last accepted the list from this app run. */
  publishedAt: string | null = null;
  /** Why the latest publication failed, until one succeeds. */
  problem: string | null = null;

  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastJson: string | null = null;
  private stopped = false;

  /**
   * @param buildList - The list to publish, as JSON; called once per attempt.
   * @param checking - Whether checks are queued or running; a publication waits for them to finish.
   * @param changed - Called when `publishedAt` or `problem` changes.
   */
  constructor(
    private readonly service: ShareService,
    private readonly writeKey: string,
    private readonly contentKey: Uint8Array,
    private readonly buildList: () => string | Promise<string>,
    private readonly checking: () => boolean,
    private readonly changed: () => void,
    private readonly report: Report,
  ) {}

  /** The list changed: send it once it has gone PUBLISH_SETTLE_MS without another change and no checks are left. */
  notify(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(PUBLISH_SETTLE_MS);
  }

  /**
   * Sends the list now, even if unchanged, after any publication under way. Resolves with the failure message or null;
   * does nothing once stopped.
   */
  async syncNow(): Promise<SyncProblem> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;

    if (this.stopped) return null;
    const attempt = this.publish(true);
    this.running = attempt
      .then(() => undefined)
      .finally(() => {
        this.running = null;
      });

    return attempt;
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

      if (this.checking()) {
        this.schedule(PUBLISH_SETTLE_MS);

        return;
      }

      this.running = this.publish(false)
        .then(() => undefined)
        .finally(() => {
          this.running = null;
        });
    }, delay);
    this.timer.unref();
  }

  private setState(publishedAt: string | null, problem: string | null): void {
    if (publishedAt === this.publishedAt && problem === this.problem) return;
    this.publishedAt = publishedAt;
    this.problem = problem;
    this.changed();
  }

  private async publish(force: boolean): Promise<SyncProblem> {
    let json: string;

    try {
      json = await this.buildList();
    } catch (cause) {
      this.report("share:build", cause);
      this.setState(this.publishedAt, "Couldn't read the list to share. Retrying.");
      this.schedule(RETRY_MS);

      return this.problem;
    }

    if ((json === this.lastJson && !force) || this.stopped) return null;

    try {
      const reply = await this.service.publish(this.writeKey, await sealListAsync(json, this.contentKey));

      if (this.stopped) return null;

      if (reply._tag === "retry") {
        this.schedule(reply.afterSeconds * 1000);

        return `The list was just sent. Try again in ${reply.afterSeconds} seconds.`;
      }

      this.lastJson = json;
      this.setState(reply.publishedAt, null);

      return null;
    } catch (cause) {
      if (this.stopped) return null;
      this.report("share:publish", cause);
      this.setState(
        this.publishedAt,
        cause instanceof ListTooLarge
          ? "The list is too large to share."
          : "Couldn't reach the sharing service. Retrying.",
      );
      this.schedule(RETRY_MS);

      return this.problem;
    }
  }
}

/** The last list a follower received, kept so the app shows it at start without waiting for the network. */
export const cachedListSchema = z.object({
  revision: z.number().int().positive(),
  publishedAt: z.string(),
  json: z.string(),
});

/** The followed list as last received: its revision, publication time, and decrypted JSON. */
export type CachedList = z.infer<typeof cachedListSchema>;

/** A first fetch with a new share code: the list it opens, or why it doesn't open one. */
export type Probe =
  { _tag: "ok"; cache: CachedList } | { _tag: "absent" } | { _tag: "undecryptable" } | { _tag: "unreadable" };

const FOLLOW_PROBLEMS: Record<FollowFailure, string> = {
  absent: "The shared list was removed. Ask for a new code.",
  undecryptable: "This code no longer opens the shared list. Ask for a new code.",
  unreadable: "This shared list needs a newer version of Permit Monitor.",
  unreachable: "Couldn't reach the sharing service. Retrying.",
  persistence: "Couldn't save the shared list locally. Retrying.",
};

function readList(
  sealed: Uint8Array,
  contentKey: Uint8Array,
): { _tag: "ok"; json: string; list: SharedList } | { _tag: "undecryptable" } | { _tag: "unreadable" } {
  const opened = openList(sealed, contentKey);

  if (opened._tag !== "ok") return opened;

  try {
    return { _tag: "ok", json: opened.json, list: parseSharedList(opened.json) };
  } catch {
    return { _tag: "unreadable" };
  }
}

type FollowFailure = "absent" | "undecryptable" | "unreadable" | "unreachable" | "persistence";

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
  private failure: FollowFailure | null = null;
  private revision: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  /**
   * @param cached - The list received earlier, shown until a fetch brings a newer one. A cache that doesn't parse is
   *   reported and ignored.
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

  /** Why the latest fetch didn't bring a list, until one does. */
  get problem(): string | null {
    return this.failure ? FOLLOW_PROBLEMS[this.failure] : null;
  }

  /** Fetches now, then after each of the publisher's check times (see nextFetchAt). */
  start(): void {
    void this.refresh();
  }

  /** Fetches after the publisher's next check time, for a list that was fetched at `checkedAt`. */
  startFetched(checkedAt: string): void {
    this.checkedAt = checkedAt;
    this.planNext();
  }

  /** Stops fetching. A fetch under way finishes, but its result is ignored. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * Asks for a newer list now, and plans the next automatic fetch from the list it has afterward. A call while a fetch
   * is under way shares it. Resolves with why it didn't bring a list, if it didn't. Never rejects.
   */
  refresh(): Promise<SyncProblem> {
    this.running ??= this.fetch().finally(() => {
      this.running = null;
      this.planNext();
    });

    return this.running.then(() => this.problem);
  }

  private planNext(): void {
    if (this.stopped) return;

    if (this.timer) clearTimeout(this.timer);
    const now = new Date();

    const next =
      this.failure === "unreachable" || this.failure === "persistence"
        ? new Date(now.getTime() + RETRY_MS)
        : nextFetchAt(this.list?.schedule ?? null, now);

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }

  private async fetch(): Promise<void> {
    try {
      const reply = await this.service.fetch(this.readToken, this.revision);

      if (this.stopped) return;
      this.checkedAt = new Date().toISOString();

      if (reply._tag === "absent") {
        this.failure = "absent";
      } else if (reply._tag === "unchanged") {
        this.failure = null;
      } else {
        const read = readList(reply.sealed, this.contentKey);

        if (read._tag === "ok") {
          try {
            this.save({ revision: reply.revision, publishedAt: reply.publishedAt, json: read.json });
          } catch (cause) {
            this.report("share:save-cache", cause);
            this.failure = "persistence";
            this.changed();

            return;
          }

          const before = this.list;
          this.list = read.list;
          this.revision = reply.revision;
          this.publishedAt = reply.publishedAt;
          this.failure = null;
          this.updated(before, read.list);
        } else {
          this.failure = read._tag;
        }
      }
    } catch (cause) {
      if (this.stopped) return;
      this.report("share:fetch", cause);
      this.failure = "unreachable";
    }

    this.changed();
  }
}
