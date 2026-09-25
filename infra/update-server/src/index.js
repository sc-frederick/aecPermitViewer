// Serves Permit Monitor installers and the signed update manifest from R2, and accepts
// release uploads from CI. The app trusts only the Ed25519 signature on the manifest, so this
// Worker is a delivery path, not a trust anchor.
const MANIFEST = "release-manifest.json";

const INSTALLER = /^PermitMonitorSetup-\d+\.\d+\.\d+\.exe$/;

const MANIFEST_MAX_BYTES = 32_768;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname.slice(1));

    if (name.startsWith("upload/")) return upload(request, env, url, name.slice("upload/".length));

    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);

    if (name === "" || name === "PermitMonitorSetup.exe") return latest(env, url);

    if (name === MANIFEST) return serve(request, env, name, "no-cache");

    if (INSTALLER.test(name)) return serve(request, env, name, "public, max-age=31536000, immutable");

    return text("Not found", 404);
  },
};

function text(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function payloadOf(envelopeText) {
  const envelope = JSON.parse(envelopeText);

  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(envelope.signed), (c) => c.charCodeAt(0))));
}

// Stable link for handing the current installer to someone new.
async function latest(env, url) {
  const manifest = await env.BUCKET.get(MANIFEST);

  if (!manifest) return text("No release published yet", 404);
  const { version } = payloadOf(await manifest.text());

  return Response.redirect(new URL(`/PermitMonitorSetup-${version}.exe`, url).toString(), 302);
}

async function serve(request, env, key, cacheControl) {
  const head = request.method === "HEAD";
  let object;

  try {
    object = head ? await env.BUCKET.head(key) : await env.BUCKET.get(key, { range: request.headers });
  } catch {
    return text("Range not satisfiable", 416);
  }

  if (!object) return text("Not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cacheControl);
  headers.set("accept-ranges", "bytes");

  if (key !== MANIFEST) headers.set("content-disposition", `attachment; filename="${key}"`);

  if (head) {
    headers.set("content-length", String(object.size));

    return new Response(null, { headers });
  }

  if (request.headers.has("range") && object.range) {
    const range = object.range;
    const start = "suffix" in range ? object.size - range.suffix : (range.offset ?? 0);
    const end = "length" in range && range.length !== undefined ? start + range.length - 1 : object.size - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);

    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}

async function authorized(request, env) {
  if (!env.UPLOAD_TOKEN) return false;
  const encoder = new TextEncoder();
  const given = await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? ""));
  const expected = await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`));

  return crypto.subtle.timingSafeEqual(given, expected);
}

// CI protocol: installer parts through an R2 multipart upload (Worker request bodies are capped
// at 100 MB), then the manifest last. The installer the live manifest points to is never
// overwritten; any other one can be, so a failed release run can simply be retried.
async function upload(request, env, url, key) {
  if (!(await authorized(request, env))) return text("Unauthorized", 401);

  if (key === MANIFEST && request.method === "PUT") return putManifest(request, env);

  if (!INSTALLER.test(key)) return text("Not found", 404);
  const uploadId = url.searchParams.get("uploadId");

  if (request.method === "POST" && !uploadId) {
    const manifest = await env.BUCKET.get(MANIFEST);

    if (manifest && `PermitMonitorSetup-${payloadOf(await manifest.text()).version}.exe` === key) {
      return text("Installer already published", 409);
    }

    const multipart = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/vnd.microsoft.portable-executable" },
    });

    return Response.json({ uploadId: multipart.uploadId });
  }

  if (!uploadId) return text("Missing uploadId", 400);
  const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);

  if (request.method === "PUT") {
    const partNumber = Number(url.searchParams.get("partNumber"));

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body) return text("Bad part", 400);
    const part = await multipart.uploadPart(partNumber, request.body);

    return Response.json(part);
  }

  if (request.method === "POST") {
    const { parts } = await request.json();
    const object = await multipart.complete(parts);

    return Response.json({ size: object.size });
  }

  if (request.method === "DELETE") {
    await multipart.abort();

    return new Response(null, { status: 204 });
  }

  return text("Method not allowed", 405);
}

// Refuse a manifest whose installer isn't already in place at the advertised size, so clients
// never see a version they can't download.
async function putManifest(request, env) {
  const body = await request.text();

  if (body.length > MANIFEST_MAX_BYTES) return text("Manifest too large", 413);
  let payload, key;

  try {
    payload = payloadOf(body);
    key = decodeURIComponent(new URL(payload.url).pathname.slice(1));
  } catch {
    return text("Malformed manifest", 400);
  }

  const installer = INSTALLER.test(key) ? await env.BUCKET.head(key) : null;

  if (!installer || installer.size !== payload.size || key !== `PermitMonitorSetup-${payload.version}.exe`) {
    return text("Manifest does not match a published installer", 409);
  }

  await env.BUCKET.put(MANIFEST, body, { httpMetadata: { contentType: "application/json" } });

  return Response.json({ version: payload.version });
}
