import type { Locator, Page } from "playwright";
import { epermitRecordUrl, expectedStatusLabel, parseEpermitNumber, sameEpermitRowNumber } from "../shared/permit.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate } from "../shared/worker-protocol.js";
import type { DisplayedRecord, PortalAdapter, SearchObservation } from "./adapter.js";

/** A district searched through the ePermit app St. Johns River WMD hosts. */
type EpermitProfile = Extract<AutomatedJurisdictionProfile, { portalFamily: "epermit" }>;

// The search form renders in an open shadow root, which Playwright's CSS locators reach into.
const PERMIT_FIELD = "input[formcontrolname=permitNo]";
const SEQUENCE_FIELD = "input[formcontrolname=seqNo]";
const RESULT_LINK = "ng-reg-search td a";
const NO_RESULTS = "No Results Found";
/** Opening a result shows the record in a dialog frame over the results. */
const RECORD_FRAME = "iframe#iframeDiagHtml";

/**
 * Counts the search form's lookup lists as they load, and returns a wait for the form to settle. The form clears its
 * fields just after the third list arrives, so numbers entered earlier are lost and the search then reports that no
 * criteria were given.
 */
export function watchEpermitForm(page: Page): () => Promise<void> {
  let lists = 0;
  page.on("response", (response) => { if (/\/api\/custom\/lookups\/catalogList/.test(response.url())) lists += 1; });
  return async () => {
    await page.locator(PERMIT_FIELD).waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined);
    const until = Date.now() + 25_000;
    while (lists < 3 && Date.now() < until) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
  };
}

function searchButton(page: Page): Locator {
  return page.locator("ng-reg-search button").filter({ hasText: /^\s*Search\s*$/ });
}

/** Result links whose displayed number exactly matches, by prefix, number, and sequence, with that number. */
async function exactLinks(page: Page, requested: string): Promise<Array<{ link: Locator; text: string }>> {
  const links = page.locator(RESULT_LINK).filter({ visible: true });
  const texts = (await links.allInnerTexts()).map((text) => text.trim());
  return texts.flatMap((text, index) => sameEpermitRowNumber(requested, text) ? [{ link: links.nth(index), text }] : []);
}

async function criteriaEntered(page: Page, requested: string): Promise<boolean> {
  const wanted = parseEpermitNumber(requested);
  const value = (selector: string) => page.locator(selector).inputValue().catch(() => "");
  const [permit, sequence] = [await value(PERMIT_FIELD), await value(SEQUENCE_FIELD)];
  return Boolean(wanted && /^\d+$/.test(permit) && /^\d+$/.test(sequence) &&
    Number(permit) === wanted.permit && Number(sequence) === wanted.sequence);
}

async function noResultsShown(page: Page): Promise<boolean> {
  return page.getByText(NO_RESULTS, { exact: true }).isVisible().catch(() => false);
}

/** Each "label = value" pair on the open record, from its bold labels and their following values. */
async function recordFields(page: Page): Promise<Array<[string, string]>> {
  const frame = page.locator(RECORD_FRAME);
  if (await frame.count() !== 1 || !(await frame.isVisible())) return [];
  return page.frameLocator(RECORD_FRAME).locator("mat-label.fw-bold").evaluateAll((labels) => labels.map((label) =>
    [label.textContent?.trim() ?? "", label.nextElementSibling?.textContent?.trim() ?? ""] as [string, string]));
}

function field(fields: Array<[string, string]>, name: string): string | null {
  const values = fields.filter(([label]) => label === name).map(([, value]) => value);
  return values.length === 1 && values[0] ? values[0] : null;
}

/** Offer the next step, or report that the exactly matching record is open over the results. */
async function observeEpermitSearch(page: Page, profile: EpermitProfile, requested: string): Promise<SearchObservation> {
  const entered = await criteriaEntered(page, requested);
  const inputValue = entered ? requested : "";
  // Another dialog, such as a portal warning, leaves nothing safe to do.
  if (await page.locator("mat-dialog-container").filter({ visible: true }).filter({ hasNot: page.locator(RECORD_FRAME) }).count() > 0) {
    return { phase: "unknown", inputValue, formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  }
  if (field(await recordFields(page), "Project Number")) {
    return { phase: "detail", inputValue, formLabels: [], visibleControls: ["Permit information"], resultNumbers: [], candidates: [] };
  }
  const exact = entered ? await exactLinks(page, requested) : [];
  if (exact.length > 0) {
    const resultNumbers = exact.map(({ text }) => text);
    return exact.length > 1
      ? { phase: "results", inputValue, formLabels: [], visibleControls: ["Search results"], resultNumbers, candidates: [] }
      : { phase: "search", inputValue, formLabels: [], visibleControls: ["Search results"], resultNumbers, candidates: [{
        id: "open_exact_result", description: `Open the result whose permit number exactly matches ${requested}.` }] };
  }
  const permit = page.locator(PERMIT_FIELD);
  const sequence = page.locator(SEQUENCE_FIELD);
  if (await permit.count() !== 1 || await sequence.count() !== 1 || !(await permit.isVisible()) || !(await permit.isEnabled())) {
    return { phase: "search", inputValue, formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  }
  const candidates: Candidate[] = [];
  if (!entered) {
    candidates.push({ id: "fill_record_number",
      description: "Fill Application/Permit # and Sequence # with the number and sequence from the exact permit number." });
  } else if (!(await noResultsShown(page)) && await searchButton(page).count() === 1 && await searchButton(page).isEnabled()) {
    candidates.push({ id: "search_record_number", description: `Submit the ${profile.label} ePermit search for the exact permit and sequence number.` });
  }
  return { phase: "search", inputValue, formLabels: ["Application/Permit #", "Sequence #"],
    visibleControls: ["Application/Permit # and Sequence # search"], resultNumbers: [], candidates };
}

/** True once a search for the requested number and sequence found nothing, or only other prefixes. */
async function epermitSearchFoundNothing(page: Page, requested: string): Promise<boolean> {
  if (!(await criteriaEntered(page, requested))) return false;
  if (await noResultsShown(page)) return true;
  const shown = await page.locator(RESULT_LINK).filter({ visible: true }).allInnerTexts();
  return shown.length > 0 && shown.every((text) => parseEpermitNumber(text) !== null) &&
    !shown.some((text) => sameEpermitRowNumber(requested, text.trim()));
}

async function fillEpermitSearch(page: Page, requested: string): Promise<void> {
  const wanted = parseEpermitNumber(requested);
  if (!wanted) return;
  await page.locator(PERMIT_FIELD).fill(String(wanted.permit));
  await page.locator(SEQUENCE_FIELD).fill(String(wanted.sequence));
}

async function submitEpermitSearch(page: Page, requested: string): Promise<void> {
  if (!(await criteriaEntered(page, requested))) return;
  // A loading overlay can cover the button while the form's lookup lists load.
  await page.locator(".cdk-overlay-backdrop").first().waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
  // If the form cleared itself after the numbers went in, the same numbers go back in before searching.
  if (!(await criteriaEntered(page, requested))) await fillEpermitSearch(page, requested);
  if (!(await searchButton(page).click().then(() => true, () => false))) return;
  // Results render after the search request returns, which St. Johns River's own search can take close to a minute to do.
  await Promise.any([
    page.locator(RESULT_LINK).first().waitFor({ state: "visible", timeout: 90_000 }),
    page.getByText(NO_RESULTS, { exact: true }).waitFor({ state: "visible", timeout: 90_000 }),
  ]).catch(() => undefined);
}

async function openEpermitResult(page: Page, requested: string): Promise<void> {
  const exact = await exactLinks(page, requested);
  if (exact.length !== 1) return;
  await exact[0]!.link.click();
  // The record fills in after its own request, so wait for its number and status to hold text.
  await page.waitForFunction((selector) => {
    const frame = document.querySelector<HTMLIFrameElement>(selector);
    const labels = [...(frame?.contentDocument?.querySelectorAll("mat-label.fw-bold") ?? [])];
    const value = (name: string) => labels.find((label) => label.textContent?.trim() === name)?.nextElementSibling?.textContent?.trim();
    return Boolean(value("Project Number") && value("Status"));
  }, RECORD_FRAME, { timeout: 60_000 }).catch(() => undefined);
}

/** The result row's Status column: the district's own status, which the record dialog abbreviates (Never Issued shows as Closed). */
async function rowStatus(link: Locator): Promise<string | null> {
  return link.evaluate((anchor) => {
    const row = anchor.closest("tr");
    const header = [...(row?.closest("table")?.querySelectorAll("tr") ?? [])]
      .find((candidate) => [...candidate.cells].some((cell) => cell.textContent?.trim() === "Permit #"));
    const index = [...(header?.cells ?? [])].findIndex((cell) => cell.textContent?.trim() === "Status");
    return index >= 0 && row?.cells[index] ? row.cells[index].textContent?.trim() || null : null;
  });
}

/** Read the open record: the result row's full number and Status, with the record's Project Number and process stage. */
async function readEpermitRecord(page: Page, profile: EpermitProfile, requested: string): Promise<DisplayedRecord> {
  const fields = await recordFields(page);
  const exact = await exactLinks(page, requested);
  const row = exact.length === 1 ? exact[0]! : null;
  const rowNumber = row?.text ?? null;
  const project = field(fields, "Project Number");
  const status = row ? await rowStatus(row.link) : null;
  const stage = field(fields, "Current Process Stage");
  return {
    displayedNumber: rowNumber && project ? `${rowNumber} · Project Number ${project}` : null,
    statusLabel: status && stage ? expectedStatusLabel(profile) : null,
    statusValue: status && stage ? `${status} · ${stage}` : null,
    recordUrl: rowNumber ? epermitRecordUrl(profile, rowNumber) : null,
  };
}

export function epermitAdapter(page: Page, profile: EpermitProfile, requested: string): PortalAdapter {
  return {
    observe: () => observeEpermitSearch(page, profile, requested),
    foundNothing: () => epermitSearchFoundNothing(page, requested),
    fill: () => fillEpermitSearch(page, requested),
    submit: () => submitEpermitSearch(page, requested),
    openResult: () => openEpermitResult(page, requested),
    read: () => readEpermitRecord(page, profile, requested),
  };
}
