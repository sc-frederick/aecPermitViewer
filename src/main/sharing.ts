import { randomBytes } from "node:crypto";
import type { BridgeResult, ShareState } from "../shared/bridge.js";
import type { ObservationRow, PermitHistory, PermitRow } from "../shared/permit.js";
import { CONTENT_KEY_BYTES, formatShareCode, fromBase64Url, parseShareCode, readTokenFor, toBase64Url, WRITE_KEY_BYTES, type ShareCode } from "../shared/share-protocol.js";
import { buildSharedList, type SharedList } from "./share-list.js";
import type { ShareService } from "./share-service.js";
import { cachedListSchema, probeShare, ShareFollower, SharePublisher, type CachedList } from "./share-sync.js";
import type { PermitStore } from "./store.js";

/** Settings rows. The keys sit beside the permit data they protect, which the same database already holds in the clear. */
const SETTINGS = {
  writeKey: "share_write_key",
  contentKey: "share_content_key",
  followCode: "share_follow_code",
  followCache: "share_follow_cache",
} as const;

/** What sharing needs from the rest of main. */
export interface SharingHost {
  /** Something the window shows about sharing, or the followed list itself, changed. */
  changed(): void;
  /** A newer followed list replaced `before`. */
  listUpdated(before: SharedList | null, after: SharedList): void;
  report(operation: string, cause: unknown): void;
}

interface Publishing {
  readonly writeKey: string;
  readonly code: string;
  readonly publisher: SharePublisher;
}

const ok: BridgeResult<null> = { ok: true, value: null };

function problem(error: string): BridgeResult<null> {
  return { ok: false, error };
}

/**
 * Sharing this app's list, or following another's. The two are exclusive: a follower's window shows the followed list
 * in place of its own, and its own permits aren't checked meanwhile, so there would be nothing current to share.
 */
export class Sharing {
  private publishing: Publishing | null = null;
  private follower: ShareFollower | null = null;

  /** @param service - The sharing service, or null when this build has none. */
  constructor(private readonly store: PermitStore, private readonly service: ShareService | null, private readonly host: SharingHost) {}

  /** Resumes sharing or following as it was when the app last closed. */
  async start(): Promise<void> {
    if (!this.service) return;
    const writeKey = this.store.getText(SETTINGS.writeKey);
    const contentKey = fromBase64Url(this.store.getText(SETTINGS.contentKey) ?? "", CONTENT_KEY_BYTES);

    if (writeKey && contentKey) await this.startPublishing(this.service, writeKey, contentKey);
    const code = parseShareCode(this.store.getText(SETTINGS.followCode) ?? "");

    if (code && !this.publishing) this.startFollowing(this.service, code, this.cachedList());
  }

  /** Stops publishing and fetching. A publication or fetch under way finishes first. */
  async stop(): Promise<void> {
    await Promise.all([this.publishing?.publisher.stop(), this.follower?.stop()]);
  }

  get following(): boolean {
    return this.follower !== null;
  }

  state(): ShareState {
    if (this.publishing) {
      const { code, publisher } = this.publishing;

      return { mode: "sharing", code, publishedAt: publisher.publishedAt, problem: publisher.problem };
    }

    if (this.follower) {
      const { publishedAt, checkedAt, problem: followProblem } = this.follower;

      return { mode: "following", publishedAt, checkedAt, problem: followProblem };
    }

    return { mode: "off", available: this.service !== null };
  }

  /** This app's list may have changed; a shared list is sent again if it did. */
  listChanged(): void {
    this.publishing?.publisher.notify();
  }

  /** The share code, while sharing. */
  code(): string | null {
    return this.publishing?.code ?? null;
  }

  /** The followed list's permits, in the publisher's order. */
  permits(): readonly PermitRow[] {
    return this.follower?.list?.permits ?? [];
  }

  permit(id: string): PermitRow | null {
    return this.permits().find((permit) => permit.id === id) ?? null;
  }

  history(permitId: string): PermitHistory | null {
    return this.follower?.list?.histories.get(permitId) ?? null;
  }

  /** A followed permit's observation, with that permit, so its record link can be checked against its jurisdiction. */
  observation(id: string): { observation: ObservationRow; permit: PermitRow } | null {
    for (const permit of this.permits()) {
      const observation = this.history(permit.id)?.observations.find((entry) => entry.id === id);

      if (observation) return { observation, permit };
    }

    return null;
  }

  async startSharing(): Promise<BridgeResult<null>> {
    if (!this.service) return problem("Sharing isn't available in this build.");

    if (this.follower) return problem("Stop following the shared list first.");

    if (this.publishing) return ok;
    const writeKey = toBase64Url(randomBytes(WRITE_KEY_BYTES));
    const contentKey = new Uint8Array(randomBytes(CONTENT_KEY_BYTES));
    this.store.setText(SETTINGS.writeKey, writeKey);
    this.store.setText(SETTINGS.contentKey, toBase64Url(contentKey));
    await this.startPublishing(this.service, writeKey, contentKey);
    this.host.changed();

    return ok;
  }

  /** Deletes the shared copy first, so the code stops working; sharing carries on if that fails. */
  async stopSharing(): Promise<BridgeResult<null>> {
    const publishing = this.publishing;

    if (!publishing || !this.service) return ok;
    // A publication after the deletion would bring the list back, so publishing stops before it.
    await publishing.publisher.stop();

    try {
      await this.service.remove(publishing.writeKey);
    } catch (cause) {
      this.host.report("share:remove", cause);
      this.publishing = null;
      await this.startPublishing(this.service, publishing.writeKey, fromBase64Url(this.store.getText(SETTINGS.contentKey) ?? "", CONTENT_KEY_BYTES));

      return problem("Couldn't remove the shared copy, so it's still shared. Try again.");
    }

    this.publishing = null;
    this.store.setText(SETTINGS.writeKey, null);
    this.store.setText(SETTINGS.contentKey, null);
    this.host.changed();

    return ok;
  }

  /** Follows the list a code opens, once a first fetch shows it does. */
  async follow(input: string): Promise<BridgeResult<null>> {
    if (!this.service) return problem("Sharing isn't available in this build.");

    if (this.publishing) return problem("Stop sharing your list first.");
    const code = parseShareCode(input);

    if (!code) return problem("That isn't a share code. Codes start with PMS1-.");
    let probe: Awaited<ReturnType<typeof probeShare>>;

    try {
      probe = await probeShare(this.service, code.readToken, code.contentKey);
    } catch (cause) {
      this.host.report("share:follow", cause);

      return problem("Couldn't reach the sharing service. Try again.");
    }

    switch (probe._tag) {
      case "absent": return problem("No shared list uses that code.");
      case "undecryptable": return problem("That code doesn't open the shared list. Copy it again.");
      case "unreadable": return problem("This shared list needs a newer version of Permit Monitor.");
      case "ok": break;
    }

    await this.follower?.stop();
    this.store.setText(SETTINGS.followCode, input.trim());
    this.store.setText(SETTINGS.followCache, JSON.stringify(probe.cache));
    this.startFollowing(this.service, code, probe.cache);
    this.host.changed();

    return ok;
  }

  async stopFollowing(): Promise<BridgeResult<null>> {
    await this.follower?.stop();
    this.follower = null;
    this.store.setText(SETTINGS.followCode, null);
    this.store.setText(SETTINGS.followCache, null);
    this.host.changed();

    return ok;
  }

  async refresh(): Promise<BridgeResult<null>> {
    await this.follower?.refresh();

    return ok;
  }

  /** Deletes the shared copy as part of deleting local data. Failures are reported and otherwise ignored. */
  async removeSharedCopy(): Promise<void> {
    const publishing = this.publishing;

    if (!publishing || !this.service) return;
    await publishing.publisher.stop();
    await this.service.remove(publishing.writeKey).catch((cause: unknown) => this.host.report("share:remove", cause));
  }

  private async startPublishing(service: ShareService, writeKey: string, contentKey: Uint8Array | null): Promise<void> {
    const readToken = await readTokenFor(writeKey);
    const code = readToken && contentKey ? formatShareCode(readToken, contentKey) : null;

    if (!code || !contentKey) return;

    const publisher = new SharePublisher(service, writeKey, contentKey,
      () => buildSharedList(this.store.listPermits(), (id) => this.store.history(id)),
      () => this.host.changed(), (operation, cause) => this.host.report(operation, cause));

    this.publishing = { writeKey, code, publisher };
    publisher.notify();
  }

  private startFollowing(service: ShareService, code: ShareCode, cached: CachedList | null): void {
    this.follower = new ShareFollower(service, code.readToken, code.contentKey, cached,
      (cache) => this.store.setText(SETTINGS.followCache, JSON.stringify(cache)),
      (before, after) => this.host.listUpdated(before, after),
      () => this.host.changed(), (operation, cause) => this.host.report(operation, cause));
    this.follower.start();
  }

  private cachedList(): CachedList | null {
    const text = this.store.getText(SETTINGS.followCache);

    if (!text) return null;

    try {
      return cachedListSchema.parse(JSON.parse(text));
    } catch (cause) {
      this.host.report("share:cache", cause);

      return null;
    }
  }
}
