import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** The update feed origin that test manifests and Worker requests use; nothing in the tests contacts the real host. */
export const FEED_ORIGIN = "https://permitmon-updates.example.test";

/** Signs the manifests `releaseManifest` builds. The feed Worker and publish scripts don't verify it, so any key works. */
const signingKey = generateKeyPairSync("ed25519").privateKey;

/** What a signed manifest says about one release. */
export interface ReleasePayload {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly publisher: string;
}

/**
 * Hash bytes the way release manifests and bucket metadata record them.
 *
 * @param value - The bytes, or text hashed as UTF-8.
 * @returns The SHA-256 digest as lowercase hex.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Sign `payload` the way scripts/sign-release-manifest.mjs does.
 *
 * @param payload - The release the envelope describes; tests pass invalid values to exercise verification.
 * @param privateKey - The Ed25519 key to sign with.
 * @returns The envelope as JSON: the base64 payload bytes and their base64 signature.
 */
export function signedEnvelope(payload: ReleasePayload, privateKey: KeyObject): string {
  const signed = Buffer.from(JSON.stringify(payload));

  return JSON.stringify({
    signed: signed.toString("base64"),
    signature: sign(null, signed, privateKey).toString("base64"),
  });
}

/**
 * Build the signed manifest a release job writes for an installer whose bytes are `installer`.
 *
 * @param version - The release version; the installer URL names it under FEED_ORIGIN.
 * @param installer - The installer's contents, which the manifest's hash and size describe.
 * @param publisher - The Authenticode publisher the manifest names; empty for an unsigned build.
 * @returns The same text for the same arguments throughout a test file, so tests can compare stored manifests.
 */
export function releaseManifest(version: string, installer: string, publisher = ""): string {
  return signedEnvelope(
    {
      version,
      url: `${FEED_ORIGIN}/PermitMonitorSetup-${version}.exe`,
      sha256: sha256(installer),
      size: Buffer.byteLength(installer),
      publisher,
    },
    signingKey,
  );
}
