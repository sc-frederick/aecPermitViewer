import type { Page } from "playwright";
import { expectedStatusLabel, parsePortalUrl, parseWmisNumber, sameJurisdictionPermitNumber, wmisRecordUrl } from "../shared/permit.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate } from "../shared/worker-protocol.js";
import type { DisplayedRecord, PortalAdapter, SearchObservation } from "./adapter.js";

/** An SWFWMD permit program searched through its public WMIS page. */
type WmisProfile = Extract<AutomatedJurisdictionProfile, { portalFamily: "wmis" }>;

const ERP = "#TabContainer1_TabPanel1_SearchERPInfo_";
const WUP = "#TabContainer1_TabPanel1_SearchWupInfo1_";
/** Search controls on each program's page. ERP collects numbers in a list with Add before searching. */
const FORMS = {
  ERP: {
    permit: `${ERP}TextBoxWupName`, revision: `${ERP}TextBoxWupRevision`,
    addPermit: `${ERP}ButtonAddPermit`, permitList: `${ERP}ListBoxPermits`,
    application: `${ERP}TextBoxApplicationNo`, addApplication: `${ERP}ButtonAddAppId`, applicationList: `${ERP}ListBoxAppIds`,
    search: "#ButtonSearch",
  },
  WUP: { permit: `${WUP}TextBoxWupName`, revision: `${WUP}TextBoxWupRevision`, search: "#ButtonSearch" },
  WCP: { permit: "#igtxtUltraWebTab1__ctl0_SearchWcpInfo1_TextBoxWcpNumber", search: "#searchButton" },
} as const;
const RESULTS_GRID = "table[id$='_customGrid']";
const NO_RECORDS = "No records matched search criteria. Please try again.";
/** Where the ERP and well construction record pages show their identity and status. */
const RECORD_FIELDS = {
  ERP: {
    heading: "#Detail1_LabelPermitNumberExt",
    prefix: "#Detail1_AjaxPermitTabs_TabPanel1_GeneralInfo_DropDownListPermitPrefix",
    status: "#Detail1_AjaxPermitTabs_TabPanel1_GeneralInfo_DropDownListStatus",
  },
  WCP: { heading: "#lblPermit", status: "#UltraWebTabWcpInfo__ctl0_wcpGeneralInfo_TextBoxAppStatus" },
} as const;

type ResultRow = Record<string, string>;

/** The visible results grid's rows keyed by column heading, or null when no results are shown. */
async function resultRows(page: Page): Promise<ResultRow[] | null> {
  const grid = page.locator(RESULTS_GRID).filter({ visible: true });
  if (await grid.count() !== 1) return null;
  return grid.evaluate((table) => {
    const rows = [...table.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr")];
    const names = [...(rows.find((row) => row.querySelector("th"))?.cells ?? [])].map((cell) => cell.textContent?.trim() ?? "");
    return rows.filter((row) => !row.querySelector("th")).map((row) =>
      Object.fromEntries([...row.cells].map((cell, index) => [names[index] || `column ${index}`, cell.textContent?.trim() ?? ""])));
  });
}

const digits = (value: string | undefined): value is string => /^\d{1,8}$/.test(value ?? "");

/** A result row's identity, written the way the record's own page or the worker reports it. */
function rowIdentity(row: ResultRow, profile: WmisProfile): string | null {
  const permit = row["Permit #"];
  const revision = row["Rev #"];
  if (profile.module === "WCP") return digits(permit) ? `WCP Detail - ${permit}` : null;
  if (profile.module === "WUP") return digits(permit) && digits(revision) ? `${permit}.${revision}` : null;
  const application = row["ERP App ID"];
  if (!digits(application)) return null;
  const prefix = /^\d{2}$/.test(row.Prefix ?? "") ? ` · Prefix ${row.Prefix}` : "";
  return digits(permit) && digits(revision) ? `Permit: ${permit}.${revision} (App: ${application})${prefix}`
    : `Application: ${application}${prefix}`;
}

function exactRows(rows: ResultRow[] | null, profile: WmisProfile, requested: string): ResultRow[] {
  return (rows ?? []).filter((row) => {
    const identity = rowIdentity(row, profile);
    return identity !== null && sameJurisdictionPermitNumber(requested, identity, profile.id);
  });
}

async function listValues(page: Page, selector: string): Promise<string[]> {
  return page.locator(`${selector} option`).allInnerTexts().then((values) => values.map((value) => value.trim()));
}

/** True when the form's search criteria are exactly the requested number and nothing else. */
async function criteriaEntered(page: Page, profile: WmisProfile, requested: string): Promise<boolean> {
  const wanted = parseWmisNumber(requested, profile.module);
  if (!wanted) return false;
  const value = (selector: string) => page.locator(selector).inputValue().catch(() => "");
  if (profile.module === "WCP") return wanted.kind === "well" && await value(FORMS.WCP.permit) === String(wanted.permit);
  if (profile.module === "WUP") {
    const [permit, revision] = [await value(FORMS.WUP.permit), await value(FORMS.WUP.revision)];
    return wanted.kind === "permit" && digits(permit) && digits(revision) &&
      Number(permit) === wanted.permit && Number(revision) === wanted.revision;
  }
  const [permits, applications] = [await listValues(page, FORMS.ERP.permitList), await listValues(page, FORMS.ERP.applicationList)];
  if (wanted.kind === "application") return permits.length === 0 && applications.length === 1 && Number(applications[0]) === wanted.id;
  const listed = /^(\d+)\.(\d+)$/.exec(permits[0] ?? "");
  return wanted.kind === "permit" && applications.length === 0 && permits.length === 1 && Boolean(listed) &&
    Number(listed![1]) === wanted.permit && Number(listed![2]) === wanted.revision;
}

/** Offer the next step on a search page, or report that its results hold the record itself (water use). */
async function observeWmisSearch(page: Page, profile: WmisProfile, requested: string): Promise<SearchObservation> {
  const wanted = parseWmisNumber(requested, profile.module);
  const entered = await criteriaEntered(page, profile, requested);
  const inputValue = entered ? requested : "";
  const rows = entered ? await resultRows(page) : null;
  if (rows) {
    const exact = exactRows(rows, profile, requested);
    const resultNumbers = exact.map((row) => rowIdentity(row, profile)!);
    const visibleControls = ["Search results"];
    // Water use record pages don't show a status, so the matching result row is the record.
    if (exact.length === 1 && profile.module === "WUP") {
      return { phase: "detail", inputValue, formLabels: [], visibleControls, resultNumbers, candidates: [] };
    }
    const candidates: Candidate[] = exact.length === 1 ? [{ id: "open_exact_result",
      description: `Open the record page for the result row whose number exactly matches ${requested}.` }] : [];
    return { phase: exact.length > 1 ? "results" : "search", inputValue, formLabels: [], visibleControls, resultNumbers, candidates };
  }
  const field = page.locator(wanted?.kind === "application" ? FORMS.ERP.application : FORMS[profile.module].permit);
  if (await field.count() !== 1 || !(await field.isVisible()) || !(await field.isEnabled())) {
    return { phase: "search", inputValue, formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  }
  const labels = { ERP: wanted?.kind === "application" ? "ERP App ID" : "Permit and Rev", WUP: "Permit # and Rev #", WCP: "Permit #" };
  const noun = { ERP: "ERP", WUP: "water use permit", WCP: "well construction permit" }[profile.module];
  const candidates: Candidate[] = [];
  if (!entered) {
    candidates.push({ id: "fill_record_number", description: profile.module === "ERP"
      ? `Enter the exact ${wanted?.kind === "application" ? "application ID" : "permit number and revision"} and add it to the ERP search list.`
      : `Fill the ${labels[profile.module]} search fields with the exact ${noun} number.` });
  } else if (!(await page.getByText(NO_RECORDS, { exact: true }).isVisible().catch(() => false))) {
    candidates.push({ id: "search_record_number", description: `Submit the SWFWMD ${noun} search for the exact number.` });
  }
  return { phase: "search", inputValue, formLabels: [labels[profile.module]], visibleControls: [`${labels[profile.module]} search`], resultNumbers: [], candidates };
}

/**
 * True once a search for exactly the requested number returned the portal's no-records message, or only rows
 * whose numbers were read and differ (an ERP permit under another type prefix). Unreadable rows don't count.
 */
async function wmisSearchFoundNothing(page: Page, profile: WmisProfile, requested: string): Promise<boolean> {
  if (!(await criteriaEntered(page, profile, requested))) return false;
  if (await page.getByText(NO_RECORDS, { exact: true }).isVisible().catch(() => false)) return true;
  const rows = await resultRows(page);
  return Boolean(rows && rows.length > 0 && rows.every((row) => rowIdentity(row, profile) !== null) &&
    exactRows(rows, profile, requested).length === 0);
}

async function fillWmisSearch(page: Page, profile: WmisProfile, requested: string): Promise<void> {
  const wanted = parseWmisNumber(requested, profile.module);
  if (!wanted) return;
  if (wanted.kind === "well") {
    await page.locator(FORMS.WCP.permit).fill(String(wanted.permit));
    return;
  }
  if (profile.module === "WUP" && wanted.kind === "permit") {
    await page.locator(FORMS.WUP.permit).fill(String(wanted.permit));
    await page.locator(FORMS.WUP.revision).fill(String(wanted.revision).padStart(3, "0"));
    return;
  }
  if (profile.module !== "ERP") return;
  // Add posts the page back with the number in the search list.
  const [list, add] = wanted.kind === "application"
    ? [FORMS.ERP.applicationList, FORMS.ERP.addApplication] : [FORMS.ERP.permitList, FORMS.ERP.addPermit];
  if (wanted.kind === "application") {
    await page.locator(FORMS.ERP.application).fill(String(wanted.id));
  } else {
    await page.locator(FORMS.ERP.permit).fill(String(wanted.permit));
    await page.locator(FORMS.ERP.revision).fill(String(wanted.revision).padStart(3, "0"));
  }
  await page.locator(add).click({ noWaitAfter: true });
  await page.locator(`${list} option`).first().waitFor({ state: "attached", timeout: 12_000 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

async function submitWmisSearch(page: Page, profile: WmisProfile, requested: string): Promise<void> {
  if (!(await criteriaEntered(page, profile, requested))) return;
  await page.locator(FORMS[profile.module].search).click({ noWaitAfter: true });
  await Promise.any([
    page.locator(RESULTS_GRID).filter({ visible: true }).waitFor({ state: "visible", timeout: 15_000 }),
    page.getByText(NO_RECORDS, { exact: true }).waitFor({ state: "visible", timeout: 15_000 }),
  ]).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

/**
 * Open the record page for the one result row that exactly matches. Result rows link to plain HTTP, so the page is
 * opened on HTTPS from the row's numbers.
 */
async function openWmisResult(page: Page, profile: WmisProfile, requested: string): Promise<void> {
  const exact = exactRows(await resultRows(page), profile, requested);
  if (exact.length !== 1) return;
  const row = exact[0]!;
  const url = profile.module === "ERP" ? wmisRecordUrl(profile, { id: Number(row["ERP App ID"]) })
    : wmisRecordUrl(profile, { permit: Number(row["Permit #"]) });
  if (url && parsePortalUrl(url, "detail", profile.id)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
}

async function selectedText(page: Page, selector: string): Promise<string | null> {
  const select = page.locator(selector);
  if (await select.count() !== 1 || !(await select.isVisible())) return null;
  return select.evaluate((element) => element instanceof HTMLSelectElement
    ? element.options[element.selectedIndex]?.text.trim() ?? null : null);
}

async function labelBefore(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).evaluate((element) => element.previousElementSibling?.textContent?.trim() ?? null).catch(() => null);
}

/** Read the record's displayed identity and record-level status: a record page, or water use's result row. */
async function readWmisRecord(page: Page, profile: WmisProfile, requested: string): Promise<DisplayedRecord> {
  if (profile.module === "WUP") {
    const exact = exactRows(await resultRows(page), profile, requested);
    const row = exact.length === 1 ? exact[0]! : null;
    const label = expectedStatusLabel(profile);
    return {
      displayedNumber: row && rowIdentity(row, profile),
      statusLabel: row && label in row ? label : null,
      statusValue: row?.[label] || null,
      recordUrl: row && wmisRecordUrl(profile, { st: Number(row["Permit #"]), rev: Number(row["Rev #"]) }),
    };
  }
  const fields = RECORD_FIELDS[profile.module];
  const heading = page.locator(fields.heading);
  let displayedNumber = await heading.count() === 1 && await heading.isVisible() ? (await heading.innerText()).trim() : null;
  let statusValue: string | null;
  if (profile.module === "ERP") {
    const prefix = await selectedText(page, RECORD_FIELDS.ERP.prefix);
    if (displayedNumber && prefix && /^\d{2}$/.test(prefix)) displayedNumber += ` · Prefix ${prefix}`;
    statusValue = await selectedText(page, RECORD_FIELDS.ERP.status);
  } else {
    const status = page.locator(RECORD_FIELDS.WCP.status);
    statusValue = await status.count() === 1 && await status.isVisible() ? (await status.inputValue()).trim() : null;
  }
  return {
    displayedNumber,
    statusLabel: await labelBefore(page, fields.status),
    // An unset ERP status drop-down reads "<< Unselected >>", which is not a status.
    statusValue: statusValue && !/^<<.*>>$/.test(statusValue) ? statusValue : null,
    recordUrl: page.url(),
  };
}

export function wmisAdapter(page: Page, profile: WmisProfile, requested: string): PortalAdapter {
  return {
    observe: () => observeWmisSearch(page, profile, requested),
    foundNothing: () => wmisSearchFoundNothing(page, profile, requested),
    fill: () => fillWmisSearch(page, profile, requested),
    submit: () => submitWmisSearch(page, profile, requested),
    openResult: () => openWmisResult(page, profile, requested),
    read: () => readWmisRecord(page, profile, requested),
  };
}
