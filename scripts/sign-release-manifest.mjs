import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const setupPath = path.resolve("out/make/squirrel.windows/x64/PermitMonitorSetup.exe");
const outputPath = path.resolve("out/make/squirrel.windows/x64/release-manifest.json");
const installerUrl = process.env.UPDATE_INSTALLER_URL;
const publisher = process.env.UPDATE_EXPECTED_PUBLISHER ?? "";
const privateKeyPath = process.env.UPDATE_SIGNING_PRIVATE_KEY_FILE;
const publicKeyBase64 = process.env.UPDATE_PUBLIC_KEY_SPKI_BASE64;
if (!installerUrl || !privateKeyPath || !publicKeyBase64 || new URL(installerUrl).protocol !== "https:") {
  throw new Error("Release manifest signing configuration is incomplete.");
}
const { version } = JSON.parse(await readFile("package.json", "utf8"));
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} does not match package version ${version}.`);
}
const installer = await readFile(setupPath);
const payload = {
  version,
  url: installerUrl,
  sha256: createHash("sha256").update(installer).digest("hex"),
  size: (await stat(setupPath)).size,
  publisher,
};
const signed = Buffer.from(JSON.stringify(payload), "utf8");
const privateKey = createPrivateKey(await readFile(privateKeyPath));
const signature = sign(null, signed, privateKey);
const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
if (!verify(null, signed, publicKey, signature)) throw new Error("Release manifest key pair does not match.");
await writeFile(outputPath, JSON.stringify({ signed: signed.toString("base64"), signature: signature.toString("base64") }));
process.stdout.write(`Signed update manifest for ${version}.\n`);
