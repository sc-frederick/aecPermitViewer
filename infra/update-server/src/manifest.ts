// The signed release manifest as the feed and the publication scripts read it. Only the payload fields the
// feed checks are parsed here; the app verifies the Ed25519 signature itself (src/main/updater.ts).
// The publication scripts load this file through Node's type stripping, so its only import is the bare
// `zod` specifier and it uses no TypeScript syntax that needs code generation.
import { z } from "zod";

/** A parsed `major.minor.patch` release version, the only form the app's updater accepts. */
export interface ReleaseVersion {
  readonly text: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parses `major.minor.patch`; returns null for anything else, including pre-release suffixes. */
export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const match = VERSION.exec(text);

  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;

  return { text, major, minor, patch };
}

function invalid(context: z.RefinementCtx, message: string): never {
  context.addIssue({ code: "custom", message });

  return z.NEVER;
}

/** Lowercase hex SHA-256, the form the signing script writes and the feed records. */
export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** A string holding JSON, parsed into a JSON value; pipe it into the schema for the expected document. */
export const jsonText = z.string().transform((value, context): z.core.util.JSONType => {
  try {
    return JSON.parse(value);
  } catch {
    return invalid(context, "text is not JSON");
  }
});

const envelopeText = jsonText.pipe(z.object({ signed: z.base64(), signature: z.base64() }));

// Mirrors the app's payload schema, so the feed never publishes a manifest every client would reject.
const payloadText = jsonText.pipe(
  z.object({
    version: z
      .string()
      .transform(
        (value, context) => parseReleaseVersion(value) ?? invalid(context, "version is not major.minor.patch"),
      ),
    url: z.url(),
    sha256: sha256Hex,
    size: z.number().int().positive().max(1_000_000_000),
    publisher: z.string().max(200),
  }),
);

/** The signed payload of a release manifest. */
export type ManifestPayload = z.infer<typeof payloadText>;

/** Strict UTF-8 decoding: returns null instead of substituting replacement characters. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Reads the payload out of a manifest envelope without checking its signature. Returns null when malformed. */
export function parseManifest(manifestText: string): ManifestPayload | null {
  const envelope = envelopeText.safeParse(manifestText);

  if (!envelope.success) return null;
  const signed = decodeUtf8(Uint8Array.from(atob(envelope.data.signed), (character) => character.charCodeAt(0)));
  const payload = signed === null ? null : payloadText.safeParse(signed);

  return payload?.success ? payload.data : null;
}
