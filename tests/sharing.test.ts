import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { route } from "../infra/sync-server/src/router.js";
import { describeSharedUpdate } from "../src/main/notifications.js";
import { buildSharedList, buildSharedListAsync, parseSharedList, SHARED_HISTORY_DAYS, type SharedList } from "../src/main/share-list.js";
import { openList, parseServiceUrl, sealList, ShareService, type PublishReply } from "../src/main/share-service.js";
import { FOLLOW_DELAY_MS, nextFetchAt, PUBLISH_SETTLE_MS, SharePublisher, UNSCHEDULED_FOLLOW_MS } from "../src/main/share-sync.js";
import { Sharing, type SharingHost } from "../src/main/sharing.js";
import { PermitStore } from "../src/main/store.js";
import { HILLSBOROUGH_ID, type PermitHistory, type PermitRow } from "../src/shared/permit.js";
import { parseShareCode } from "../src/shared/share-protocol.js";
import { normalizeCheckTimes } from "../src/shared/schedule.js";
import { MemoryRooms } from "./fixtures/memory-rooms.js";
import { defined } from "./support/defined.js";

const directories: string[] = [];

function tempStore(): PermitStore {
  const directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-share-"));
  directories.push(directory);

  return new PermitStore(path.join(directory, "data.sqlite"));
}

/** Records a successful check showing `status`, as the check runner does. */
function observe(store: PermitStore, permitId: string, status: string): void {
  const runId = store.startRun({ permitId, appVersion: "0.0.0", playwrightVersion: "1", requestedModel: "m", promptVersion: "p" });

  store.finishRun({ runId, permitId, outcome: "success", actionCount: 0, requestCount: 0, actualModel: null, browserVersion: null,
    observation: { verifiedPermitNumber: "x", statusLabel: "Record Status:", statusValue: status, reviews: null,
      observedAt: new Date().toISOString(), recordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?id=1" } });
}

/** Holds back the service's answers to one kind of request until released. */
class Hold {
  /** Resolves when the first held request has been answered by the Worker, before its answer is sent. */
  readonly reached: Promise<void>;
  private readonly released: Promise<void>;
  private arrive = (): void => undefined;
  private open = (): void => undefined;

  constructor(readonly method: string) {
    this.reached = new Promise((resolve) => { this.arrive = resolve; });
    this.released = new Promise((resolve) => { this.open = resolve; });
  }

  wait(): Promise<void> {
    this.arrive();

    return this.released;
  }

  release(): void {
    this.open();
  }
}

/** The sync Worker's router behind a local HTTP server, as `wrangler dev` would serve it. */
async function serve(rooms: MemoryRooms, held: () => Hold | null = () => null): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();

      for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
        headers.append(defined(incoming.rawHeaders[index], "header name"), defined(incoming.rawHeaders[index + 1], "header value"));
      }

      const init: RequestInit = { method: incoming.method ?? "GET", headers };
      const body = Buffer.concat(chunks);

      if (body.length > 0) init.body = body;
      const response = await route(new Request(`http://127.0.0.1${incoming.url ?? "/"}`, init), rooms.directory, rooms.admission);
      const hold = held();

      if (hold && hold.method === init.method) await hold.wait();
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return server;
}

class RecordingHost implements SharingHost {
  changes = 0;
  /** Whether the host reports checks queued or running. */
  busy = false;
  readonly updates: Array<{ before: SharedList | null; after: SharedList }> = [];
  readonly reports: string[] = [];

  changed(): void {
    this.changes += 1;
  }

  checking(): boolean {
    return this.busy;
  }

  listUpdated(before: SharedList | null, after: SharedList): void {
    this.updates.push({ before, after });
  }

  report(operation: string): void {
    this.reports.push(operation);
  }
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shared list encryption", () => {
  const key = new Uint8Array(32).fill(3);

  it("opens what it sealed, and nothing sealed under another key or changed after", () => {
    const sealed = sealList('{"hello":"world"}', key);

    expect(openList(sealed, key)).toEqual({ _tag: "ok", json: '{"hello":"world"}' });
    expect(openList(sealed, new Uint8Array(32).fill(4))).toEqual({ _tag: "undecryptable" });
    const tampered = sealed.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(openList(tampered, key)).toEqual({ _tag: "undecryptable" });
    expect(openList(sealed.subarray(0, 10), key)).toEqual({ _tag: "undecryptable" });
  });

  it("uses a fresh nonce each time", () => {
    expect(sealList("same", key)).not.toEqual(sealList("same", key));
  });

  it("accepts HTTPS service URLs, and plain HTTP only on this computer", () => {
    expect(parseServiceUrl("https://permitmon-sync.example.workers.dev")?.href).toBe("https://permitmon-sync.example.workers.dev/");
    expect(parseServiceUrl("http://localhost:8787")).not.toBeNull();
    expect(parseServiceUrl("http://permitmon-sync.example.workers.dev")).toBeNull();
    expect(parseServiceUrl("https://user:pass@example.test")).toBeNull();
    expect(parseServiceUrl("")).toBeNull();
  });
});

describe("shared list format", () => {
  const permit: PermitRow = {
    id: "00000000-0000-4000-8000-000000000001", jurisdictionId: HILLSBOROUGH_ID, permitNumber: "HC-BLD-26-0087599",
    projectNumber: "28069", reviews: null, monitoringEnabled: true, lastStatus: "In Process",
    lastObservedAt: "2026-09-24T12:00:00.000Z", lastRecordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx",
    latestAttemptAt: "2026-09-24T12:00:00.000Z", latestOutcome: "success", nextDueAt: "2026-09-25T12:30:00.000Z", checking: true,
  };

  /** A check on each of `days` days, three a day, each with an observation. */
  function history(days: number): PermitHistory {
    const runs = Array.from({ length: days * 3 }, (_, index) => ({
      id: `r${index}`, permitId: permit.id, startedAt: new Date(Date.UTC(2026, 0, 1, 12) + Math.floor(index / 3) * 86_400_000 + index % 3 * 60_000).toISOString(),
      finishedAt: null, outcome: "success" as const, actionCount: 0, requestCount: 0,
    })).reverse();

    return { runs, observations: runs.map((run) => ({ id: `o${run.id}`, runId: run.id, permitId: permit.id, verifiedPermitNumber: "x",
      statusLabel: "Record Status:", statusValue: "In Process", reviews: null, observedAt: run.startedAt, recordUrl: "https://example.test" })) };
  }

  it("round-trips permits without their live check state, keeping one day's entry for each recent day", () => {
    const list = parseSharedList(buildSharedList([permit], () => history(200), ["08:30", "16:30"]));
    const shared = defined(list.permits[0], "the shared permit");

    expect(shared).toEqual({ ...permit, checking: false, nextDueAt: null });
    expect(list.schedule).toEqual(normalizeCheckTimes(["08:30", "16:30"]));
    expect(list.histories.get(permit.id)?.runs).toHaveLength(SHARED_HISTORY_DAYS);
    expect(list.histories.get(permit.id)?.observations).toHaveLength(SHARED_HISTORY_DAYS);
  });

  it("publishes identical wire bytes when history reads and serialization yield separately", async () => {
    const retained = history(200);

    const reviewHistory: PermitHistory = { ...retained, observations: retained.observations.map((entry) => ({ ...entry,
      reviews: [{ process: "Building", status: "Corrections Required", date: null, dueDate: null },
        { process: "Electrical", status: "Approved", date: null, dueDate: null }],
    })) };

    for (const permits of [[], [permit]]) {
      for (const schedule of [null, ["08:30", "16:30"]]) {
        const json = await buildSharedListAsync(permits, () => reviewHistory, schedule);
        expect(json).toBe(buildSharedList(permits, () => reviewHistory, schedule));
      }
    }
  });

  it("leaves out permits under jurisdictions this version doesn't know, and rejects other formats", () => {
    const json = buildSharedList([permit, { ...permit, id: "future", jurisdictionId: HILLSBOROUGH_ID }], () => history(1), null)
      .replace('"id":"future","jurisdictionId":"hillsborough-county-building"', '"id":"future","jurisdictionId":"some-new-county"');

    expect(parseSharedList(json).permits.map((entry) => entry.id)).toEqual([permit.id]);
    expect(() => parseSharedList(json.replace('"format":1', '"format":2'))).toThrow();
  });
});

describe("follower timing", () => {
  const schedule = defined(normalizeCheckTimes(["08:30", "16:30"]), "check times");

  it("asks FOLLOW_DELAY_MS after each of the publisher's check times, rolling to tomorrow", () => {
    expect(FOLLOW_DELAY_MS).toBe(90 * 60_000);
    expect(nextFetchAt(schedule, new Date(2026, 8, 28, 9, 0))).toEqual(new Date(2026, 8, 28, 10, 0));
    expect(nextFetchAt(schedule, new Date(2026, 8, 28, 10, 30))).toEqual(new Date(2026, 8, 28, 18, 0));
    expect(nextFetchAt(schedule, new Date(2026, 8, 28, 19, 0))).toEqual(new Date(2026, 8, 29, 10, 0));
  });

  it("asks every few hours when the publisher has no schedule", () => {
    const now = new Date(2026, 8, 28, 9, 0);

    expect(nextFetchAt(null, now)).toEqual(new Date(now.getTime() + UNSCHEDULED_FOLLOW_MS));
  });
});

describe("publisher timing", () => {
  /** A service that records when lists are published, and never fails. */
  class RecordingService extends ShareService {
    readonly publications: number[] = [];

    override async publish(): Promise<PublishReply> {
      this.publications.push(Date.now());

      return { _tag: "published", publishedAt: new Date().toISOString() };
    }
  }

  let target: RecordingService;
  let json: string;
  let publisher: SharePublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    target = new RecordingService(new URL("http://localhost"));
    json = "first";
    publisher = new SharePublisher(target, "key", new Uint8Array(32), () => json, () => false, () => undefined, () => undefined);
  });

  afterEach(async () => {
    await publisher.stop();
  });

  it("waits PUBLISH_SETTLE_MS after the latest change", async () => {
    publisher.notify();
    await vi.advanceTimersByTimeAsync(PUBLISH_SETTLE_MS - 1000);
    json = "second";
    publisher.notify();
    await vi.advanceTimersByTimeAsync(PUBLISH_SETTLE_MS - 1);
    expect(target.publications).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(target.publications).toHaveLength(1));
  });

  it("publishes nothing once stopped, even when asked to sync now", async () => {
    publisher.notify();
    await publisher.stop();
    expect(await publisher.syncNow()).toBeNull();
    await vi.advanceTimersByTimeAsync(PUBLISH_SETTLE_MS);
    expect(target.publications).toHaveLength(0);
  });
});

describe("sharing between two apps", () => {
  let rooms: MemoryRooms;
  let server: Server;
  let service: ShareService;
  let hold: Hold | null;

  beforeEach(async () => {
    rooms = new MemoryRooms();
    rooms.now = Date.now();
    hold = null;
    server = await serve(rooms, () => hold);
    service = new ShareService(defined(parseServiceUrl(`http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`), "service URL"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function published(sharing: Sharing, after: string | null = null): Promise<string> {
    await vi.waitFor(() => {
      const state = sharing.state();

      if (state.mode !== "sharing" || !state.publishedAt || state.publishedAt === after) throw new Error("not published yet");
    }, { timeout: 90_000, interval: 200 });
    const state = sharing.state();

    return state.mode === "sharing" && state.publishedAt ? state.publishedAt : "";
  }

  it("publishes an encrypted copy that a follower sees read-only and keeps current", async () => {
    const own = tempStore();
    const added = own.addPermit("HC-BLD-26-0087599", HILLSBOROUGH_ID);
    const permitId = added._tag === "ok" ? added.value : "";
    observe(own, permitId, "In Process");
    const publisherHost = new RecordingHost();
    const publisher = new Sharing(own, service, publisherHost);

    expect(publisher.state()).toEqual({ mode: "off", available: true });
    expect(await publisher.startSharing()).toEqual({ ok: true, value: null });
    const first = await published(publisher);
    const code = defined(publisher.code(), "share code");

    // The service holds only ciphertext.
    const stored = [...rooms.storages.values()].map((storage) => storage.sql.exec("SELECT body FROM list").toArray()[0]?.body);
    expect(stored).toHaveLength(1);
    expect(Buffer.from(z.instanceof(ArrayBuffer).parse(stored[0])).includes("HC-BLD")).toBe(false);

    const theirs = tempStore();
    const followerHost = new RecordingHost();
    const follower = new Sharing(theirs, service, followerHost);

    expect(await follower.follow("PMS1-not-a-code")).toEqual({ ok: false, error: "That isn't a share code. Codes start with PMS1-." });
    expect(await follower.follow(code)).toEqual({ ok: true, value: null });
    expect(follower.following).toBe(true);
    expect(follower.permits().map((permit) => [permit.permitNumber, permit.lastStatus])).toEqual([["HC-BLD-26-0087599", "In Process"]]);
    const observation = defined(follower.history(permitId)?.observations[0], "a shared observation");
    expect(follower.observation(observation.id)?.permit.id).toBe(permitId);
    expect(await follower.startSharing()).toEqual({ ok: false, error: "Stop following the shared list first." });
    expect(await publisher.follow(code)).toEqual({ ok: false, error: "Stop sharing your list first." });

    // Mid-run, the list waits for the checks to finish, then goes out as one publication.
    observe(own, permitId, "Issued");
    publisherHost.busy = true;
    publisher.listChanged();
    rooms.now += PUBLISH_SETTLE_MS * 3;
    await vi.advanceTimersByTimeAsync(PUBLISH_SETTLE_MS * 3);
    expect(publisher.state()).toMatchObject({ publishedAt: first });
    publisherHost.busy = false;
    await vi.advanceTimersByTimeAsync(PUBLISH_SETTLE_MS);
    const second = await published(publisher, first);

    // Sync now sends at once, even unchanged, and passes on the service's request to wait.
    rooms.now += 10_000;
    expect(await publisher.sync()).toEqual({ ok: true, value: null });
    expect(publisher.state()).not.toMatchObject({ publishedAt: second });
    expect(await publisher.sync()).toEqual({ ok: false, error: "The list was just sent. Try again in 10 seconds." });

    // The follower's sync brings the new status, with the notice the publisher got.
    expect(await follower.sync()).toEqual({ ok: true, value: null });
    const update = defined(followerHost.updates.at(-1), "an update");
    expect(describeSharedUpdate(defined(update.before, "the earlier list").permits, update.after.permits))
      .toMatchObject([{ kind: "status-changed", body: "“In Process” → “Issued”" }]);

    // A restart shows the last list before the network answers.
    const restarted = new Sharing(theirs, service, new RecordingHost());
    await restarted.start();
    expect(restarted.permits().map((permit) => permit.lastStatus)).toEqual(["Issued"]);
    await restarted.stop();

    // Stopping deletes the shared copy, and the follower hears it's gone.
    expect(await publisher.stopSharing()).toEqual({ ok: true, value: null });
    expect(publisher.state()).toEqual({ mode: "off", available: true });
    expect(await follower.sync()).toEqual({ ok: false, error: "The shared list was removed. Ask for a new code." });
    expect(follower.state()).toMatchObject({ mode: "following", problem: "The shared list was removed. Ask for a new code." });
    expect(follower.permits()).toHaveLength(1);

    expect(await follower.stopFollowing()).toEqual({ ok: true, value: null });
    expect(follower.following).toBe(false);
    expect(theirs.getText("share_follow_code")).toBeNull();
    await Promise.all([publisher.stop(), follower.stop()]);
    own.close();
    theirs.close();
  }, 30_000);

  it("runs share, follow, and sync one at a time, so none undoes another", async () => {
    const own = tempStore();
    own.addPermit("HC-BLD-26-0087599", HILLSBOROUGH_ID);
    const publisher = new Sharing(own, service, new RecordingHost());
    await publisher.startSharing();
    await published(publisher);
    const code = defined(publisher.code(), "share code");
    const readToken = defined(parseShareCode(code), "parsed code").readToken;

    // Share clicked while Follow's first fetch is under way: it waits for Follow, then refuses.
    const theirs = tempStore();
    const follower = new Sharing(theirs, service, new RecordingHost());
    const probe = new Hold("GET");
    hold = probe;
    const following = follower.follow(code);
    await probe.reached;
    const sharing = follower.startSharing();
    probe.release();
    expect(await following).toEqual({ ok: true, value: null });
    expect(await sharing).toEqual({ ok: false, error: "Stop following the shared list first." });
    expect(follower.state().mode).toBe("following");
    expect(theirs.getText("share_write_key")).toBeNull();

    // Sync now clicked while Stop sharing waits on the deletion: it can't bring the deleted list back.
    const deletion = new Hold("DELETE");
    hold = deletion;
    rooms.now += 60_000;
    const stopping = publisher.stopSharing();
    await deletion.reached;
    const syncing = publisher.sync();
    deletion.release();
    expect(await stopping).toEqual({ ok: true, value: null });
    expect(await syncing).toEqual({ ok: true, value: null });
    hold = null;
    expect(await service.fetch(readToken, null)).toEqual({ _tag: "absent" });
    expect(own.getText("share_write_key")).toBeNull();

    await Promise.all([publisher.stop(), follower.stop()]);
    own.close();
    theirs.close();
  }, 30_000);

  it("keeps sharing when the shared copy can't be deleted, and turns sharing off in a build without a service", async () => {
    const own = tempStore();
    const publisher = new Sharing(own, service, new RecordingHost());
    await publisher.startSharing();
    await published(publisher);
    rooms.failing = true;

    expect(await publisher.stopSharing()).toEqual({ ok: false, error: "Couldn't remove the shared copy, so it's still shared. Try again." });
    expect(publisher.state().mode).toBe("sharing");
    // The write key is the only way to delete the copy, so it stays until a deletion goes through.
    expect(own.getText("share_write_key")).not.toBeNull();
    rooms.failing = false;
    expect(await publisher.stopSharing()).toEqual({ ok: true, value: null });
    expect(own.getText("share_write_key")).toBeNull();
    await publisher.stop();

    const offline = new Sharing(own, null, new RecordingHost());
    await offline.start();
    expect(offline.state()).toEqual({ mode: "off", available: false });
    expect(await offline.startSharing()).toEqual({ ok: false, error: "Sharing isn't available in this build." });
    own.close();
  }, 30_000);
});

describe("sharing snapshot consistency", () => {
  class CapturingService extends ShareService {
    readonly lists: SharedList[] = [];

    override async publish(_writeKey: string, sealed: Uint8Array): Promise<PublishReply> {
      const opened = openList(sealed, new Uint8Array(32).fill(9));

      if (opened._tag !== "ok") throw new Error("synthetic content key mismatch");
      this.lists.push(parseSharedList(opened.json));

      return { _tag: "published", publishedAt: new Date().toISOString() };
    }
  }

  it("rebuilds a list if a history mutation occurs between yielded permit reads", async () => {
    const store = tempStore();
    const added = store.addPermit("HC-BLD-26-0087599");

    if (added._tag !== "ok") throw added.error;
    observe(store, added.value, "In Process");
    const other = store.addPermit("HC-BLD-26-0087600");

    if (other._tag !== "ok") throw other.error;
    observe(store, other.value, "In Process");
    // Restore a known synthetic sharing key through the normal startup path.
    store.setText("share_write_key", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    store.setText("share_content_key", "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk");
    const service = new CapturingService(new URL("http://localhost"));
    const sharing = new Sharing(store, service, new RecordingHost());

    try {
      await sharing.start();
      const publishing = sharing.sync();
      // syncNow first yields to its prior attempt, then captures the store revision and yields its first read.

      const edited = new Promise<void>((resolve) => {
        queueMicrotask(() => setImmediate(() => { observe(store, added.value, "Issued"); resolve(); }));
      });

      await edited;
      expect(await publishing).toEqual({ ok: true, value: null });
      expect(service.lists).toHaveLength(1);
      const list = defined(service.lists[0], "published list");
      const permit = defined(list.permits.find((entry) => entry.id === added.value), "updated permit");
      expect(permit.lastStatus).toBe("Issued");
      expect(list.histories.get(permit.id)?.observations[0]?.statusValue).toBe("Issued");
    } finally { await sharing.stop(); store.close(); }
  });
});
