// Client for the shared-list Worker (infra/sync-server). The Worker only receives ciphertext: lists are gzipped, then
// sealed with AES-256-GCM under the content key, which never leaves the share code.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzip, gzipSync } from "node:zlib";
import { z } from "zod";
import { promisify } from "node:util";
import { CONTENT_KEY_BYTES, SHARE_BODY_MAX_BYTES } from "../shared/share-protocol.js";

const NONCE_BYTES = 12;

const TAG_BYTES = 16;

/** Binds ciphertext to this format, so it can't be replayed as something else sealed under the same key. */
const ASSOCIATED_DATA = Buffer.from("permitmon-share-v1");

/** A decompressed list larger than this is refused, whatever its compressed size. */
const MAX_LIST_BYTES = 32_000_000;

const REQUEST_TIMEOUT_MS = 20_000;

/** Gzips and seals a list as nonce, ciphertext, then GCM tag. Throws ListTooLarge past SHARE_BODY_MAX_BYTES. */
export function sealList(json: string, contentKey: Uint8Array): Uint8Array<ArrayBuffer> {
  return encryptList(gzipSync(json), contentKey);
}

const compressList = promisify(gzip);

/** Like `sealList`, but gzips on the libuv thread pool so a large list doesn't block the main process. */
export async function sealListAsync(json: string, contentKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return encryptList(await compressList(json), contentKey);
}

function encryptList(compressed: Uint8Array, contentKey: Uint8Array): Uint8Array<ArrayBuffer> {
  if (contentKey.length !== CONTENT_KEY_BYTES) throw new Error("Content key has the wrong length");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", contentKey, nonce);
  cipher.setAAD(ASSOCIATED_DATA);
  const sealed = Buffer.concat([nonce, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);

  if (sealed.length > SHARE_BODY_MAX_BYTES) throw new ListTooLarge(sealed.length);

  return new Uint8Array(sealed);
}

/**
 * Opens a sealed list. Returns `undecryptable` for bytes not sealed under this key, altered since, or inflating past
 * MAX_LIST_BYTES.
 */
export function openList(
  sealed: Uint8Array,
  contentKey: Uint8Array,
): { _tag: "ok"; json: string } | { _tag: "undecryptable" } {
  if (sealed.length < NONCE_BYTES + TAG_BYTES + 1 || contentKey.length !== CONTENT_KEY_BYTES)
    return { _tag: "undecryptable" };

  try {
    const decipher = createDecipheriv("aes-256-gcm", contentKey, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(ASSOCIATED_DATA);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));

    const compressed = Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);

    return { _tag: "ok", json: gunzipSync(compressed, { maxOutputLength: MAX_LIST_BYTES }).toString("utf8") };
  } catch {
    return { _tag: "undecryptable" };
  }
}

/** A sealed list exceeds the Worker's size limit, or a response exceeds the size the client accepts. */
export class ListTooLarge extends Error {
  readonly _tag = "ListTooLarge" as const;

  constructor(
    /** The size that exceeded the limit: the sealed list, or the response as declared or read. */
    readonly bytes: number,
  ) {
    super(`Shared list is ${bytes} bytes sealed`);
  }
}

/** The service answered with a status the client doesn't expect. */
export class ShareServiceError extends Error {
  readonly _tag = "ShareServiceError" as const;

  constructor(
    /** The unexpected HTTP status. */
    readonly status: number,
  ) {
    super(`Sharing service answered ${status}`);
  }
}

const publishedSchema = z.object({ revision: z.number().int().positive(), publishedAt: z.iso.datetime() });

const REVISION_TAG = /^"r(\d{1,15})"$/;

/** The service stored the list, or asked for the publication to be retried later. */
export type PublishReply = { _tag: "published"; publishedAt: string } | { _tag: "retry"; afterSeconds: number };

/** The stored list, `unchanged` when the follower already has its revision, or `absent` when nothing is shared. */
export type FetchReply =
  | { _tag: "absent" }
  | { _tag: "unchanged" }
  | { _tag: "found"; revision: number; publishedAt: string; sealed: Uint8Array };

/**
 * Parses the build's service URL: HTTPS, or HTTP on loopback for a local `wrangler dev`. Returns null for an empty or
 * unacceptable value, which turns sharing off.
 */
export function parseServiceUrl(value: string): URL | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) return null;

    return url;
  } catch {
    return null;
  }
}

const configSchema = z.object({ serviceUrl: z.string() });

/**
 * The service named in the build's sync-config.json, or null when the file can't be read or names none. Throws when
 * the file isn't valid config.
 */
export function loadShareService(configPath: string): ShareService | null {
  let text: string;

  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const url = parseServiceUrl(configSchema.parse(JSON.parse(text)).serviceUrl);

  return url ? new ShareService(url) : null;
}

/** Reads a response body, throwing ListTooLarge once it exceeds `limit` bytes. */
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) throw new ListTooLarge(declared);

  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ListTooLarge(total);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/** HTTP calls to the Worker. Every method rejects on network failure or an unexpected status. */
export class ShareService {
  private readonly listUrl: URL;

  constructor(serviceUrl: URL) {
    this.listUrl = new URL("v1/list", serviceUrl.href.endsWith("/") ? serviceUrl : `${serviceUrl.href}/`);
  }

  /** Sends one request with the token as its bearer credential, and `body` as octets when there is one. */
  private request(
    method: string,
    token: string,
    body: Uint8Array<ArrayBuffer> | null,
    ifNoneMatch: string | null = null,
  ): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

    if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);

    if (body) {
      headers.set("content-type", "application/octet-stream");
      init.body = body;
    }

    return fetch(this.listUrl, init);
  }

  /** Uploads a sealed list. A 429 resolves to `retry` with Retry-After capped at an hour, or 60 s if it's unusable. */
  async publish(writeKey: string, sealed: Uint8Array<ArrayBuffer>): Promise<PublishReply> {
    const response = await this.request("PUT", writeKey, sealed);

    if (response.status === 429) {
      await response.body?.cancel();
      const after = Number(response.headers.get("retry-after"));

      return { _tag: "retry", afterSeconds: Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 60 };
    }

    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ShareServiceError(response.status);
    }

    const published = publishedSchema.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 4096))));

    return { _tag: "published", publishedAt: published.publishedAt };
  }

  /** Fetches the list; `unchanged` when the service still holds revision `known`. */
  async fetch(readToken: string, known: number | null): Promise<FetchReply> {
    const response = await this.request("GET", readToken, null, known === null ? null : `"r${known}"`);

    if (response.status === 304) return { _tag: "unchanged" };

    if (response.status === 404) {
      await response.body?.cancel();

      return { _tag: "absent" };
    }

    const [, revision] = REVISION_TAG.exec(response.headers.get("etag") ?? "") ?? [];
    const publishedAt = z.iso.datetime().safeParse(response.headers.get("x-published-at"));

    if (response.status !== 200 || revision === undefined || !publishedAt.success) {
      await response.body?.cancel();
      throw new ShareServiceError(response.status);
    }

    return {
      _tag: "found",
      revision: Number(revision),
      publishedAt: publishedAt.data,
      sealed: await boundedBytes(response, SHARE_BODY_MAX_BYTES),
    };
  }

  /** Deletes the shared copy. Deleting a list that is already gone succeeds. */
  async remove(writeKey: string): Promise<void> {
    const response = await this.request("DELETE", writeKey, null);
    await response.body?.cancel();

    if (response.status !== 204) throw new ShareServiceError(response.status);
  }
}
