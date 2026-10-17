import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildSharedList, type SharedList } from "../src/main/share-list.js";
import { sealList, ShareService, type FetchReply } from "../src/main/share-service.js";
import { cachedListSchema, ShareFollower } from "../src/main/share-sync.js";
import { PermitStore } from "../src/main/store.js";

class RevisionService extends ShareService {
  readonly requests: Array<number | null> = [];
  offline = false;

  constructor(
    private readonly json: string,
    private readonly key: Uint8Array,
  ) {
    super(new URL("http://localhost"));
  }

  override async fetch(_token: string, known: number | null): Promise<FetchReply> {
    this.requests.push(known);

    if (this.offline) throw new Error("synthetic offline");

    return known === 2
      ? { _tag: "unchanged" }
      : { _tag: "found", revision: 2, publishedAt: "2026-09-29T12:00:00.000Z", sealed: sealList(this.json, this.key) };
  }
}

describe("shared-list local persistence", () => {
  it("retries the unacknowledged revision, announces once, and restores it offline after restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "share-cache-"));
    const file = path.join(root, "data.sqlite");
    const store = new PermitStore(file);
    const db = new DatabaseSync(file);
    const key = new Uint8Array(32).fill(7);

    const first = {
      revision: 1,
      publishedAt: "2026-09-28T12:00:00.000Z",
      json: buildSharedList([], () => ({ runs: [], observations: [] }), null),
    };

    const added = store.addPermit("HC-BLD-26-0087599");

    if (added._tag !== "ok") throw added.error;
    const json = buildSharedList(store.listPermits(), () => ({ runs: [], observations: [] }), null);
    const service = new RevisionService(json, key);
    const updates: SharedList[] = [];
    const reports: string[] = [];
    store.setText("follow", JSON.stringify(first));
    db.exec(
      "CREATE TRIGGER reject_cache BEFORE UPDATE OF value ON settings WHEN NEW.key = 'follow' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
    );

    const follower = new ShareFollower(
      service,
      "token",
      key,
      first,
      (cache) => store.setText("follow", JSON.stringify(cache)),
      (_before, after) => {
        updates.push(after);
      },
      () => undefined,
      (operation) => {
        reports.push(operation);
      },
    );

    try {
      expect(await follower.refresh()).toBe("Couldn't save the shared list locally. Retrying.");
      expect(follower.list?.permits).toEqual([]);
      expect(updates).toEqual([]);
      expect(reports).toEqual(["share:save-cache"]);
      expect(JSON.parse(store.getText("follow") ?? "null").revision).toBe(1);
      db.exec("DROP TRIGGER reject_cache");
      expect(await follower.refresh()).toBeNull();
      expect(await follower.refresh()).toBeNull();
      expect(service.requests).toEqual([1, 1, 2]);
      expect(updates).toHaveLength(1);
      expect(follower.list?.permits[0]?.id).toBe(added.value);
      const cache = cachedListSchema.parse(JSON.parse(store.getText("follow") ?? "null"));
      expect(cache.revision).toBe(2);
      await follower.stop();
      service.offline = true;

      const restarted = new ShareFollower(
        service,
        "token",
        key,
        cache,
        () => undefined,
        (_before, after) => {
          updates.push(after);
        },
        () => undefined,
        () => undefined,
      );

      try {
        expect(restarted.list?.permits[0]?.id).toBe(added.value);
        expect(await restarted.refresh()).toBe("Couldn't reach the sharing service. Retrying.");
        expect(restarted.list?.permits[0]?.id).toBe(added.value);
        expect(updates).toHaveLength(1);
      } finally {
        await restarted.stop();
      }
    } finally {
      await follower.stop();
      db.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
