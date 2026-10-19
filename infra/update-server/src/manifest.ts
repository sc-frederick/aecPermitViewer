import { z } from "zod";

export interface ReleaseVersion {
  readonly text: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

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

export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const jsonText = z.string().transform((value, context): z.core.util.JSONType => {
  try {
    return JSON.parse(value);
  } catch {
    return invalid(context, "text is not JSON");
  }
});

const envelopeText = jsonText.pipe(z.object({ signed: z.base64(), signature: z.base64() }));

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

export type ManifestPayload = z.infer<typeof payloadText>;

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseManifest(manifestText: string): ManifestPayload | null {
  const envelope = envelopeText.safeParse(manifestText);

  if (!envelope.success) return null;
  const signed = decodeUtf8(Uint8Array.from(atob(envelope.data.signed), (character) => character.charCodeAt(0)));
  const payload = signed === null ? null : payloadText.safeParse(signed);

  return payload?.success ? payload.data : null;
}
