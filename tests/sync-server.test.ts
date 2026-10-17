import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIST_PATH, route } from "../infra/sync-server/src/router.js";
import { DEFAULT_ADMISSION_LIMITS, ShareAdmission } from "../infra/sync-server/src/admission.js";
import { MIN_PUBLISH_INTERVAL_MS, RETENTION_MS } from "../infra/sync-server/src/room.js";
import {
  formatShareCode,
  fromBase64Url,
  parseShareCode,
  readTokenFor,
  roomNameFor,
  SHARE_BODY_MAX_BYTES,
  toBase64Url,
} from "../src/shared/share-protocol.js";
import { MemoryRooms } from "./fixtures/memory-rooms.js";

const publishedSchema = z.object({ revision: z.number().int().positive(), publishedAt: z.string() });

const ORIGIN = "https://permitmon-sync.example.test";

const WRITE_KEY = toBase64Url(new Uint8Array(32).fill(7));

function call(
  rooms: MemoryRooms,
  method: string,
  token: string | null,
  init: { body?: Uint8Array<ArrayBuffer>; ifNoneMatch?: string; path?: string; source?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  headers.set("cf-connecting-ip", init.source ?? "192.0.2.1");

  if (token !== null) headers.set("authorization", `Bearer ${token}`);

  if (init.ifNoneMatch) headers.set("if-none-match", init.ifNoneMatch);
  const request: RequestInit = { method, headers };

  if (init.body) request.body = init.body;

  return route(new Request(`${ORIGIN}${init.path ?? LIST_PATH}`, request), rooms.directory, rooms.admission);
}

function body(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text.padEnd(40, "."));
}

function retainedRooms(rooms: MemoryRooms): number {
  let retained = 0;

  for (const storage of rooms.storages.values()) {
    const row = storage.sql
      .exec("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'list'")
      .toArray()[0];

    if (row?.["count"] === 1) retained += 1;
  }

  return retained;
}

function pendingPublication(key: number, source: string | null = "192.0.2.1"): Request {
  const headers = new Headers({ authorization: `Bearer ${toBase64Url(new Uint8Array(32).fill(key))}` });

  if (source) headers.set("cf-connecting-ip", source);

  return new Request(`${ORIGIN}${LIST_PATH}`, { method: "PUT", headers, body: new Uint8Array(SHARE_BODY_MAX_BYTES) });
}

async function readToken(): Promise<string> {
  const token = await readTokenFor(WRITE_KEY);

  if (!token) throw new Error("write key should be valid");

  return token;
}

describe("share protocol", () => {
  it("round-trips base64url and rejects other lengths and non-canonical text", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 16, 17, 18, 19, 20, 21, 22]);
    const text = toBase64Url(bytes);

    expect(text).not.toMatch(/[+/=]/);
    expect(fromBase64Url(text, 16)).toEqual(bytes);
    expect(fromBase64Url(text, 15)).toBeNull();
    // The last character carries unused low bits; changing only those must not name the same bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lowBitFlipped = alphabet[alphabet.indexOf(text.slice(-1)) ^ 1] ?? "";
    expect(fromBase64Url(`${text.slice(0, -1)}${lowBitFlipped}`, 16)).toBeNull();
    expect(fromBase64Url(`${text.slice(0, -1)}+`, 16)).toBeNull();
  });

  it("derives the same read token and room from a write key every time, and never names a room by the token", async () => {
    const token = await readToken();
    const room = await roomNameFor(token);

    expect(await readTokenFor(WRITE_KEY)).toBe(token);
    expect(room).toMatch(/^[0-9a-f]{64}$/);
    expect(room).not.toContain(token);
    expect(await readTokenFor("too-short")).toBeNull();
    expect(await roomNameFor(WRITE_KEY)).toBeNull();
  });

  it("keeps deriving the tokens, rooms, and codes that existing shares were made with", async () => {
    // Fixed values: a change here strands every share code already handed out.
    expect(WRITE_KEY).toBe("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc");
    expect(await readToken()).toBe("jZ2FJRJRqUu7lUZXPxvNgw");
    expect(await roomNameFor("jZ2FJRJRqUu7lUZXPxvNgw")).toBe(
      "03c71fe557e67a0d646e38a500e5a0388ccb96dad6f25b67d6314d147fce5f54",
    );
    expect(formatShareCode("jZ2FJRJRqUu7lUZXPxvNgw", new Uint8Array(32).fill(9))).toBe(
      "PMS1-jZ2FJRJRqUu7lUZXPxvNgwkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ",
    );
  });

  it("formats and parses share codes, ignoring surrounding whitespace", async () => {
    const token = await readToken();
    const key = new Uint8Array(32).fill(9);
    const code = formatShareCode(token, key);

    expect(code).toMatch(/^PMS1-[A-Za-z0-9_-]{64}$/);
    expect(parseShareCode(`  ${code}\n`)).toEqual({ readToken: token, contentKey: key });
    expect(parseShareCode(`${code}A`)).toBeNull();
    expect(parseShareCode(code?.replace("PMS1-", "PMS2-") ?? "")).toBeNull();
  });
});

describe("sync Worker", () => {
  it("serves what the write key published to the read token, and 304 for a revision the reader has", async () => {
    const rooms = new MemoryRooms();
    const token = await readToken();

    expect((await call(rooms, "GET", token)).status).toBe(404);
    // Reading a room nobody published to stores nothing.
    expect(
      rooms.storages
        .get((await roomNameFor(token)) ?? "")
        ?.sql.exec("SELECT count(*) AS n FROM sqlite_master")
        .toArray(),
    ).toEqual([{ n: 0 }]);
    const published = await call(rooms, "PUT", WRITE_KEY, { body: body("first") });
    expect(published.status).toBe(200);
    const { revision, publishedAt } = publishedSchema.parse(await published.json());
    expect(publishedAt).toBe("2026-09-28T12:00:00.000Z");

    const fetched = await call(rooms, "GET", token);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("etag")).toBe(`"r${revision}"`);
    expect(fetched.headers.get("x-published-at")).toBe("2026-09-28T12:00:00.000Z");
    expect(new TextDecoder().decode(await fetched.arrayBuffer())).toBe(new TextDecoder().decode(body("first")));

    expect((await call(rooms, "GET", token, { ifNoneMatch: `"r${revision}"` })).status).toBe(304);
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    await call(rooms, "PUT", WRITE_KEY, { body: body("second") });
    const newer = await call(rooms, "GET", token, { ifNoneMatch: `"r${revision}"` });
    expect(newer.status).toBe(200);
    expect(newer.headers.get("etag")).toBe(`"r${revision + 1}"`);
  });

  it("keeps readers from publishing or deleting, and needs well-formed credentials", async () => {
    const rooms = new MemoryRooms();
    const token = await readToken();
    await call(rooms, "PUT", WRITE_KEY, { body: body("list") });

    // A read token is not a write key: it names no room when used as one.
    expect((await call(rooms, "PUT", token, { body: body("vandal") })).status).toBe(401);
    expect((await call(rooms, "DELETE", token)).status).toBe(401);
    expect((await call(rooms, "GET", null)).status).toBe(401);
    expect((await call(rooms, "GET", "not a token")).status).toBe(401);
    // Another valid write key reaches another room, not this one.
    const other = toBase64Url(new Uint8Array(32).fill(8));
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    expect((await call(rooms, "PUT", other, { body: body("other") })).status).toBe(200);
    expect(new TextDecoder().decode(await (await call(rooms, "GET", token)).arrayBuffer())).toBe(
      new TextDecoder().decode(body("list")),
    );
  });

  it("refuses bodies that are too small, too large, or too frequent", async () => {
    const rooms = new MemoryRooms();

    expect((await call(rooms, "PUT", WRITE_KEY, { body: new Uint8Array(10) })).status).toBe(400);
    expect((await call(rooms, "PUT", WRITE_KEY, { body: new Uint8Array(SHARE_BODY_MAX_BYTES + 1) })).status).toBe(413);
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("a") })).status).toBe(200);
    rooms.now += 4_000;
    const early = await call(rooms, "PUT", WRITE_KEY, { body: body("b") });
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("6");
  });

  it("deletes a list with its write key, and schedules deletion of lists nobody publishes to", async () => {
    const rooms = new MemoryRooms();
    const token = await readToken();
    await call(rooms, "PUT", WRITE_KEY, { body: body("list") });
    const etag = (await call(rooms, "GET", token)).headers.get("etag");
    const room = rooms.storages.get((await roomNameFor(token)) ?? "");

    expect(room?.alarm).toBe(rooms.now + RETENTION_MS);
    expect((await call(rooms, "DELETE", WRITE_KEY)).status).toBe(204);
    expect(room?.alarm).toBeNull();
    expect((await call(rooms, "GET", token)).status).toBe(404);
    // Deleting a missing list succeeds. The room then takes a new publication with a new revision, so a follower
    // holding the deleted list's etag gets the new contents, not a 304.
    expect((await call(rooms, "DELETE", WRITE_KEY)).status).toBe(204);
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("again") })).status).toBe(200);
    expect((await call(rooms, "GET", token, { ifNoneMatch: etag ?? "" })).status).toBe(200);
  });

  it("answers 503 when the Durable Object fails, and 404 or 405 off the list route", async () => {
    const rooms = new MemoryRooms();
    rooms.failing = true;
    const failed = await call(rooms, "GET", await readToken());

    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("30");
    expect((await call(rooms, "GET", await readToken(), { path: "/v1/other" })).status).toBe(404);
    expect((await call(rooms, "POST", WRITE_KEY)).status).toBe(405);
  });
});

describe("sync admission through the HTTP router", () => {
  it("stops 25 rotating valid keys at the source creation quota without reading rejected bodies or retaining their rooms", async () => {
    const rooms = new MemoryRooms();
    const responses: number[] = [];

    for (let index = 1; index <= 25; index += 1) {
      const request = pendingPublication(index);
      const response = await route(request, rooms.directory, rooms.admission);
      responses.push(response.status);

      if (index > DEFAULT_ADMISSION_LIMITS.sourceCreationsPerDay) {
        expect(request.bodyUsed).toBe(false);
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
        const token = await readTokenFor(toBase64Url(new Uint8Array(32).fill(index)));
        const storage = rooms.storages.get(token ? ((await roomNameFor(token)) ?? "") : "");
        expect(storage?.alarm).toBeNull();
        expect(storage?.sql.exec("SELECT count(*) AS count FROM sqlite_master").toArray()).toEqual([{ count: 0 }]);
      }
    }

    expect(responses.filter((status) => status === 200)).toHaveLength(5);
    expect(responses.filter((status) => status === 429)).toHaveLength(20);
    expect(retainedRooms(rooms)).toBe(5);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()).toEqual([
      { count: 5 },
    ]);
  });

  it("rejects request floods before room allocation and body reads, and recovers at the next minute", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, sourceWritesPerMinute: 2 });
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("first") })).status).toBe(200);
    rooms.now += 10_000;
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("second") })).status).toBe(200);
    const allocations = rooms.storages.size;
    const request = pendingPublication(20);
    const response = await route(request, rooms.directory, rooms.admission);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("50");
    expect(request.bodyUsed).toBe(false);
    expect(rooms.storages.size).toBe(allocations);
    rooms.now += 50_000;
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("after minute") })).status).toBe(200);
  });

  it("shares an IPv6 /64 quota and ignores caller-controlled forwarding headers", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, sourceCreationsPerDay: 1 });
    expect((await route(pendingPublication(1, "2001:db8:1234:5678::1"), rooms.directory, rooms.admission)).status).toBe(
      200,
    );
    const sameNetwork = pendingPublication(2, "2001:0db8:1234:5678:ffff:ffff:ffff:ffff");
    expect((await route(sameNetwork, rooms.directory, rooms.admission)).status).toBe(429);
    expect(sameNetwork.bodyUsed).toBe(false);
    expect((await route(pendingPublication(3, "2001:db8:1234:5679::1"), rooms.directory, rooms.admission)).status).toBe(
      200,
    );

    const local = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, sourceCreationsPerDay: 1 });
    const first = pendingPublication(4, null);
    first.headers.set("x-forwarded-for", "192.0.2.44");
    expect((await route(first, local.directory, local.admission)).status).toBe(200);
    const second = pendingPublication(5, null);
    second.headers.set("x-forwarded-for", "192.0.2.45");
    expect((await route(second, local.directory, local.admission)).status).toBe(429);
    expect(second.bodyUsed).toBe(false);
  });

  it("caps deployment-wide creations across sources, preserves existing shares, and resets the daily quota", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, deploymentCreationsPerDay: 2 });
    expect((await route(pendingPublication(1, "192.0.2.1"), rooms.directory, rooms.admission)).status).toBe(200);
    expect((await route(pendingPublication(2, "192.0.2.2"), rooms.directory, rooms.admission)).status).toBe(200);
    const rejected = pendingPublication(3, "192.0.2.3");
    expect((await route(rejected, rooms.directory, rooms.admission)).status).toBe(429);
    expect(rejected.bodyUsed).toBe(false);
    expect(retainedRooms(rooms)).toBe(2);
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    expect((await route(pendingPublication(1, "192.0.2.1"), rooms.directory, rooms.admission)).status).toBe(200);
    rooms.now += 86_400_000;
    expect((await route(pendingPublication(3, "192.0.2.3"), rooms.directory, rooms.admission)).status).toBe(200);
  });

  it("keeps a permanent storage budget through concurrent creations, deletion, expiry and coordinator restart", async () => {
    const limits = { ...DEFAULT_ADMISSION_LIMITS, registeredRooms: 2 };
    const rooms = new MemoryRooms(limits);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        route(pendingPublication(index + 1, `192.0.2.${index + 1}`), rooms.directory, rooms.admission),
      ),
    );

    expect(results.filter((result) => result.status === 200)).toHaveLength(2);
    expect(results.filter((result) => result.status === 429)).toHaveLength(6);
    expect(retainedRooms(rooms)).toBe(2);
    const winners: number[] = [];

    results.forEach((result, index) => {
      if (result.status === 200) winners.push(index + 1);
    });
    const [firstKey, secondKey] = winners;

    if (firstKey === undefined || secondKey === undefined) throw new Error("two admitted fixture keys are required");
    const first = toBase64Url(new Uint8Array(32).fill(firstKey));
    expect((await call(rooms, "DELETE", first)).status).toBe(204);
    const secondToken = await readTokenFor(toBase64Url(new Uint8Array(32).fill(secondKey)));
    await rooms.directory(secondToken ? ((await roomNameFor(secondToken)) ?? "") : "").remove();
    expect(retainedRooms(rooms)).toBe(0);

    const restarted = new ShareAdmission(rooms.admissionStorage, limits);

    const admission = {
      check: async (name: string, source: string) => restarted.check(name, source, rooms.now),
      register: async (name: string, source: string) => restarted.register(name, source, rooms.now),
    };

    const fresh = pendingPublication(30, "192.0.2.30");
    expect((await route(fresh, rooms.directory, admission)).status).toBe(429);
    expect(fresh.bodyUsed).toBe(false);
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    expect((await route(pendingPublication(firstKey), rooms.directory, admission)).status).toBe(200);
    expect(retainedRooms(rooms)).toBe(1);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()).toEqual([
      { count: 2 },
    ]);
  });

  it("preserves pre-upgrade legacy rooms even when new admission capacity is exhausted", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, registeredRooms: 1, sourceCreationsPerDay: 1 });
    const token = await readToken();
    const name = await roomNameFor(token);

    if (!name) throw new Error("fixture token should name a room");
    await rooms.directory(name).publish(body("legacy").buffer);
    expect((await route(pendingPublication(1), rooms.directory, rooms.admission)).status).toBe(200);
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("legacy update") })).status).toBe(200);
    expect(new TextDecoder().decode(await (await call(rooms, "GET", token)).arrayBuffer())).toBe(
      new TextDecoder().decode(body("legacy update")),
    );
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()).toEqual([
      { count: 1 },
    ]);
    expect((await call(rooms, "DELETE", WRITE_KEY)).status).toBe(204);
    const fresh = pendingPublication(7);
    expect((await route(fresh, rooms.directory, rooms.admission)).status).toBe(429);
    expect(fresh.bodyUsed).toBe(false);
  });

  it("bounds source metadata and prunes old counters, while invalid bodies never reserve room storage", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, trackedSources: 2 });
    expect((await call(rooms, "PUT", WRITE_KEY, { body: new Uint8Array(1), source: "192.0.2.1" })).status).toBe(400);
    expect(
      (await call(rooms, "PUT", WRITE_KEY, { body: new Uint8Array(SHARE_BODY_MAX_BYTES + 1), source: "192.0.2.2" }))
        .status,
    ).toBe(413);
    expect(rooms.storages.size).toBe(0);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()).toEqual([
      { count: 0 },
    ]);
    const rejected = pendingPublication(2, "192.0.2.3");
    expect((await route(rejected, rooms.directory, rooms.admission)).status).toBe(429);
    expect(rejected.bodyUsed).toBe(false);
    expect(rooms.storages.size).toBe(0);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admission_sources").toArray()).toEqual([
      { count: 2 },
    ]);
    rooms.now += 86_400_000;
    expect((await route(pendingPublication(2, "192.0.2.3"), rooms.directory, rooms.admission)).status).toBe(200);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admission_sources").toArray()).toEqual([
      { count: 1 },
    ]);
  });

  it("fails closed before body or room access when the admission coordinator is unavailable", async () => {
    const rooms = new MemoryRooms();
    rooms.failing = true;
    const request = pendingPublication(1);
    const response = await route(request, rooms.directory, rooms.admission);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(request.bodyUsed).toBe(false);
    expect(rooms.storages.size).toBe(0);
  });

  it("keeps an uncertain successful first publication reserved and permits retrying its key", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, registeredRooms: 1 });

    const uncertain = (name: string) => {
      const room = rooms.directory(name);

      return {
        ...room,
        publish: async (bytes: ArrayBuffer) => {
          await room.publish(bytes);
          throw new Error("Synthetic lost Durable Object RPC response");
        },
      };
    };

    expect((await route(pendingPublication(1), uncertain, rooms.admission)).status).toBe(503);
    expect(retainedRooms(rooms)).toBe(1);
    const fresh = pendingPublication(2);
    expect((await route(fresh, rooms.directory, rooms.admission)).status).toBe(429);
    expect(fresh.bodyUsed).toBe(false);
    rooms.now += MIN_PUBLISH_INTERVAL_MS;
    expect((await route(pendingPublication(1), rooms.directory, rooms.admission)).status).toBe(200);
    expect(rooms.admissionStorage.sql.exec("SELECT count(*) AS count FROM admitted_rooms").toArray()).toEqual([
      { count: 1 },
    ]);
  });

  it("bounds per-room Retry-After too, even if the service clock moves backwards", async () => {
    const rooms = new MemoryRooms();
    expect((await call(rooms, "PUT", WRITE_KEY, { body: body("first") })).status).toBe(200);
    rooms.now -= 86_400_000;
    const early = await call(rooms, "PUT", WRITE_KEY, { body: body("second") });
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("3600");
  });
});
