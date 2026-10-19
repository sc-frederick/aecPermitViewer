const SHARE_CODE_PREFIX = "PMS1-";

/** The most encrypted bytes one published list may hold. A Durable Object SQLite row holds up to 2 MB. */
export const SHARE_BODY_MAX_BYTES = 1_500_000;

export const WRITE_KEY_BYTES = 32;

const READ_TOKEN_BYTES = 16;

export const CONTENT_KEY_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string, length: number): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(value) || value.length !== Math.ceil((length * 4) / 3)) return null;
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));

  if (binary.length !== length) return null;
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) bytes[index] = binary.charCodeAt(index);

  return toBase64Url(bytes) === value ? bytes : null;
}

async function sha256(label: string, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const prefix = encoder.encode(`${label}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);

  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export async function readTokenFor(writeKey: string): Promise<string | null> {
  const bytes = fromBase64Url(writeKey, WRITE_KEY_BYTES);

  if (!bytes) return null;

  return toBase64Url((await sha256("permitmon-share-read", bytes)).subarray(0, READ_TOKEN_BYTES));
}

export async function roomNameFor(readToken: string): Promise<string | null> {
  const bytes = fromBase64Url(readToken, READ_TOKEN_BYTES);

  if (!bytes) return null;

  return [...(await sha256("permitmon-share-room", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ShareCode {
  readonly readToken: string;
  readonly contentKey: Uint8Array<ArrayBuffer>;
}

export function formatShareCode(readToken: string, contentKey: Uint8Array): string | null {
  const token = fromBase64Url(readToken, READ_TOKEN_BYTES);

  if (!token || contentKey.length !== CONTENT_KEY_BYTES) return null;
  const joined = new Uint8Array(READ_TOKEN_BYTES + CONTENT_KEY_BYTES);
  joined.set(token);
  joined.set(contentKey, READ_TOKEN_BYTES);

  return `${SHARE_CODE_PREFIX}${toBase64Url(joined)}`;
}

export function parseShareCode(value: string): ShareCode | null {
  const text = value.trim();

  if (!text.startsWith(SHARE_CODE_PREFIX)) return null;
  const joined = fromBase64Url(text.slice(SHARE_CODE_PREFIX.length), READ_TOKEN_BYTES + CONTENT_KEY_BYTES);

  if (!joined) return null;

  return { readToken: toBase64Url(joined.subarray(0, READ_TOKEN_BYTES)), contentKey: joined.slice(READ_TOKEN_BYTES) };
}
