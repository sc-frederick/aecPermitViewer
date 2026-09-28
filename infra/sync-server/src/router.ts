// HTTP routes for shared permit lists. Credentials travel in the Authorization header, never the URL, so they stay out
// of request logs. Publishing and deleting take the write key; fetching takes the read token. Both lead to the same room
// because the room is named from the read token, which the Worker derives from the write key.
import { readTokenFor, roomNameFor, SHARE_BODY_MAX_BYTES } from "../../../src/shared/share-protocol.js";
import type { PublishResult, ReadResult } from "./room.js";

/** A room as the router reaches it: a Durable Object stub in production, a ShareRoom in tests. */
export interface RoomApi {
  publish(body: ArrayBuffer): Promise<PublishResult>;
  read(knownRevision: number | null): Promise<ReadResult>;
  remove(): Promise<void>;
}

/** The room with this name. The same name always reaches the same room. */
export type RoomDirectory = (name: string) => RoomApi;

export const LIST_PATH = "/v1/list";

/** AES-GCM output is at least a 12-byte nonce and a 16-byte tag. */
const MIN_BODY_BYTES = 29;

const REVISION_TAG = /^"r(\d{1,15})"$/;

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function bearer(request: Request): string | null {
  const [, token] = /^Bearer ([A-Za-z0-9_-]{1,64})$/.exec(request.headers.get("authorization") ?? "") ?? [];

  return token ?? null;
}

type BodyRead = { readonly _tag: "ok"; readonly bytes: ArrayBuffer } | { readonly _tag: "too_large" } | { readonly _tag: "malformed" };

/** Reads at most `limit` bytes, stopping as soon as the body exceeds it. */
async function readBounded(request: Request, limit: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) return { _tag: "too_large" };

  if (!request.body) return { _tag: "ok", bytes: new ArrayBuffer(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      total += value.byteLength;

      if (total > limit) {
        await reader.cancel().catch(() => undefined);

        return { _tag: "too_large" };
      }

      chunks.push(value);
    }
  } catch {
    return { _tag: "malformed" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { _tag: "ok", bytes: bytes.buffer };
}

/** Runs a room call, answering 503 when the Durable Object fails. The cause is logged, never returned. */
async function inRoom(operation: string, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (cause) {
    console.error(JSON.stringify({ event: "room_failure", operation, error: String(cause) }));

    return text("Storage unavailable; retry shortly", 503, { "retry-after": "30" });
  }
}

async function fetchList(request: Request, rooms: RoomDirectory): Promise<Response> {
  const token = bearer(request);
  const name = token ? await roomNameFor(token) : null;

  if (!name) return text("Missing or malformed read token", 401);
  const [, known] = REVISION_TAG.exec(request.headers.get("if-none-match") ?? "") ?? [];

  return inRoom("read", async () => {
    const result = await rooms(name).read(known === undefined ? null : Number(known));

    // An unknown token and a deleted list look the same, so a token can't be probed for a list that once existed.
    if (result._tag === "absent") return text("No shared list", 404);
    const etag = `"r${result.revision}"`;

    if (result._tag === "unchanged") return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });

    return new Response(result.body, { status: 200, headers: {
      "content-type": "application/octet-stream", "cache-control": "no-store", etag, "x-published-at": result.publishedAt,
    } });
  });
}

async function writerRoom(request: Request): Promise<string | null> {
  const key = bearer(request);
  const token = key ? await readTokenFor(key) : null;

  return token ? roomNameFor(token) : null;
}

async function publishList(request: Request, rooms: RoomDirectory): Promise<Response> {
  const name = await writerRoom(request);

  if (!name) return text("Missing or malformed write key", 401);
  const body = await readBounded(request, SHARE_BODY_MAX_BYTES);

  if (body._tag === "too_large") return text(`Lists are limited to ${SHARE_BODY_MAX_BYTES} bytes`, 413);

  if (body._tag === "malformed" || body.bytes.byteLength < MIN_BODY_BYTES) return text("Malformed list", 400);

  return inRoom("publish", async () => {
    const result = await rooms(name).publish(body.bytes);

    if (result._tag === "too_soon") return text("Published too recently", 429, { "retry-after": String(result.retryAfterSeconds) });

    return new Response(JSON.stringify({ revision: result.revision, publishedAt: result.publishedAt }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });
}

async function deleteList(request: Request, rooms: RoomDirectory): Promise<Response> {
  const name = await writerRoom(request);

  if (!name) return text("Missing or malformed write key", 401);

  return inRoom("remove", async () => {
    await rooms(name).remove();

    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}

/** Answers one request. Client mistakes and storage failures become responses, not rejections. */
export async function route(request: Request, rooms: RoomDirectory): Promise<Response> {
  if (new URL(request.url).pathname !== LIST_PATH) return text("Not found", 404);

  switch (request.method) {
    case "GET": return fetchList(request, rooms);
    case "PUT": return publishList(request, rooms);
    case "DELETE": return deleteList(request, rooms);
    default: return text("Method not allowed", 405, { allow: "GET, PUT, DELETE" });
  }
}
