import type { Browser, Frame, Page } from "playwright";
import { parseRegPermittingNumber, regPermittingRecordUrl, statusLabels } from "../shared/permit.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate, PageObservation } from "../shared/worker-protocol.js";
import type { DisplayedRecord } from "./wmis.js";

/** SFWMD's RegPermitting, a Pega app whose search and record views load in frames under one session address. */
export type RegPermittingProfile = Extract<AutomatedJurisdictionProfile, { portalFamily: "regpermitting" }>;

// The navigation drawer starts collapsed, so the link is present but off screen.
const SEARCH_RECORDS_LINK = 'a.menu-item-anchor[title="Search Records"]';
/** Search by Application is the default tab; permits have their own tab, field, button, and results grid. */
const FORMS = {
  application: {
    tab: "Search by Application",
    input: 'input[name="$PpyDisplayHarness$pAppID"]',
    button: 'button[name^="SearchByApplication_pyDisplayHarness"]',
    grid: 'table#bodyTbl_right[pl_prop="D_AppSearch.pxResults"]',
  },
  permit: {
    tab: "Search by Permit",
    input: 'input[name="$PpyDisplayHarness$ppyTempText"]',
    button: 'button[name^="SearchByPermit_pyDisplayHarness"]',
    grid: 'table#bodyTbl_right[pl_prop="D_PermitSearch.pxResults"]',
  },
} as const;
const RESULT_ROW = "tr[pl_index]";
const NO_RESULTS_ROW = "tr#Grid_NoResults";
/** The results grid shows 20 rows a page, so a full page without the number can't rule it out. */
const PAGE_SIZE = 20;
const RECORD_HEADING = "span.case_id";

/** The browser's own user agent without "Headless", for a portal whose firewall rejects that word. */
export async function plainUserAgent(browser: Browser): Promise<string> {
  const probe = await browser.newContext();
  try {
    const page = await probe.newPage();
    return (await page.evaluate(() => navigator.userAgent)).replace("HeadlessChrome/", "Chrome/");
  } finally {
    await probe.close();
  }
}

async function frameShowing(page: Page, selector: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (await frame.locator(selector).filter({ visible: true }).count().catch(() => 0) > 0) return frame;
  }
  return null;
}

async function waitForFrameShowing(page: Page, selector: string, timeout: number): Promise<Frame | null> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const frame = await frameShowing(page, selector);
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  return null;
}

/** The value beside a read-only field caption, such as "Permit Status". */
async function fieldValue(frame: Frame, label: string): Promise<string | null> {
  const values = await frame.locator("span.field-caption.dataLabelForRead").evaluateAll((captions, name) => captions
    .filter((caption) => caption.textContent?.trim() === name)
    .map((caption) => caption.parentElement?.querySelector(":scope > .field-item.dataValueRead")?.textContent?.trim() ?? ""), label)
    .catch(() => [] as string[]);
  return values.length === 1 && values[0] && values[0] !== "no value" ? values[0] : null;
}

function form(requested: string) {
  return parseRegPermittingNumber(requested)?.kind === "permit" ? FORMS.permit : FORMS.application;
}

/** The search frame, when its field for this kind of number is showing. */
async function searchFrame(page: Page, requested: string): Promise<Frame | null> {
  return frameShowing(page, form(requested).input);
}

async function criteriaEntered(frame: Frame, requested: string): Promise<boolean> {
  const wanted = parseRegPermittingNumber(requested);
  const value = await frame.locator(form(requested).input).filter({ visible: true }).first().inputValue().catch(() => "");
  return Boolean(wanted && value.trim().toUpperCase() === wanted.number);
}

async function resultNumbers(frame: Frame, requested: string): Promise<string[] | null> {
  const grid = frame.locator(form(requested).grid).filter({ visible: true }).first();
  if (await grid.count() === 0) return null;
  return grid.locator(`${RESULT_ROW} td:first-child a`).allInnerTexts().then((texts) => texts.map((text) => text.trim()));
}

async function exactResults(frame: Frame, requested: string): Promise<string[]> {
  const wanted = parseRegPermittingNumber(requested);
  return ((await resultNumbers(frame, requested)) ?? []).filter((text) => text.toUpperCase() === wanted?.number);
}

/** Offer the next step, or report that the requested record is open. */
export async function observeRegPermitting(page: Page, requested: string): Promise<{
  phase: PageObservation["phase"];
  inputValue: string;
  formLabels: string[];
  visibleControls: string[];
  resultNumbers: string[];
  candidates: Candidate[];
}> {
  const wanted = parseRegPermittingNumber(requested);
  const none = { inputValue: "", formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  if (!wanted) return { phase: "unknown", ...none };
  if (await frameShowing(page, RECORD_HEADING)) return { phase: "detail", ...none, visibleControls: ["Record view"] };
  const frame = await frameShowing(page, FORMS.application.input) ?? await frameShowing(page, FORMS.permit.input);
  if (!frame) {
    return await page.locator(SEARCH_RECORDS_LINK).count() > 0
      ? { phase: "search", ...none, visibleControls: ["Search Records link"], candidates: [{ id: "open_public_search",
        description: "Open Search Records, RegPermitting's public search." }] }
      : { phase: "search", ...none };
  }
  const tab = form(requested).tab;
  const entered = await criteriaEntered(frame, requested);
  const inputValue = entered ? requested : "";
  const shown = entered ? await resultNumbers(frame, requested) : null;
  if (shown) {
    const exact = await exactResults(frame, requested);
    return exact.length > 1
      ? { phase: "results", inputValue, formLabels: [], visibleControls: ["Search results"], resultNumbers: exact, candidates: [] }
      : { phase: "search", inputValue, formLabels: [], visibleControls: ["Search results"], resultNumbers: exact,
        candidates: exact.length === 1 ? [{ id: "open_exact_result", description: `Open the result whose number exactly matches ${requested}.` }] : [] };
  }
  const candidates: Candidate[] = [];
  if (!entered) {
    candidates.push({ id: "fill_record_number", description: `Open ${tab} and enter the exact ${wanted.kind} number.` });
  } else if (await frame.locator(form(requested).button).filter({ visible: true }).count() > 0) {
    candidates.push({ id: "search_record_number", description: `Submit ${tab} for the exact ${wanted.kind} number.` });
  }
  return { phase: "search", inputValue, formLabels: [tab], visibleControls: [`${tab} field`], resultNumbers: [], candidates };
}

/** True once a search for the exact number returned "No cases", or every result on a single page is another number. */
export async function regPermittingFoundNothing(page: Page, requested: string): Promise<boolean> {
  const frame = await searchFrame(page, requested);
  if (!frame || !(await criteriaEntered(frame, requested))) return false;
  const grid = frame.locator(form(requested).grid).filter({ visible: true }).first();
  if (await grid.locator(NO_RESULTS_ROW).filter({ visible: true }).count() > 0) return true;
  const shown = await resultNumbers(frame, requested);
  return Boolean(shown && shown.length > 0 && shown.length < PAGE_SIZE && (await exactResults(frame, requested)).length === 0);
}

export async function openRegPermittingSearch(page: Page): Promise<void> {
  const link = page.locator(SEARCH_RECORDS_LINK).first();
  if (await link.count() === 0) return;
  await link.dispatchEvent("click");
  await waitForFrameShowing(page, FORMS.application.input, 20_000);
}

export async function fillRegPermittingSearch(page: Page, requested: string): Promise<void> {
  const wanted = parseRegPermittingNumber(requested);
  let frame = await frameShowing(page, FORMS.application.input) ?? await frameShowing(page, FORMS.permit.input);
  if (!wanted || !frame) return;
  const target = form(requested);
  if (await frame.locator(target.input).filter({ visible: true }).count() === 0) {
    await frame.locator("[role=tab]").filter({ hasText: target.tab }).first().click();
    frame = await waitForFrameShowing(page, target.input, 12_000);
    if (!frame) return;
  }
  await frame.locator(target.input).filter({ visible: true }).first().fill(wanted.number);
}

export async function submitRegPermittingSearch(page: Page, requested: string): Promise<void> {
  const frame = await searchFrame(page, requested);
  if (!frame || !(await criteriaEntered(frame, requested))) return;
  const target = form(requested);
  await frame.locator(target.button).filter({ visible: true }).first().click();
  await frame.locator(`${target.grid} ${RESULT_ROW}, ${target.grid} ${NO_RESULTS_ROW}`).filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
}

export async function openRegPermittingResult(page: Page, requested: string): Promise<void> {
  const frame = await searchFrame(page, requested);
  if (!frame || (await exactResults(frame, requested)).length !== 1) return;
  const wanted = parseRegPermittingNumber(requested)!;
  const links = frame.locator(`${form(requested).grid} ${RESULT_ROW} td:first-child a`).filter({ visible: true });
  for (const link of await links.all()) {
    if ((await link.innerText()).trim().toUpperCase() !== wanted.number) continue;
    await link.click();
    break;
  }
  const record = await waitForFrameShowing(page, RECORD_HEADING, 30_000);
  // The heading appears before the fields fill in.
  await record?.locator("span.field-caption.dataLabelForRead").filter({ hasText: /Status$/ }).first()
    .waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
}

/** True when a record view is showing, as after opening a saved record link. */
export async function regPermittingRecordShown(page: Page, timeout: number): Promise<boolean> {
  return Boolean(await waitForFrameShowing(page, RECORD_HEADING, timeout));
}

/**
 * Read the open record: the number field and status for its kind (Application Number with Application Status or,
 * for water use, App Status; Permit Number with Permit Status). A record opened from a result carries its key in its
 * frame address; one opened from a saved link was opened from that link.
 */
export async function readRegPermittingRecord(page: Page, profile: RegPermittingProfile, requested: string,
  openedRecordUrl: string | null): Promise<DisplayedRecord> {
  const wanted = parseRegPermittingNumber(requested);
  const frame = await frameShowing(page, RECORD_HEADING);
  if (!wanted || !frame) return { displayedNumber: null, statusLabel: null, statusValue: null, recordUrl: null };
  const labels = statusLabels(profile).filter((label) => (label === "Permit Status") === (wanted.kind === "permit"));
  let statusLabel: string | null = null;
  let statusValue: string | null = null;
  for (const label of labels) {
    const value = await fieldValue(frame, label);
    if (value) [statusLabel, statusValue] = [label, value];
  }
  const key = frame === page.mainFrame() ? null : new URL(frame.url()).searchParams.get("key");
  return {
    displayedNumber: await fieldValue(frame, wanted.kind === "permit" ? "Permit Number" : "Application Number"),
    statusLabel,
    statusValue,
    recordUrl: key ? regPermittingRecordUrl(profile, key) : openedRecordUrl,
  };
}
