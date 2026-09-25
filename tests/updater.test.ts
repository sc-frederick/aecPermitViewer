import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyReleaseEnvelope } from "../src/main/updater.js";

describe("signed update metadata", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

  const payload = { version: "0.2.0", url: "https://updates.example.test/PermitMonitorSetup.exe",
    sha256: "a".repeat(64), size: 250_000_000, publisher: "Permit Monitor LLC" };

  function envelope(value: typeof payload): string {
    const signed = Buffer.from(JSON.stringify(value));

    return JSON.stringify({ signed: signed.toString("base64"), signature: sign(null, signed, keys.privateKey).toString("base64") });
  }

  it("accepts a signed installer hash and expected publisher", () => {
    expect(verifyReleaseEnvelope(envelope(payload), publicKey, "Permit Monitor LLC")).toEqual(payload);
  });

  it("accepts an unsigned-build manifest only when no publisher is expected", () => {
    const unsigned = { ...payload, publisher: "" };
    expect(verifyReleaseEnvelope(envelope(unsigned), publicKey, "")).toEqual(unsigned);
    expect(() => verifyReleaseEnvelope(envelope(unsigned), publicKey, "Permit Monitor LLC")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope(payload), publicKey, "")).toThrow();
  });

  it("rejects a manifest signed by another key", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => verifyReleaseEnvelope(envelope(payload), other, "Permit Monitor LLC")).toThrow();
  });

  it("rejects altered metadata, wrong publisher, and non-HTTPS installer", () => {
    const valid = JSON.parse(envelope(payload));
    valid.signed = Buffer.from(JSON.stringify({ ...payload, sha256: "b".repeat(64) })).toString("base64");
    expect(() => verifyReleaseEnvelope(JSON.stringify(valid), publicKey, "Permit Monitor LLC")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope(payload), publicKey, "Other Publisher")).toThrow();
    expect(() => verifyReleaseEnvelope(envelope({ ...payload, url: "http://updates.example.test/app.exe" }), publicKey, "Permit Monitor LLC")).toThrow();
  });
});
