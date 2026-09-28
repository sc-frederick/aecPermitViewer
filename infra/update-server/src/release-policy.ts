// Publication rules for the update feed, shared by the Worker's manual upload path and the CI release
// job. Versioned installers are immutable once published, and the current manifest only moves forward.
// The publication scripts load this file through Node's type stripping, so it may only import types and must
// avoid TypeScript syntax that needs code generation (enums, parameter properties).
import type { ReleaseVersion } from "./manifest.js";

/** What the feed knows about a stored installer: its byte count and, when recorded at upload, its SHA-256. */
export interface InstallerIdentity {
  readonly size: number;
  readonly sha256: string | null;
}

/** The installer a publisher intends to store, identified by the values in its signed manifest. */
export interface InstallerCandidate {
  readonly size: number;
  readonly sha256: string;
}

/** Whether a versioned installer may be written. `unverified` means the stored object has no recorded hash. */
export type InstallerDecision =
  | { readonly _tag: "upload" }
  | { readonly _tag: "already_published" }
  | { readonly _tag: "conflict"; readonly reason: string }
  | { readonly _tag: "unverified" };

/** A manifest together with the version inside its signed payload. */
export interface VersionedManifest {
  readonly version: ReleaseVersion;
  readonly text: string;
}

/** Whether a candidate manifest may replace the published one. */
export type ManifestDecision =
  | { readonly _tag: "replace" }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "stale"; readonly published: string }
  | { readonly _tag: "conflict"; readonly published: string };

/** Orders two versions numerically by component: negative when `a` is older, zero when equal, positive when newer. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Decides whether a versioned installer may be written. A missing object may be uploaded; an object with the
 * same size and recorded hash is an identical retry; different bytes are a conflict. A same-size object with no
 * recorded hash is `unverified`: the caller must hash the stored bytes itself or refuse.
 */
export function decideInstallerUpload(existing: InstallerIdentity | null, candidate: InstallerCandidate): InstallerDecision {
  if (!existing) return { _tag: "upload" };

  if (existing.size !== candidate.size) {
    return { _tag: "conflict", reason: `stored installer is ${existing.size} bytes, not ${candidate.size}` };
  }

  if (existing.sha256 === null) return { _tag: "unverified" };

  if (existing.sha256.toLowerCase() !== candidate.sha256.toLowerCase()) {
    return { _tag: "conflict", reason: `stored installer has SHA-256 ${existing.sha256}, not ${candidate.sha256}` };
  }

  return { _tag: "already_published" };
}

/**
 * Decides whether `candidate` may become the current manifest. Only a strictly newer version replaces the
 * published one. Re-sending the identical manifest is a no-op, so a publication retry succeeds.
 */
export function decideManifestReplacement(published: VersionedManifest | null, candidate: VersionedManifest): ManifestDecision {
  if (!published) return { _tag: "replace" };
  const order = compareReleaseVersions(candidate.version, published.version);

  if (order > 0) return { _tag: "replace" };

  if (order < 0) return { _tag: "stale", published: published.version.text };

  return candidate.text === published.text ? { _tag: "unchanged" } : { _tag: "conflict", published: published.version.text };
}
