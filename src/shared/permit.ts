import { z } from "zod";
import type { KeyState } from "./bridge.js";
import { PROJECT_NUMBER_MAX, PROJECT_NUMBER_PATTERN } from "./projects.js";
import { accelaModules, getAutomatedJurisdiction, getJurisdiction, JURISDICTIONS, numberExample, recordHost, usesGlobalSearch, type AutomatedJurisdictionProfile, type JurisdictionId, type JurisdictionProfile } from "./jurisdictions.js";

export const HILLSBOROUGH_ID = "hillsborough-county-building" as const;

export const runOutcomeSchema = z.enum([
  "success",
  "not_found_in_supported_search",
  "ambiguous",
  "identity_mismatch",
  "status_unavailable",
  "record_link_unavailable",
  "unsupported_page",
  "blocked",
  "api_unavailable",
  "authentication_error",
  "browser_error",
  "timeout",
  "cancelled",
]);

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

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

export type { PreferenceKey } from "./bridge.js";

export interface AppSnapshot {
  /**
   * Increases with every snapshot main reads, in the order it read them. A window that has shown one revision ignores
   * any lower one that arrives later.
   */
  revision: number;
  permits: PermitRow[];
  preferences: AppPreferences;
  keyState: KeyState;
  appVersion: string;
  monitoring: "manual" | "scheduled";
  /** Daily scheduled check times as sorted "HH:MM" strings. */
  checkTimes: string[];
}

/** Label stored on observations the user entered from a hand-checked portal. */
export const MANUAL_STATUS_LABEL = "Status (entered by hand)";

export const manualStatusSchema = z.object({
  permitId: z.uuid(),
  status: z.string().trim().min(1).max(200).regex(/^\P{Cc}+$/u),
  recordUrl: z.string().trim().max(2000),
});

export const permitNumberSchema = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, "Use the full permit number with its hyphens, dots, and zeros.");

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
  const [, year, serial] = /^(\d{2})\s*-\s*(\d{1,8})$/.exec(value.trim()) ?? [];

  return year !== undefined && serial !== undefined ? { year, serial } : null;
}

function usesApplicationNumber(jurisdictionId: JurisdictionId): boolean {
  return getJurisdiction(jurisdictionId)?.portalFamily === "click2gov";
}

/** An SWFWMD WMIS identifier: an ERP application ID, a permit number with its revision, or a well permit number. */
export type WmisNumber =
  | { kind: "application"; id: number }
  | { kind: "permit"; prefix: string | null; permit: number; revision: number }
  | { kind: "well"; permit: number };

/** Parse a number in the forms each WMIS search accepts; WMIS compares serials without their leading zeros. */
export function parseWmisNumber(value: string, module: string): WmisNumber | null {
  const text = value.trim();

  if (module === "WCP") return /^\d{1,7}$/.test(text) && Number(text) > 0 ? { kind: "well", permit: Number(text) } : null;
  // An ERP permit is written with its two-digit type prefix and six-digit serial, such as 43047590.008;
  // the search and record page show it without them, such as 47590.008.
  const [, typePrefix, prefixedPermit, prefixedRevision] = (module === "ERP" ? /^(\d{2})(\d{6})\.(\d{3})$/.exec(text) : null) ?? [];
  const [, shortPermit, shortRevision] = /^(\d{1,6})\.(\d{1,3})$/.exec(text) ?? [];

  const parts = typePrefix !== undefined && prefixedPermit !== undefined && prefixedRevision !== undefined
    ? { prefix: typePrefix, permit: prefixedPermit, revision: prefixedRevision }
    : shortPermit !== undefined && shortRevision !== undefined ? { prefix: null, permit: shortPermit, revision: shortRevision } : null;

  if (parts) {
    return Number(parts.permit) > 0
      ? { kind: "permit", prefix: parts.prefix, permit: Number(parts.permit), revision: Number(parts.revision) } : null;
  }

  if (module === "ERP" && /^\d{4,8}$/.test(text) && Number(text) > 0) return { kind: "application", id: Number(text) };

  return null;
}

/**
 * The identity a WMIS page displayed. The worker reports ERP's record heading (with " · Prefix NN" when the
 * record has a type prefix), a water use permit's "permit.revision" result cells, and a well permit's heading.
 */
function parseWmisDisplayed(value: string, module: string): { application: number | null; prefix: string | null; permit: number | null; revision: number | null } | null {
  const text = value.trim();

  if (module === "WCP") {
    const well = /^WCP Detail - (\d+)$/.exec(text);

    return well ? { application: null, prefix: null, permit: Number(well[1]), revision: null } : null;
  }

  if (module === "WUP") {
    const water = /^(\d+)\.(\d+)$/.exec(text);

    return water ? { application: null, prefix: null, permit: Number(water[1]), revision: Number(water[2]) } : null;
  }

  const application = /\(App:\s*(\d+)\)|\bApplication:\s*(\d+)/.exec(text);

  if (!application) return null;
  const permit = /\bPermit:\s*(\d+)\.(\d+)/.exec(text);

  return {
    application: Number(application[1] ?? application[2]),
    prefix: /· Prefix (\d{2})$/.exec(text)?.[1] ?? null,
    permit: permit ? Number(permit[1]) : null,
    revision: permit ? Number(permit[2]) : null,
  };
}

function sameWmisNumber(requested: string, displayed: string, module: string): boolean {
  const input = parseWmisNumber(requested, module);
  const shown = parseWmisDisplayed(displayed, module);

  if (!input || !shown) return false;

  if (input.kind === "application") return shown.application === input.id;

  if (input.kind === "well") return shown.permit === input.permit;

  return shown.permit === input.permit && shown.revision === input.revision &&
    (input.prefix === null || shown.prefix === input.prefix);
}

/**
 * A number in the ePermit system St. Johns River WMD hosts for itself and two other districts: the application or
 * permit number and its sequence, after a type and county prefix where the district uses one, such as
 * ERP-123-255799-1, 2E-131-6688-3, or St. Johns River's 219072-3.
 */
export function parseEpermitNumber(value: string): { prefix: string | null; permit: number; sequence: number } | null {
  const parts = /^(?:([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-)?(\d{1,9})-(\d{1,3})$/.exec(value.trim());

  return parts && Number(parts[2]) > 0
    ? { prefix: parts[1]?.toUpperCase() ?? null, permit: Number(parts[2]), sequence: Number(parts[3]) } : null;
}

/**
 * True when an ePermit result row shows the requested number. A number entered without its prefix matches on the
 * number and sequence, which identify the record by themselves.
 */
export function sameEpermitRowNumber(requested: string, shown: string): boolean {
  const input = parseEpermitNumber(requested);
  const row = parseEpermitNumber(shown);

  return Boolean(input && row && (input.prefix === null || row.prefix === input.prefix) && row.permit === input.permit &&
    row.sequence === input.sequence);
}

/**
 * The worker reports the exactly matching result row's number and the record's own Project Number together,
 * such as "ERP-123-255799-1 · Project Number 255799 - 1", because the record page omits the prefix.
 */
function sameEpermitNumber(requested: string, displayed: string): boolean {
  const input = parseEpermitNumber(requested);
  const [, rowNumber, permit, sequence] = /^(\S+) · Project Number (\d+) - (\d+)$/.exec(displayed.trim()) ?? [];

  return Boolean(input && rowNumber !== undefined && sameEpermitRowNumber(requested, rowNumber) &&
    Number(permit) === input.permit && Number(sequence) === input.sequence);
}

/** The ePermit record link the portal's own Copy Link gives, keyed by permit number and sequence. */
export function epermitRecordUrl(profile: JurisdictionProfile, number: string): string | null {
  const parts = profile.portalFamily === "epermit" ? parseEpermitNumber(number) : null;

  if (!parts) return null;
  const start = new URL(profile.startUrl);

  return `${start.origin}${start.pathname}#/prmtInfo?curId=&hdr=1&usrId=0&offclId=${parts.permit}&seqNo=${parts.sequence}`;
}

/**
 * An SFWMD RegPermitting number: an application, such as 260901-67337, or an ERP (-P, -S, -M), water use (-W), or
 * well construction (-WC) permit, such as 48-112909-P, including older ERP numbers with a trailing modification.
 */
export function parseRegPermittingNumber(value: string): { kind: "application" | "permit"; number: string } | null {
  const text = value.trim().toUpperCase();

  if (/^\d{6}-\d{5}$/.test(text)) return { kind: "application", number: text };

  if (/^\d{2}-\d{5,6}-(?:P|S|M|W|WC)(?:-\d{1,3})?$/.test(text)) return { kind: "permit", number: text };

  return null;
}

/** RegPermitting's record classes: ERP, water use, well construction, and Works of the District. */
const REG_RECORD_CLASSES = ["SFWMD-REG-PERMIT-WORK", "SFWMD-REG-WUPERMIT-WORK", "SFWMD-REG-WCPERMIT-WORK", "SFWMD-REG-WODPERMIT-WORK"];

const REG_ENTRY_PATH = "/prweb/PRAuth/RegExternal";

/**
 * The record link RegPermitting opens without a session, from the record key ("<class> <number>") its own record
 * view carries. The address the page settles on afterward needs a sign-in, so it is never saved.
 */
export function regPermittingRecordUrl(profile: JurisdictionProfile, key: string): string | null {
  const [, recordClass, number] = /^(\S+) (\S+)$/.exec(key.trim()) ?? [];

  if (profile.portalFamily !== "regpermitting" || recordClass === undefined || number === undefined ||
    !REG_RECORD_CLASSES.includes(recordClass) || !parseRegPermittingNumber(number)) return null;

  return `${new URL(profile.startUrl).origin}${REG_ENTRY_PATH}?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=${encodeURIComponent(`${recordClass} ${number.toUpperCase()}`)}`;
}

/** Click2Gov removes leading zeros from the displayed application serial, and WMIS from its permit serials. */
export function sameJurisdictionPermitNumber(requested: string, displayed: string, jurisdictionId: JurisdictionId): boolean {
  const profile = getJurisdiction(jurisdictionId);

  if (profile?.portalFamily === "wmis") return sameWmisNumber(requested, displayed, profile.module);

  if (profile?.portalFamily === "epermit") return sameEpermitNumber(requested, displayed);

  if (profile?.portalFamily === "regpermitting") {
    const input = parseRegPermittingNumber(requested);

    return Boolean(input && input.number === displayed.trim().toUpperCase());
  }

  if (!usesApplicationNumber(jurisdictionId)) return samePermitNumber(requested, displayed);
  const input = parseApplicationNumber(requested);
  const shown = parseApplicationNumber(displayed);

  return Boolean(input && shown && input.year === shown.year && Number(input.serial) === Number(shown.serial));
}

/** Store the zero-padded, displayed, and (for SWFWMD ERP) prefixed forms of one number as one permit. */
export function permitComparisonValue(number: string, jurisdictionId: JurisdictionId): string {
  const profile = getJurisdiction(jurisdictionId);

  if (profile?.portalFamily === "wmis") {
    const wmis = parseWmisNumber(number, profile.module);

    if (wmis?.kind === "application") return `app-${wmis.id}`;

    if (wmis?.kind === "permit") return `${wmis.permit}.${wmis.revision}`;

    if (wmis?.kind === "well") return String(wmis.permit);

    return number;
  }

  if (profile?.portalFamily === "regpermitting") return parseRegPermittingNumber(number)?.number ?? number;

  if (profile?.portalFamily === "epermit") {
    // The number and sequence identify the record, so a number entered with and without its prefix is one permit.
    const parts = parseEpermitNumber(number);

    return parts ? `${parts.permit}-${parts.sequence}` : number;
  }

  const parts = usesApplicationNumber(jurisdictionId) ? parseApplicationNumber(number) : null;

  return parts ? `${parts.year}-${Number(parts.serial)}` : number;
}

/** Why a number can't be searched on the authority's portal, or null when the portal accepts its form. */
export function permitNumberProblem(jurisdictionId: JurisdictionId, number: string): string | null {
  const profile = getJurisdiction(jurisdictionId);

  if (profile?.portalFamily === "click2gov" && !parseApplicationNumber(number)) {
    return `Use the ${profile.label} application number as YY-serial, for example 25-05001277.`;
  }

  if ((profile?.portalFamily === "wmis" && !parseWmisNumber(number, profile.module)) ||
    (profile?.portalFamily === "epermit" && !parseEpermitNumber(number)) ||
    (profile?.portalFamily === "regpermitting" && !parseRegPermittingNumber(number))) {
    return `Use the number as the district writes it, for example ${numberExample(profile)}.`;
  }

  return null;
}

/** Each WMIS program's public record page and the numeric parameters that identify a record. */
const WMIS_RECORD_PAGES: Record<Extract<JurisdictionProfile, { portalFamily: "wmis" }>["module"], { path: string; params: readonly string[] }> = {
  ERP: { path: "/ERP/ERP/Entry/ERP.aspx", params: ["id"] },
  WUP: { path: "/Support/WUP/WupSimple.aspx", params: ["st", "rev"] },
  WCP: { path: "/Support/WCP/WcpDetail.aspx", params: ["permit"] },
};

/** The HTTPS record page for a WMIS record, built from the identifiers the search results displayed. */
export function wmisRecordUrl(profile: JurisdictionProfile, values: Record<string, number>): string | null {
  if (profile.portalFamily !== "wmis") return null;
  const record = WMIS_RECORD_PAGES[profile.module];

  if (!record.params.every((name) => Number.isSafeInteger(values[name]))) return null;
  const url = new URL(`https://${recordHost(profile)}${record.path}`);

  for (const name of record.params) url.searchParams.set(name, String(values[name]));

  return url.toString();
}

/** True when a WMIS record link names the same record as the identity the page displayed. */
function wmisLinkMatches(recordUrl: URL, displayed: string, module: string): boolean {
  const shown = parseWmisDisplayed(displayed, module);
  const value = (name: string) => Number(recordUrl.searchParams.get(name));

  if (!shown) return false;

  if (module === "ERP") return shown.application === value("id");

  if (module === "WUP") return shown.permit === value("st") && shown.revision === value("rev");

  return shown.permit === value("permit");
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

  if (url.protocol !== "https:" || ![start.host, recordHost(profile)].includes(url.host) || url.username || url.password) return null;

  // A hand-checked portal's pages are whatever the user linked on the official host.
  if (profile.portalFamily === "manual") return url;

  if (profile.portalFamily === "wmis") {
    if (url.hash) return null;

    // The search is one ASP.NET page that posts back to itself; record pages are identified by numbers only.
    if (page === "search") {
      return url.host === start.host && url.pathname.toLowerCase() === start.pathname.toLowerCase() && !url.search ? url : null;
    }

    const record = WMIS_RECORD_PAGES[profile.module];
    const names = [...url.searchParams.keys()];

    return record && url.host === recordHost(profile) && url.pathname.toLowerCase() === record.path.toLowerCase() &&
      names.length === record.params.length && record.params.every((name) => /^\d{1,8}$/.test(url.searchParams.get(name) ?? ""))
      ? url : null;
  }

  if (profile.portalFamily === "regpermitting") {
    // The entry page opens the app, whose pages all live under one session path; a record opens from the entry
    // page with its record key. Search and record views can't be told apart by address.
    if (url.hash) return null;
    const names = [...url.searchParams.keys()];

    if (page === "search") {
      return (url.pathname === REG_ENTRY_PATH && names.length === 0) ||
        /^\/prweb\/PRAuth\/app\/(?:RegulationExternal|default)\/[^/]+\/!STANDARD$/.test(url.pathname) ? url : null;
    }

    const key = url.searchParams.get("key");

    return url.pathname === REG_ENTRY_PATH && names.length === 3 && url.searchParams.get("pyActivity") === "@baseclass.doUIAction" &&
      url.searchParams.get("action") === "openWorkByHandle" && key && regPermittingRecordUrl(profile, key) === url.toString() ? url : null;
  }

  if (profile.portalFamily === "epermit") {
    // One single-page app per district; its routes live in the hash, and every route rewrites itself to #/ep.
    if (url.host !== start.host || url.pathname !== start.pathname || url.search) return null;

    if (page === "search") return ["", "#/ep", "#/ep?target=srch"].includes(url.hash) ? url : null;

    return /^#\/prmtInfo\?curId=&hdr=1&usrId=0&offclId=\d{1,9}&seqNo=\d{1,3}$/.test(url.hash) ? url : null;
  }

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

  if (page === "search" && usesGlobalSearch(jurisdictionId)) {
    const tenantPath = `/${profile.tenant}`.toLowerCase();
    const searchPath = url.pathname.toLowerCase();

    if (searchPath === `${tenantPath}/default.aspx` || searchPath === `${tenantPath}/cap/globalsearchresults.aspx`) return url;
  }

  const path = page === "search" ? `/${profile.tenant}/Cap/CapHome.aspx` : `/${profile.tenant}/Cap/CapDetail.aspx`;

  if (url.pathname.toLowerCase() !== path.toLowerCase()) return null;

  const values = (name: string): string[] => [...url.searchParams.entries()]
    .flatMap(([key, entry]) => key.toLowerCase() === name.toLowerCase() ? [entry] : []);

  const allowedModules = accelaModules(profile).map((module) => module.toLowerCase());

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
const STATUS_LABELS = {
  "accela": "Record Status",
  "click2gov": "Application Status",
  "tyler-civic-access": "Status",
} as const;

/** The record-level status label for an authority; a profile names its own when its programs differ. */
export function expectedStatusLabel(profile: AutomatedJurisdictionProfile): string {
  return statusLabels(profile)[0];
}

/** Every label the authority's record-level status can carry; SFWMD labels applications and permits differently. */
export function statusLabels(profile: AutomatedJurisdictionProfile): readonly [string, ...string[]] {
  if ("statusLabels" in profile) return profile.statusLabels;

  return ["statusLabel" in profile ? profile.statusLabel : STATUS_LABELS[profile.portalFamily]];
}

export function parseDisplayedStatus(input: {
  jurisdictionId: JurisdictionId;
  requestedNumber: string;
  displayedNumber: string;
  statusLabel: string;
  statusValue: string;
  recordUrl: string;
  observedAt: string;
}): { _tag: "ok"; value: Omit<ObservationRow, "id" | "runId" | "permitId"> } | { _tag: "err"; outcome: Exclude<RunOutcome, "success"> } {
  const { jurisdictionId } = input;
  const profile = getAutomatedJurisdiction(jurisdictionId);

  if (!profile) return { _tag: "err", outcome: "unsupported_page" };

  if (!sameJurisdictionPermitNumber(input.requestedNumber, input.displayedNumber, jurisdictionId)) return { _tag: "err", outcome: "identity_mismatch" };
  const label = input.statusLabel.trim().replace(/:$/, "");

  if (!statusLabels(profile).includes(label)) return { _tag: "err", outcome: "status_unavailable" };
  // An SFWMD permit's status is its Permit Status; an application's is its own status, not its permit's.
  const regNumber = profile.portalFamily === "regpermitting" ? parseRegPermittingNumber(input.requestedNumber) : null;

  if (regNumber && (regNumber.kind === "permit") !== (label === "Permit Status")) return { _tag: "err", outcome: "status_unavailable" };
  const status = input.statusValue.trim();

  if (!status || /\p{Cc}/u.test(status)) return { _tag: "err", outcome: "status_unavailable" };
  const recordUrl = parsePortalUrl(input.recordUrl, "detail", jurisdictionId);

  if (!recordUrl) return { _tag: "err", outcome: "record_link_unavailable" };

  if (profile.portalFamily === "wmis" && !wmisLinkMatches(recordUrl, input.displayedNumber, profile.module)) {
    return { _tag: "err", outcome: "record_link_unavailable" };
  }

  if (profile.portalFamily === "epermit" && recordUrl.toString() !== epermitRecordUrl(profile, input.requestedNumber)) {
    return { _tag: "err", outcome: "record_link_unavailable" };
  }

  if (profile.portalFamily === "regpermitting" &&
    recordUrl.searchParams.get("key")?.split(" ")[1] !== parseRegPermittingNumber(input.requestedNumber)?.number) {
    return { _tag: "err", outcome: "record_link_unavailable" };
  }

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
