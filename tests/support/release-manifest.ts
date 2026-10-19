import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const FEED_ORIGIN = "https://permitmon-updates.example.test";

const signingKey = generateKeyPairSync("ed25519").privateKey;

export interface ReleasePayload {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly publisher: string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signedEnvelope(payload: ReleasePayload, privateKey: KeyObject): string {
  const signed = Buffer.from(JSON.stringify(payload));

  return JSON.stringify({
    signed: signed.toString("base64"),
    signature: sign(null, signed, privateKey).toString("base64"),
  });
}

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
