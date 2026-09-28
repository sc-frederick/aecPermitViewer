// Serves Permit Monitor installers and the signed update manifest from R2, and accepts manual release
// uploads. The app trusts only the Ed25519 signature on the manifest, so this Worker is a delivery path,
// not a trust anchor.
import { z } from "zod";
import type { FeedBucket, FeedObject, FeedRange } from "./bucket.js";
import { decodeUtf8, jsonText, parseManifest, sha256Hex } from "./manifest.js";
import { decideInstallerUpload, decideManifestReplacement, type VersionedManifest } from "./release-policy.js";

/** Bindings from wrangler.jsonc. `UPLOAD_TOKEN` is a secret; without it every upload is refused. */
export interface FeedEnv {
  readonly BUCKET: FeedBucket;
  readonly UPLOAD_TOKEN?: string;
}

const MANIFEST = "release-manifest.json";

const INSTALLER = /^PermitMonitorSetup-\d+\.\d+\.\d+\.exe$/;

const INSTALLER_TYPE = "application/vnd.microsoft.portable-executable";

const MANIFEST_MAX_BYTES = 32_768;

// A completion lists at most 10,000 parts of about 60 JSON bytes each.
const UPLOAD_REQUEST_MAX_BYTES = 1_048_576;

const RETRY_AFTER_SECONDS = "5";

const installerClaimSchema = z.object({ sha256: sha256Hex, size: z.number().int().positive().max(1_000_000_000) });

type InstallerClaim = z.infer<typeof installerClaimSchema>;

const installerClaimText = jsonText.pipe(installerClaimSchema);

const completionText = jsonText.pipe(installerClaimSchema.extend({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) })).min(1).max(10_000),
}));

type StorageOperation = "head" | "get" | "put" | "delete" | "create_multipart" | "upload_part" | "complete_multipart" | "abort_multipart";

/** An R2 rejection. Every one is answered with 503 and a retry hint; the cause is logged, not returned. */
interface StorageFailure {
  readonly _tag: "storage_failure";
  readonly operation: StorageOperation;
  readonly key: string;
}

type Stored<T> = { readonly _tag: "ok"; readonly value: T } | StorageFailure;

type BodyRead =
  | { readonly _tag: "ok"; readonly text: string }
  | { readonly _tag: "too_large" }
  | { readonly _tag: "malformed" };

/** The published manifest as the version rule needs it, or the response that ends the upload. */
type PublishedRead =
  | { readonly _tag: "found"; readonly manifest: VersionedManifest; readonly etag: string }
  | { readonly _tag: "absent" }
  | { readonly _tag: "refused"; readonly response: Response };

export default {
  /** Routes feed downloads and authenticated uploads. Client mistakes and R2 failures become responses, not rejections. */
  async fetch(request: Request, env: FeedEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = decodePath(url.pathname.slice(1));

    if (name === null) return text("Malformed path", 400);

    if (name.startsWith("upload/")) return upload(request, env, url, name.slice("upload/".length));

    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);

    if (name === "" || name === "PermitMonitorSetup.exe") return latest(env, url);

    if (name === MANIFEST) return serve(request, env, name, "no-cache");

    if (INSTALLER.test(name)) return serve(request, env, name, "public, max-age=31536000, immutable");

    return text("Not found", 404);
  },
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

async function stored<T>(operation: StorageOperation, key: string, run: () => Promise<T>): Promise<Stored<T>> {
  try {
    return { _tag: "ok", value: await run() };
  } catch (cause) {
    console.error(JSON.stringify({ event: "storage_failure", operation, key, error: String(cause) }));

    return { _tag: "storage_failure", operation, key };
  }
}

function unavailable(failure: StorageFailure): Response {
  return new Response(`Storage ${failure.operation} failed; retry shortly`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": RETRY_AFTER_SECONDS },
  });
}

/** Reads at most `limit` bytes, stopping as soon as the body exceeds it, and decodes them as strict UTF-8. */
async function readBounded(request: Request, limit: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) return { _tag: "too_large" };

  if (!request.body) return { _tag: "ok", text: "" };
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

  const decoded = decodeUtf8(bytes);

  return decoded === null ? { _tag: "malformed" } : { _tag: "ok", text: decoded };
}

function bodyRejection(read: Exclude<BodyRead, { _tag: "ok" }>): Response {
  return read._tag === "too_large" ? text("Request body too large", 413) : text("Malformed request body", 400);
}

function recordedSha256(object: FeedObject): string | null {
  const recorded = object.customMetadata?.sha256;

  return recorded !== undefined && sha256Hex.safeParse(recorded).success ? recorded : null;
}

// Stable link for handing the current installer to someone new.
async function latest(env: FeedEnv, url: URL): Promise<Response> {
  const manifest = await stored("get", MANIFEST, () => env.BUCKET.get(MANIFEST));

  if (manifest._tag !== "ok") return unavailable(manifest);

  if (!manifest.value) return text("No release published yet", 404);
  const found = manifest.value;
  const body = await stored("get", MANIFEST, () => found.text());

  if (body._tag !== "ok") return unavailable(body);
  const payload = parseManifest(body.value);

  if (!payload) return text("Published manifest is unreadable", 500);

  return Response.redirect(new URL(`/PermitMonitorSetup-${payload.version.text}.exe`, url).toString(), 302);
}

/**
 * Resolves a single RFC 9110 `bytes=` range against `size`. Returns null when the header should be ignored
 * (another unit, several ranges, or bad syntax), which serves the whole object, and "unsatisfiable" when it
 * is well formed but selects no bytes.
 */
function resolveRange(header: string, size: number): FeedRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());

  if (!match || (match[1] === "" && match[2] === "")) return null;

  if (match[1] === "") {
    const suffix = Number(match[2]);

    if (suffix === 0 || size === 0) return "unsatisfiable";

    return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }

  const start = Number(match[1]);

  if (match[2] !== "" && Number(match[2]) < start) return null;

  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);

  return { offset: start, length: end - start + 1 };
}

function objectHeaders(object: FeedObject, key: string, cacheControl: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cacheControl);
  headers.set("accept-ranges", "bytes");

  if (key !== MANIFEST) headers.set("content-disposition", `attachment; filename="${key}"`);

  return headers;
}

// Only HEAD and Range requests read metadata first, since a range has to be checked against the stored size.
// A plain GET costs one R2 read.
async function serve(request: Request, env: FeedEnv, key: string, cacheControl: string): Promise<Response> {
  const rangeHeader = request.headers.get("range");

  if (request.method === "HEAD" || rangeHeader !== null) {
    const found = await stored("head", key, () => env.BUCKET.head(key));

    if (found._tag !== "ok") return unavailable(found);

    if (!found.value) return text("Not found", 404);
    const size = found.value.size;

    if (request.method === "HEAD") {
      const headers = objectHeaders(found.value, key, cacheControl);
      headers.set("content-length", String(size));

      return new Response(null, { headers });
    }

    const range = rangeHeader === null ? null : resolveRange(rangeHeader, size);

    if (range === "unsatisfiable") {
      return new Response("Range not satisfiable", { status: 416, headers: { "content-range": `bytes */${size}` } });
    }

    if (range) {
      const part = await stored("get", key, () => env.BUCKET.get(key, { range }));

      if (part._tag !== "ok") return unavailable(part);

      // Deleted between the two reads.
      if (!part.value) return text("Not found", 404);
      const headers = objectHeaders(part.value, key, cacheControl);
      headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);

      return new Response(part.value.body, { status: 206, headers });
    }
  }

  const object = await stored("get", key, () => env.BUCKET.get(key));

  if (object._tag !== "ok") return unavailable(object);

  if (!object.value) return text("Not found", 404);

  return new Response(object.value.body, { headers: objectHeaders(object.value, key, cacheControl) });
}

async function authorized(request: Request, env: FeedEnv): Promise<boolean> {
  if (!env.UPLOAD_TOKEN) return false;
  const encoder = new TextEncoder();
  const given = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")));
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`)));
  // Both digests are 32 bytes, so the loop takes the same time wherever they differ.
  let difference = 0;

  for (let index = 0; index < expected.length; index += 1) difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);

  return difference === 0;
}

// Manual protocol (scripts/publish-update.mjs): installer parts through an R2 multipart upload (Worker
// request bodies are capped at 100 MB), then the manifest last. Versioned installers are immutable: an
// identical retry is reported as already published and different bytes are refused, both when the upload
// starts and again when it completes.
async function upload(request: Request, env: FeedEnv, url: URL, key: string): Promise<Response> {
  if (!(await authorized(request, env))) return text("Unauthorized", 401);

  if (key === MANIFEST && request.method === "PUT") return putManifest(request, env);

  if (!INSTALLER.test(key)) return text("Not found", 404);
  const uploadId = url.searchParams.get("uploadId");

  if (request.method === "POST" && !uploadId) return startInstaller(request, env, key);

  if (!uploadId) return text("Missing uploadId", 400);
  const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);

  if (request.method === "PUT") {
    const partNumber = Number(url.searchParams.get("partNumber"));

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body) return text("Bad part", 400);
    const body = request.body;
    const part = await stored("upload_part", key, () => multipart.uploadPart(partNumber, body));

    return part._tag === "ok" ? Response.json(part.value) : unavailable(part);
  }

  if (request.method === "POST") return completeInstaller(request, env, key, uploadId);

  if (request.method === "DELETE") {
    const aborted = await stored("abort_multipart", key, () => multipart.abort());

    return aborted._tag === "ok" ? new Response(null, { status: 204 }) : unavailable(aborted);
  }

  return text("Method not allowed", 405);
}

/** Applies the immutability rule to `key`. Returns null when the installer may be written, else the response. */
async function installerGuard(env: FeedEnv, key: string, claim: InstallerClaim): Promise<Response | null> {
  const existing = await stored("head", key, () => env.BUCKET.head(key));

  if (existing._tag !== "ok") return unavailable(existing);
  const identity = existing.value ? { size: existing.value.size, sha256: recordedSha256(existing.value) } : null;
  const decision = decideInstallerUpload(identity, claim);

  if (decision._tag === "upload") return null;

  if (decision._tag === "already_published") return Response.json({ status: "published" });

  if (decision._tag === "unverified") return text("Installer already published without a recorded hash", 409);

  return text(`Installer already published with different bytes: ${decision.reason}`, 409);
}

async function startInstaller(request: Request, env: FeedEnv, key: string): Promise<Response> {
  const read = await readBounded(request, UPLOAD_REQUEST_MAX_BYTES);

  if (read._tag !== "ok") return bodyRejection(read);
  const claim = installerClaimText.safeParse(read.text);

  if (!claim.success) return text("Malformed upload request", 400);
  const refused = await installerGuard(env, key, claim.data);

  if (refused) return refused;

  const multipart = await stored("create_multipart", key, () => env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: INSTALLER_TYPE },
    customMetadata: { sha256: claim.data.sha256 },
  }));

  return multipart._tag === "ok" ? Response.json({ status: "created", uploadId: multipart.value.uploadId }) : unavailable(multipart);
}

async function completeInstaller(request: Request, env: FeedEnv, key: string, uploadId: string): Promise<Response> {
  const read = await readBounded(request, UPLOAD_REQUEST_MAX_BYTES);

  if (read._tag !== "ok") return bodyRejection(read);
  const completion = completionText.safeParse(read.text);

  if (!completion.success) return text("Malformed completion request", 400);
  const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);
  // Another upload may have finished since this one started.
  const refused = await installerGuard(env, key, completion.data);

  if (refused) {
    const aborted = await stored("abort_multipart", key, () => multipart.abort());

    return aborted._tag === "ok" ? refused : unavailable(aborted);
  }

  const object = await stored("complete_multipart", key, () => multipart.complete(completion.data.parts));

  if (object._tag !== "ok") return unavailable(object);

  if (object.value.size === completion.data.size && recordedSha256(object.value) === completion.data.sha256) {
    return Response.json({ status: "published", size: object.value.size });
  }

  // The assembled object doesn't match what this upload declared. Nothing was stored under the key before it, so
  // removing it lets a corrected retry proceed.
  const removed = await stored("delete", key, () => env.BUCKET.delete(key));

  if (removed._tag !== "ok") return unavailable(removed);

  return text(`Completed installer does not match the declared ${completion.data.size} bytes and SHA-256`, 409);
}

// Refuse a manifest whose installer isn't already in place with the advertised size and hash, so clients
// never see a version they can't download, and refuse one that would move the feed backwards.
async function putManifest(request: Request, env: FeedEnv): Promise<Response> {
  const read = await readBounded(request, MANIFEST_MAX_BYTES);

  if (read._tag !== "ok") return bodyRejection(read);
  const payload = parseManifest(read.text);
  const key = payload ? decodePath(new URL(payload.url).pathname.slice(1)) : null;

  if (!payload || key === null) return text("Malformed manifest", 400);

  if (key !== `PermitMonitorSetup-${payload.version.text}.exe`) return text("Manifest does not match a published installer", 409);
  const installer = await stored("head", key, () => env.BUCKET.head(key));

  if (installer._tag !== "ok") return unavailable(installer);
  const recorded = installer.value ? recordedSha256(installer.value) : null;

  // Installers stored before hashes were recorded are matched by size alone.
  if (!installer.value || installer.value.size !== payload.size || (recorded !== null && recorded !== payload.sha256)) {
    return text("Manifest does not match a published installer", 409);
  }

  const current = await publishedManifest(env);

  if (current._tag === "refused") return current.response;
  const candidate = { version: payload.version, text: read.text };
  const decision = decideManifestReplacement(current._tag === "found" ? current.manifest : null, candidate);

  if (decision._tag === "unchanged") return Response.json({ version: payload.version.text, status: "unchanged" });

  if (decision._tag === "stale") return text(`Version ${payload.version.text} is older than published ${decision.published}`, 409);

  if (decision._tag === "conflict") return text(`A different manifest for ${decision.published} is already published`, 409);
  const httpMetadata = { contentType: "application/json" };

  const put = await stored("put", MANIFEST, () => current._tag === "found"
    ? env.BUCKET.put(MANIFEST, read.text, { httpMetadata, onlyIf: { etagMatches: current.etag } })
    : env.BUCKET.put(MANIFEST, read.text, { httpMetadata }));

  if (put._tag !== "ok") return unavailable(put);

  if (!put.value) return text("The published manifest changed during this upload; retry", 409);

  return Response.json({ version: payload.version.text, status: "published" });
}

async function publishedManifest(env: FeedEnv): Promise<PublishedRead> {
  const object = await stored("get", MANIFEST, () => env.BUCKET.get(MANIFEST));

  if (object._tag !== "ok") return { _tag: "refused", response: unavailable(object) };

  if (!object.value) return { _tag: "absent" };
  const found = object.value;
  const body = await stored("get", MANIFEST, () => found.text());

  if (body._tag !== "ok") return { _tag: "refused", response: unavailable(body) };
  const payload = parseManifest(body.value);

  // Replacing an unreadable manifest would bypass the version rule, so that is left to a person.
  if (!payload) return { _tag: "refused", response: text("Published manifest is unreadable; replace it by hand", 500) };

  return { _tag: "found", manifest: { version: payload.version, text: body.value }, etag: found.etag };
}
