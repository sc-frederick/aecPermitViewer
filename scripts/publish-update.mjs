import { open, readFile } from "node:fs/promises";
import path from "node:path";

// Manual publishing path: uploads the installer and then the signed manifest through the update
// server Worker (infra/update-server). Run after sign-release-manifest.mjs, from a network that
// Cloudflare doesn't challenge (GitHub's runners are challenged; CI writes to R2 directly).
const setupPath = path.resolve("out/make/squirrel.windows/x64/PermitMonitorSetup.exe");

const manifestPath = path.resolve("out/make/squirrel.windows/x64/release-manifest.json");

const server = process.env.UPDATE_SERVER_URL;

const token = process.env.UPDATE_UPLOAD_TOKEN;

if (!server || !token || new URL(server).protocol !== "https:") throw new Error("Update upload configuration is incomplete.");

const PART_BYTES = 64 * 1024 * 1024;

const { version } = JSON.parse(await readFile("package.json", "utf8"));

const key = `PermitMonitorSetup-${version}.exe`;

const auth = { authorization: `Bearer ${token}` };

async function call(method, pathname, body, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const init = { method, headers: auth };

      if (body !== undefined) init.body = body;
      const response = await fetch(new URL(pathname, server), init);

      if (response.ok) return response;
      const message = `${method} ${pathname} failed: ${response.status} ${await response.text()}`;

      if (response.status < 500 || attempt >= attempts) throw Object.assign(new Error(message), { final: true });
      process.stdout.write(`${message}; retrying\n`);
    } catch (error) {
      if (error.final || attempt >= attempts) throw error;
      process.stdout.write(`${method} ${pathname} errored: ${error.message}; retrying\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
}

const { uploadId } = await (await call("POST", `/upload/${key}`)).json();

const file = await open(setupPath, "r");

const parts = [];

try {
  const { size } = await file.stat();

  for (let offset = 0, partNumber = 1; offset < size; offset += PART_BYTES, partNumber += 1) {
    const chunk = Buffer.alloc(Math.min(PART_BYTES, size - offset));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);

    if (bytesRead !== chunk.length) throw new Error("Short read from installer");
    const query = `uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
    parts.push(await (await call("PUT", `/upload/${key}?${query}`, chunk)).json());
    process.stdout.write(`Uploaded part ${partNumber} (${Math.min(offset + chunk.length, size)} of ${size} bytes).\n`);
  }

  await call("POST", `/upload/${key}?uploadId=${encodeURIComponent(uploadId)}`, JSON.stringify({ parts }));
} catch (error) {
  await call("DELETE", `/upload/${key}?uploadId=${encodeURIComponent(uploadId)}`, undefined, 1).catch(() => {});
  throw error;
} finally {
  await file.close();
}

const manifest = await readFile(manifestPath, "utf8");

await call("PUT", "/upload/release-manifest.json", manifest);

const live = await (await fetch(new URL("/release-manifest.json", server), { cache: "no-store" })).text();

if (live !== manifest) throw new Error("Published manifest does not match the signed manifest.");

process.stdout.write(`Published ${version} at ${new URL(`/${key}`, server)}.\n`);
