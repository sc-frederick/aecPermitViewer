import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIST_PATH, route } from "../infra/sync-server/src/router.js";
import { MIN_PUBLISH_INTERVAL_MS, RETENTION_MS } from "../infra/sync-server/src/room.js";
import {
  formatShareCode, fromBase64Url, parseShareCode, readTokenFor, roomNameFor, SHARE_BODY_MAX_BYTES, toBase64Url,
} from "../src/shared/share-protocol.js";
import { MemoryRooms } from "./fixtures/memory-rooms.js";

const publishedSchema = z.object({ revision: z.number().int().positive(), publishedAt: z.string() });

const ORIGIN = "https://permitmon-sync.example.test";

const WRITE_KEY = toBase64Url(new Uint8Array(32).fill(7));

function call(rooms: MemoryRooms, method: string, token: string | null, init: { body?: Uint8Array<ArrayBuffer>; ifNoneMatch?: string; path?: string } = {}): Promise<Response> {
  const headers = new Headers();

  if (token !== null) headers.set("authorization", `Bearer ${token}`);

  if (init.ifNoneMatch) headers.set("if-none-match", init.ifNoneMatch);
  const request: RequestInit = { method, headers };

  if (init.body) request.body = init.body;

  return route(new Request(`${ORIGIN}${init.path ?? LIST_PATH}`, request), rooms.directory);
}

function body(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text.padEnd(40, "."));
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
    expect(await roomNameFor("jZ2FJRJRqUu7lUZXPxvNgw")).toBe("03c71fe557e67a0d646e38a500e5a0388ccb96dad6f25b67d6314d147fce5f54");
    expect(formatShareCode("jZ2FJRJRqUu7lUZXPxvNgw", new Uint8Array(32).fill(9)))
      .toBe("PMS1-jZ2FJRJRqUu7lUZXPxvNgwkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ");
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
    expect(rooms.storages.get(await roomNameFor(token) ?? "")?.sql.exec("SELECT count(*) AS n FROM sqlite_master").toArray()).toEqual([{ n: 0 }]);
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
    expect(new TextDecoder().decode(await (await call(rooms, "GET", token)).arrayBuffer())).toBe(new TextDecoder().decode(body("list")));
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
    const room = rooms.storages.get(await roomNameFor(token) ?? "");

    expect(room?.alarm).toBe(rooms.now + RETENTION_MS);
    expect((await call(rooms, "DELETE", WRITE_KEY)).status).toBe(204);
    expect(room?.alarm).toBeNull();
    expect((await call(rooms, "GET", token)).status).toBe(404);
    // Deleting again, or a list that never existed, still succeeds, and the same room takes a new publication. That
    // one's revision is new, so a follower holding the deleted list's revision gets the new contents, not a 304.
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
