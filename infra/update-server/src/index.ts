import { createHash } from "node:crypto";
import { z } from "zod";
import type { FeedBucket, FeedObject, FeedRange } from "./bucket.js";
import { decodeUtf8, jsonText, parseManifest, sha256Hex } from "./manifest.js";
import { decideInstallerUpload, decideManifestReplacement, type VersionedManifest } from "./release-policy.js";

declare const FixedLengthStream: { new (length: number): TransformStream<Uint8Array, Uint8Array> };

/** Bindings from wrangler.jsonc. `UPLOAD_TOKEN` is a secret; without it every upload is refused. */
export interface FeedEnv {
  readonly BUCKET: FeedBucket;
  readonly UPLOAD_TOKEN?: string;
}

const MANIFEST = "release-manifest.json";

const INSTALLER = /^PermitMonitorSetup-\d+\.\d+\.\d+\.exe$/;

const INSTALLER_TYPE = "application/vnd.microsoft.portable-executable";

const MAC_ZIP = /^PermitMonitor-\d+\.\d+\.\d+-mac-arm64\.zip$/;

const MANIFEST_MAX_BYTES = 32_768;

const UPLOAD_REQUEST_MAX_BYTES = 1_048_576;

const RETRY_AFTER_SECONDS = "5";

const installerClaimSchema = z.object({ sha256: sha256Hex, size: z.number().int().positive().max(1_000_000_000) });

type InstallerClaim = z.infer<typeof installerClaimSchema>;

const installerClaimText = jsonText.pipe(installerClaimSchema);

const completionText = jsonText.pipe(
  installerClaimSchema.extend({
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
      .min(1)
      .max(10_000),
  }),
);

type StorageOperation =
  "head" | "get" | "put" | "delete" | "create_multipart" | "upload_part" | "complete_multipart" | "abort_multipart";

interface StorageFailure {
  readonly _tag: "storage_failure";
  readonly operation: StorageOperation;
  readonly key: string;
}

type Stored<T> = { readonly _tag: "ok"; readonly value: T } | StorageFailure;

type BodyRead =
  { readonly _tag: "ok"; readonly text: string } | { readonly _tag: "too_large" } | { readonly _tag: "malformed" };

type PublishedRead =
  | { readonly _tag: "found"; readonly manifest: VersionedManifest; readonly etag: string }
  | { readonly _tag: "absent" }
  | { readonly _tag: "refused"; readonly response: Response };

export default {
  async fetch(request: Request, env: FeedEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = decodePath(url.pathname.slice(1));

    if (name === null) return text("Malformed path", 400);

    if (name.startsWith("upload/")) return upload(request, env, url, name.slice("upload/".length));

    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);

    if (name === "" || name === "PermitMonitorSetup.exe")
      return latest(env, url, (version) => `PermitMonitorSetup-${version}.exe`);

    if (name === "mac") return latest(env, url, (version) => `PermitMonitor-${version}-mac-arm64.zip`);

    if (name === MANIFEST) return serve(request, env, name, "no-cache");

    if (INSTALLER.test(name) || MAC_ZIP.test(name))
      return serve(request, env, name, "public, max-age=31536000, immutable");

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

async function latest(env: FeedEnv, url: URL, file: (version: string) => string): Promise<Response> {
  const manifest = await stored("get", MANIFEST, () => env.BUCKET.get(MANIFEST));

  if (manifest._tag !== "ok") return unavailable(manifest);

  if (!manifest.value) return text("No release published yet", 404);
  const found = manifest.value;
  const body = await stored("get", MANIFEST, () => found.text());

  if (body._tag !== "ok") return unavailable(body);
  const payload = parseManifest(body.value);

  if (!payload) return text("Published manifest is unreadable", 500);

  return Response.redirect(new URL(`/${file(payload.version.text)}`, url).toString(), 302);
}

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

  const given = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")),
  );

  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`)));
  let difference = 0;

  for (let index = 0; index < expected.length; index += 1) difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);

  return difference === 0;
}

async function upload(request: Request, env: FeedEnv, url: URL, key: string): Promise<Response> {
  if (!(await authorized(request, env))) return text("Unauthorized", 401);

  if (key === MANIFEST && request.method === "PUT") return putManifest(request, env);

  if (!INSTALLER.test(key) && !MAC_ZIP.test(key)) return text("Not found", 404);
  const uploadId = url.searchParams.get("uploadId");

  if (request.method === "POST" && !uploadId) return startInstaller(request, env, key);

  if (!uploadId) return text("Missing uploadId", 400);
  const stagingKey = url.searchParams.get("stagingKey");

  if (
    !stagingKey ||
    !stagingKey.startsWith(`_uploads/${key}/`) ||
    !z.uuid().safeParse(stagingKey.slice(`_uploads/${key}/`.length)).success
  )
    return text("Bad staging key", 400);
  const multipart = env.BUCKET.resumeMultipartUpload(stagingKey, uploadId);

  if (request.method === "PUT") {
    const partNumber = Number(url.searchParams.get("partNumber"));

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body)
      return text("Bad part", 400);
    const body = request.body;
    const part = await stored("upload_part", key, () => multipart.uploadPart(partNumber, body));

    return part._tag === "ok" ? Response.json(part.value) : unavailable(part);
  }

  if (request.method === "POST") return completeInstaller(request, env, key, stagingKey, uploadId);

  if (request.method === "DELETE") {
    const aborted = await stored("abort_multipart", stagingKey, () => multipart.abort());

    return aborted._tag === "ok" ? new Response(null, { status: 204 }) : unavailable(aborted);
  }

  return text("Method not allowed", 405);
}

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

  const stagingKey = `_uploads/${key}/${crypto.randomUUID()}`;

  const multipart = await stored("create_multipart", stagingKey, () =>
    env.BUCKET.createMultipartUpload(stagingKey, {
      httpMetadata: { contentType: artifactContentType(key) },
      customMetadata: { sha256: claim.data.sha256 },
    }),
  );

  return multipart._tag === "ok"
    ? Response.json({ status: "created", uploadId: multipart.value.uploadId, stagingKey })
    : unavailable(multipart);
}

function artifactContentType(key: string): string {
  return MAC_ZIP.test(key) ? "application/zip" : INSTALLER_TYPE;
}

async function completeInstaller(
  request: Request,
  env: FeedEnv,
  key: string,
  stagingKey: string,
  uploadId: string,
): Promise<Response> {
  const read = await readBounded(request, UPLOAD_REQUEST_MAX_BYTES);

  if (read._tag !== "ok") return bodyRejection(read);
  const completion = completionText.safeParse(read.text);

  if (!completion.success) return text("Malformed completion request", 400);
  const multipart = env.BUCKET.resumeMultipartUpload(stagingKey, uploadId);
  const refused = await installerGuard(env, key, completion.data);

  if (refused) {
    const aborted = await stored("abort_multipart", stagingKey, () => multipart.abort());

    return aborted._tag === "ok" ? removeStaging(env, stagingKey, refused) : unavailable(aborted);
  }

  const staged = await stored("head", stagingKey, () => env.BUCKET.head(stagingKey));

  if (staged._tag !== "ok") return unavailable(staged);

  const object = staged.value
    ? staged
    : await stored("complete_multipart", stagingKey, () => multipart.complete(completion.data.parts));

  if (object._tag !== "ok") return unavailable(object);

  if (!object.value) return text("Staged upload disappeared; start another upload", 409);
  const recorded = recordedSha256(object.value);

  if (object.value.size !== completion.data.size || recorded !== completion.data.sha256) {
    return removeStaging(env, stagingKey, text("Completed artifact does not match its declared size and SHA-256", 409));
  }

  const digest = await stored("get", stagingKey, async () => {
    const source = await env.BUCKET.get(stagingKey);

    if (!source) return null;
    const hash = createHash("sha256");
    const reader = source.body.getReader();

    try {
      for (;;) {
        const next = await reader.read();

        if (next.done) break;
        hash.update(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    return hash.digest("hex");
  });

  if (digest._tag !== "ok") return unavailable(digest);

  if (digest.value !== completion.data.sha256)
    return removeStaging(env, stagingKey, text("Completed artifact SHA-256 does not match its bytes", 409));
  const source = await stored("get", stagingKey, () => env.BUCKET.get(stagingKey));

  if (source._tag !== "ok") return unavailable(source);

  if (!source.value) return text("Staged upload disappeared; start another upload", 409);
  const stream = new FixedLengthStream(completion.data.size);
  const controller = new AbortController();

  const transfer = source.value.body.pipeTo(stream.writable, { signal: controller.signal }).then(
    () => undefined,
    () => undefined,
  );

  const put = await stored("put", key, () =>
    env.BUCKET.put(key, stream.readable, {
      httpMetadata: { contentType: artifactContentType(key) },
      customMetadata: { sha256: completion.data.sha256 },
      sha256: completion.data.sha256,
      onlyIf: new Headers({ "if-none-match": "*" }),
    }),
  );

  controller.abort();
  await stream.readable.cancel().catch(() => undefined);
  await transfer;

  if (put._tag !== "ok") return unavailable(put);

  const result = put.value
    ? Response.json({ status: "published", size: put.value.size })
    : ((await installerGuard(env, key, completion.data)) ?? text("Artifact publication changed; retry", 409));

  return removeStaging(env, stagingKey, result);
}

async function removeStaging(env: FeedEnv, stagingKey: string, response: Response): Promise<Response> {
  const removed = await stored("delete", stagingKey, () => env.BUCKET.delete(stagingKey));

  return removed._tag === "ok" ? response : unavailable(removed);
}

async function putManifest(request: Request, env: FeedEnv): Promise<Response> {
  const read = await readBounded(request, MANIFEST_MAX_BYTES);

  if (read._tag !== "ok") return bodyRejection(read);
  const payload = parseManifest(read.text);
  const key = payload ? decodePath(new URL(payload.url).pathname.slice(1)) : null;

  if (!payload || key === null) return text("Malformed manifest", 400);

  if (key !== `PermitMonitorSetup-${payload.version.text}.exe`)
    return text("Manifest does not match a published installer", 409);
  const installer = await stored("head", key, () => env.BUCKET.head(key));

  if (installer._tag !== "ok") return unavailable(installer);
  const recorded = installer.value ? recordedSha256(installer.value) : null;

  if (!installer.value || installer.value.size !== payload.size || (recorded !== null && recorded !== payload.sha256)) {
    return text("Manifest does not match a published installer", 409);
  }

  const macKey = `PermitMonitor-${payload.version.text}-mac-arm64.zip`;
  const mac = await stored("head", macKey, () => env.BUCKET.head(macKey));

  if (mac._tag !== "ok") return unavailable(mac);

  if (!mac.value || mac.value.size === 0 || recordedSha256(mac.value) === null) {
    return text("The matching Mac archive must be published before the manifest", 409);
  }

  const current = await publishedManifest(env);

  if (current._tag === "refused") return current.response;
  const candidate = { version: payload.version, text: read.text };
  const decision = decideManifestReplacement(current._tag === "found" ? current.manifest : null, candidate);

  if (decision._tag === "unchanged") return Response.json({ version: payload.version.text, status: "unchanged" });

  if (decision._tag === "stale")
    return text(`Version ${payload.version.text} is older than published ${decision.published}`, 409);

  if (decision._tag === "conflict")
    return text(`A different manifest for ${decision.published} is already published`, 409);
  const httpMetadata = { contentType: "application/json" };

  const put = await stored("put", MANIFEST, () =>
    current._tag === "found"
      ? env.BUCKET.put(MANIFEST, read.text, { httpMetadata, onlyIf: { etagMatches: current.etag } })
      : env.BUCKET.put(MANIFEST, read.text, { httpMetadata, onlyIf: new Headers({ "if-none-match": "*" }) }),
  );

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

  if (!payload) return { _tag: "refused", response: text("Published manifest is unreadable; replace it by hand", 500) };

  return { _tag: "found", manifest: { version: payload.version, text: body.value }, etag: found.etag };
}
