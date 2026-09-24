import { z } from "zod";

export const HILLSBOROUGH_ID = "hillsborough-county-building" as const;
export const JEV_MODEL = "jev-1.13.0" as const;
export const START_URL = "https://aca-prod.accela.com/HCFL/Cap/CapHome.aspx?module=Building&TabName=Building";
export const HILLSBOROUGH_LABEL = "Hillsborough County government · Building";

export type RunOutcome =
  | "success"
  | "not_found_in_supported_search"
  | "ambiguous"
  | "identity_mismatch"
  | "status_unavailable"
  | "record_link_unavailable"
  | "unsupported_page"
  | "blocked"
  | "api_unavailable"
  | "authentication_error"
  | "browser_error"
  | "timeout"
  | "cancelled";

export interface PermitRow {
  id: string;
  jurisdictionId: typeof HILLSBOROUGH_ID;
  permitNumber: string;
  monitoringEnabled: boolean;
  lastStatus: string | null;
  lastObservedAt: string | null;
  lastRecordUrl: string | null;
  latestAttemptAt: string | null;
  latestOutcome: RunOutcome | null;
  /** When scheduled checks will next pick this permit up, if it is included. */
  nextDueAt: string | null;
  checking: boolean;
}

export interface CheckRunRow {
  id: string;
  permitId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome | null;
  actionCount: number;
  requestCount: number;
}

export interface ObservationRow {
  id: string;
  runId: string;
  permitId: string;
  verifiedPermitNumber: string;
  statusLabel: string;
  statusValue: string;
  observedAt: string;
  recordUrl: string;
}

export interface PermitHistory {
  runs: CheckRunRow[];
  observations: ObservationRow[];
}

export interface AppPreferences {
  notifyStatusChanges: boolean;
  notifyFailures: boolean;
  runInBackground: boolean;
  openAtLogin: boolean;
  /** False when the platform has no usable notification area, so closing the window quits. */
  backgroundAvailable: boolean;
  /** Start-at-sign-in is only offered for the installed Windows app. */
  openAtLoginAvailable: boolean;
}

export type PreferenceKey = "notifyStatusChanges" | "notifyFailures" | "runInBackground" | "openAtLogin";

export interface AppSnapshot {
  permits: PermitRow[];
  preferences: AppPreferences;
  keyState: "configured" | "missing" | "unavailable";
  appVersion: string;
  browserVersion: string;
  monitoring: "manual" | "scheduled";
}

export const permitNumberSchema = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "Use the full permit number with its hyphens and zeros.");
export const permitIdSchema = z.uuid();
export const addPermitSchema = z.object({
  jurisdiction: z.string().trim().min(1).max(100),
  permitNumber: permitNumberSchema,
});

export function resolveJurisdiction(input: string): typeof HILLSBOROUGH_ID | null {
  const name = input.trim().toLocaleLowerCase("en-US");
  if (name === HILLSBOROUGH_LABEL.toLocaleLowerCase("en-US") ||
    name === "hillsborough county government" || name === "hillsborough county, florida") return HILLSBOROUGH_ID;
  return null;
}

export function samePermitNumber(requested: string, displayed: string): boolean {
  return requested.trim() === displayed.trim();
}

export function parsePortalUrl(value: string, page: "search" | "detail"): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "aca-prod.accela.com" || url.username || url.password || url.hash) return null;
  const path = page === "search" ? "/HCFL/Cap/CapHome.aspx" : "/HCFL/Cap/CapDetail.aspx";
  if (url.pathname.toLowerCase() !== path.toLowerCase()) return null;
  const values = (name: string): string[] => [...url.searchParams.entries()]
    .filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, entry]) => entry);
  if (values("TabName").length !== 1 || values("TabName")[0]?.toLowerCase() !== "building") return null;
  const moduleValues = values("Module");
  if (moduleValues.length !== 1) return null;
  const moduleValue = moduleValues[0];
  if (moduleValue?.toLowerCase() !== "building") return null;
  if (page === "detail") {
    if (values("agencyCode").length !== 1 || values("agencyCode")[0] !== "HCFL") return null;
    if (!["capID1", "capID2", "capID3"].every((key) => values(key).length === 1 && Boolean(values(key)[0]))) return null;
  }
  return url;
}

export function parseDisplayedStatus(input: {
  requestedNumber: string;
  displayedNumber: string;
  statusLabel: string;
  statusValue: string;
  recordUrl: string;
  observedAt: string;
}): { _tag: "ok"; value: Omit<ObservationRow, "id" | "runId" | "permitId"> } | { _tag: "err"; outcome: RunOutcome } {
  if (!samePermitNumber(input.requestedNumber, input.displayedNumber)) return { _tag: "err", outcome: "identity_mismatch" };
  if (input.statusLabel.trim().replace(/:$/, "") !== "Record Status") return { _tag: "err", outcome: "status_unavailable" };
  const status = input.statusValue.trim();
  if (!status || /[\u0000-\u001f]/.test(status)) return { _tag: "err", outcome: "status_unavailable" };
  if (!parsePortalUrl(input.recordUrl, "detail")) return { _tag: "err", outcome: "record_link_unavailable" };
  if (Number.isNaN(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString() !== input.observedAt) {
    return { _tag: "err", outcome: "status_unavailable" };
  }
  return {
    _tag: "ok",
    value: {
      verifiedPermitNumber: input.displayedNumber.trim(),
      statusLabel: input.statusLabel.trim(),
      statusValue: status,
      observedAt: input.observedAt,
      recordUrl: input.recordUrl,
    },
  };
}
