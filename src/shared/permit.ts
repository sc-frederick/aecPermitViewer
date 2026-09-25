import { z } from "zod";
import { PROJECT_NUMBER_MAX, PROJECT_NUMBER_PATTERN } from "./projects.js";
import { getAutomatedJurisdiction, getJurisdiction, JURISDICTIONS, type AutomatedJurisdictionProfile, type JurisdictionId } from "./jurisdictions.js";

export const HILLSBOROUGH_ID = "hillsborough-county-building" as const;
export const JEV_MODEL = "jev-1.13.0" as const;

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
  jurisdictionId: JurisdictionId;
  permitNumber: string;
  /** The user's own job or project number, used to group permits. */
  projectNumber: string | null;
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
  /** Daily scheduled check times as sorted "HH:MM" strings. */
  checkTimes: string[];
}

/** Label stored on observations the user entered from a hand-checked portal. */
export const MANUAL_STATUS_LABEL = "Status (entered by hand)";

export const manualStatusSchema = z.object({
  permitId: z.uuid(),
  status: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f]+$/),
  recordUrl: z.string().trim().max(2000),
});

export const permitNumberSchema = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "Use the full permit number with its hyphens and zeros.");
export const permitIdSchema = z.uuid();
/** An empty value clears the project number. */
export const projectNumberSchema = z.string().trim().max(PROJECT_NUMBER_MAX)
  .regex(PROJECT_NUMBER_PATTERN, "Use letters, numbers, spaces, and - . _ / only.");
export const setProjectNumberSchema = z.object({ permitId: permitIdSchema, projectNumber: projectNumberSchema });
export const addPermitSchema = z.object({
  jurisdiction: z.string().trim().min(1).max(100),
  permitNumber: permitNumberSchema,
});

/** Resolve a selected authority by its id or exact label, so a county is never confused with a city inside it. */
export function resolveJurisdiction(input: string): JurisdictionId | null {
  const name = input.trim().toLocaleLowerCase("en-US");
  return JURISDICTIONS.find((profile) => profile.id === name || profile.label.toLocaleLowerCase("en-US") === name)?.id ?? null;
}

export function samePermitNumber(requested: string, displayed: string): boolean {
  return requested.trim() === displayed.trim();
}

/** Split a Click2Gov application number such as "25-05001277" into its two-digit year and serial. */
export function parseApplicationNumber(value: string): { year: string; serial: string } | null {
  const parts = /^(\d{2})\s*-\s*(\d{1,8})$/.exec(value.trim());
  return parts ? { year: parts[1]!, serial: parts[2]! } : null;
}

function usesApplicationNumber(jurisdictionId: JurisdictionId): boolean {
  return getJurisdiction(jurisdictionId)?.portalFamily === "click2gov";
}

/** Click2Gov removes leading zeros from the displayed application serial. */
export function sameJurisdictionPermitNumber(requested: string, displayed: string, jurisdictionId: JurisdictionId): boolean {
  if (!usesApplicationNumber(jurisdictionId)) return samePermitNumber(requested, displayed);
  const input = parseApplicationNumber(requested);
  const shown = parseApplicationNumber(displayed);
  return Boolean(input && shown && input.year === shown.year && Number(input.serial) === Number(shown.serial));
}

/** Store Click2Gov's zero-padded and displayed serial forms as one permit. */
export function permitComparisonValue(number: string, jurisdictionId: JurisdictionId): string {
  const parts = usesApplicationNumber(jurisdictionId) ? parseApplicationNumber(number) : null;
  return parts ? `${parts.year}-${Number(parts.serial)}` : number;
}

/** Accept only pages on the chosen authority's public permit portal. */
export function parsePortalUrl(value: string, page: "search" | "detail", jurisdictionId: JurisdictionId): URL | null {
  const profile = getJurisdiction(jurisdictionId);
  if (!profile) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const start = new URL(profile.startUrl);
  if (url.protocol !== "https:" || url.host !== start.host || url.username || url.password) return null;
  // A hand-checked portal's pages are whatever the user linked on the official host.
  if (profile.portalFamily === "manual") return url;
  if (profile.portalFamily !== "accela") {
    const path = url.pathname.toLowerCase();
    if (profile.portalFamily === "click2gov") {
      if (!path.startsWith("/click2govbp/")) return null;
      if (!path.endsWith("/selectpermit.html")) return null;
      const detail = url.searchParams.get("validatePermitView") === "true" &&
        Boolean(url.searchParams.get("permit.appYear")) && Boolean(url.searchParams.get("permit.appNumber"));
      return page === "search" ? (!detail ? url : null) : (detail ? url : null);
    }
    if (profile.portalFamily === "tyler-civic-access") {
      if (!path.startsWith("/apps/selfservice")) return null;
      return page === "search" ? (url.hash === "" || /home|search/i.test(url.hash) ? url : null)
        : (/permit|case|plan/i.test(url.hash) ? url : null);
    }
    return null;
  }
  if (url.hash) return null;
  const path = page === "search" ? `/${profile.tenant}/Cap/CapHome.aspx` : `/${profile.tenant}/Cap/CapDetail.aspx`;
  if (url.pathname.toLowerCase() !== path.toLowerCase()) return null;
  const values = (name: string): string[] => [...url.searchParams.entries()]
    .filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, entry]) => entry);
  const allowedModules = jurisdictionId === "pasco-county-building" ? ["building", "permits"] : [profile.module.toLowerCase()];
  if (values("TabName").length !== 1 || !allowedModules.includes(values("TabName")[0]?.toLowerCase() ?? "")) return null;
  const moduleValues = values("Module");
  if (moduleValues.length !== 1) return null;
  const moduleValue = moduleValues[0];
  if (moduleValue?.toLowerCase() !== values("TabName")[0]?.toLowerCase()) return null;
  if (page === "detail") {
    if (values("agencyCode").length !== 1 || values("agencyCode")[0]?.toLowerCase() !== profile.tenant.toLowerCase()) return null;
    if (!["capID1", "capID2", "capID3"].every((key) => values(key).length === 1 && Boolean(values(key)[0]))) return null;
  }
  return url;
}

/** The record-level status field each portal family labels on its detail page. */
export const STATUS_LABELS: Record<AutomatedJurisdictionProfile["portalFamily"], string> = {
  "accela": "Record Status",
  "click2gov": "Application Status",
  "tyler-civic-access": "Status",
};

export function parseDisplayedStatus(input: {
  jurisdictionId: JurisdictionId;
  requestedNumber: string;
  displayedNumber: string;
  statusLabel: string;
  statusValue: string;
  recordUrl: string;
  observedAt: string;
}): { _tag: "ok"; value: Omit<ObservationRow, "id" | "runId" | "permitId"> } | { _tag: "err"; outcome: RunOutcome } {
  const { jurisdictionId } = input;
  const profile = getAutomatedJurisdiction(jurisdictionId);
  if (!profile) return { _tag: "err", outcome: "unsupported_page" };
  if (!sameJurisdictionPermitNumber(input.requestedNumber, input.displayedNumber, jurisdictionId)) return { _tag: "err", outcome: "identity_mismatch" };
  if (input.statusLabel.trim().replace(/:$/, "") !== STATUS_LABELS[profile.portalFamily]) return { _tag: "err", outcome: "status_unavailable" };
  const status = input.statusValue.trim();
  if (!status || /[\u0000-\u001f]/.test(status)) return { _tag: "err", outcome: "status_unavailable" };
  const recordUrl = parsePortalUrl(input.recordUrl, "detail", jurisdictionId);
  if (!recordUrl) return { _tag: "err", outcome: "record_link_unavailable" };
  if (usesApplicationNumber(jurisdictionId)) {
    const linkedNumber = `${recordUrl.searchParams.get("permit.appYear")}-${recordUrl.searchParams.get("permit.appNumber")}`;
    if (!sameJurisdictionPermitNumber(input.requestedNumber, linkedNumber, jurisdictionId)) {
      return { _tag: "err", outcome: "record_link_unavailable" };
    }
  }
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
