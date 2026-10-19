import type { ReleaseVersion } from "./manifest.js";

export interface InstallerIdentity {
  readonly size: number;
  readonly sha256: string | null;
}

export interface InstallerCandidate {
  readonly size: number;
  readonly sha256: string;
}

export type InstallerDecision =
  | { readonly _tag: "upload" }
  | { readonly _tag: "already_published" }
  | { readonly _tag: "conflict"; readonly reason: string }
  | { readonly _tag: "unverified" };

export interface VersionedManifest {
  readonly version: ReleaseVersion;
  readonly text: string;
}

export type ManifestDecision =
  | { readonly _tag: "replace" }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "stale"; readonly published: string }
  | { readonly _tag: "conflict"; readonly published: string };

export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function decideInstallerUpload(
  existing: InstallerIdentity | null,
  candidate: InstallerCandidate,
): InstallerDecision {
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

export function decideManifestReplacement(
  published: VersionedManifest | null,
  candidate: VersionedManifest,
): ManifestDecision {
  if (!published) return { _tag: "replace" };
  const order = compareReleaseVersions(candidate.version, published.version);

  if (order > 0) return { _tag: "replace" };

  if (order < 0) return { _tag: "stale", published: published.version.text };

  return candidate.text === published.text
    ? { _tag: "unchanged" }
    : { _tag: "conflict", published: published.version.text };
}
