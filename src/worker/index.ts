import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { parseApplicationNumber, parsePortalUrl, sameJurisdictionPermitNumber, STATUS_LABELS } from "../shared/permit.js";
import { getAutomatedJurisdiction, usesGlobalSearch, type AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate, MainToWorker, PageObservation, WorkerToMain } from "../shared/worker-protocol.js";

const SEARCH_FIELD = "#ctl00_PlaceHolderMain_generalSearchForm_txtGSPermitNumber";
const SEARCH_BUTTON = "#ctl00_PlaceHolderMain_btnNewSearch";
const DETAIL_NUMBER = "#ctl00_PlaceHolderMain_lblPermitNumber";
const DETAIL_STATUS = "#ctl00_PlaceHolderMain_lblRecordStatus";
const DETAIL_STATUS_TITLE = "#ctl00_PlaceHolderMain_lblRecordStatusTitle";
// Accela's Global Search box (Pasco replaces it with its own, injected after load) and the results page it opens.
const GLOBAL_SEARCH_FIELD = "#search_text_gq, #txtSearchCondition";
const GLOBAL_RESULTS_LABEL = "#ctl00_PlaceHolderMain_lblSearchResults";
const GLOBAL_NO_RESULTS = "#ctl00_PlaceHolderMain_pnlNoResults";
const GLOBAL_RESULT_LINK = "a[id$='_lnkPermitNumber']";
const GLOBAL_NEXT_PAGE = "a[href*='gdvPermitList']:text-is('Next >')";
const TYLER_SEARCH_FIELD = "#SearchKeyword";
const TYLER_SEARCH_BUTTON = "#button-Search";
const ST_PETE_YEAR = '[id="permit.appYear"]';
const ST_PETE_NUMBER = '[id="permit.appNumber"]';
const ST_PETE_SEARCH_BUTTON = 'input[name="finish"]';

/** Where each portal family shows the permit number and record-level status on its detail page. */
const DETAIL_FIELDS: Record<AutomatedJurisdictionProfile["portalFamily"], { number: string; status: string }> = {
  "accela": { number: DETAIL_NUMBER, status: DETAIL_STATUS },
  "tyler-civic-access": { number: "#focusText span.ng-binding", status: "#label-PermitDetail-Status p.form-control-static" },
  "click2gov": {
    number: 'label:has-text("Application #:") + div p.form-control-static',
    status: 'label:has-text("Application Status:") + div p.form-control-static',
  },
};

let browser: Browser | null = null;
let jurisdiction: AutomatedJurisdictionProfile | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let currentRun: string | null = null;
let requestedNumber = "";
let actionCount = 0;
let recentActions: string[] = [];
let lastObservation: PageObservation | null = null;
let stopped = false;

function send(message: WorkerToMain): void {
  process.parentPort?.postMessage(message);
}

async function closeAll(): Promise<void> {
  stopped = true;
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  context = null;
  browser = null;
  page = null;
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

function fail(outcome: WorkerToMain & { kind: "failed" }): void {
  send(outcome);
  void closeAll();
}

function locationOf(url: string): PageObservation["location"] {
  if (!jurisdiction) return "other";
  if (parsePortalUrl(url, "search", jurisdiction.id)) return "permit-search";
  if (parsePortalUrl(url, "detail", jurisdiction.id)) return "permit-detail";
  return "other";
}

function stPeteRecordUrl(number: string): string | null {
  const parts = parseApplicationNumber(number);
  if (!parts) return null;
  const url = new URL("https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html");
  url.searchParams.set("permit.appYear", parts.year);
  url.searchParams.set("permit.appNumber", parts.serial);
  url.searchParams.set("searchType", "0");
  url.searchParams.set("validatePermitView", "true");
  return url.toString();
}

async function visibleText(selector: string): Promise<string | null> {
  if (!page) return null;
  const locator = page.locator(selector);
  if (await locator.count() !== 1 || !(await locator.isVisible())) return null;
  return (await locator.innerText()).trim();
}

async function waitForDetail(): Promise<void> {
  if (!page || jurisdiction?.portalFamily !== "tyler-civic-access") return;
  // Tyler renders the record after load, so wait for both fields to hold text.
  for (const selector of Object.values(DETAIL_FIELDS["tyler-civic-access"])) {
    await page.locator(selector).filter({ hasText: /\S/ })
      .waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  }
}

function globalSearch(): boolean {
  return Boolean(jurisdiction && usesGlobalSearch(jurisdiction.id));
}

function onGlobalResults(url: string): boolean {
  return globalSearch() && new URL(url).pathname.toLowerCase().endsWith("/cap/globalsearchresults.aspx");
}

/** Wait for a record, a results list, or the no-results notice after a Global Search or results postback. */
async function waitForGlobalResults(previousRows: string): Promise<void> {
  if (!page) return;
  await page.waitForFunction(({ rows, link, detail, none }) => {
    if (document.querySelector(detail) || document.querySelector(none)) return true;
    const current = [...document.querySelectorAll<HTMLElement>(link)].map((anchor) => anchor.innerText.trim()).join("|");
    return current !== "" && current !== rows;
  }, { rows: previousRows, link: GLOBAL_RESULT_LINK, detail: DETAIL_NUMBER, none: GLOBAL_NO_RESULTS }, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

async function globalResultRows(): Promise<string> {
  return page ? (await page.locator(GLOBAL_RESULT_LINK).allInnerTexts()).map((text) => text.trim()).join("|") : "";
}

async function exactResultLinks(): Promise<Array<{ text: string; href: string; id: string }>> {
  if (!page) return [];
  const links = await page.locator(globalSearch() ? GLOBAL_RESULT_LINK : "a").evaluateAll((anchors) => anchors.slice(0, 250).flatMap((anchor) => {
    if (!(anchor instanceof HTMLAnchorElement) || anchor.getBoundingClientRect().width === 0) return [];
    const href = anchor.getAttribute("href");
    return href ? [{ text: anchor.innerText.trim(), href, id: anchor.id }] : [];
  }));
  const found = links.filter((link) => jurisdiction && sameJurisdictionPermitNumber(requestedNumber, link.text, jurisdiction.id));
  return found.filter((link, index) => found.findIndex((candidate) => candidate.href === link.href) === index);
}

async function observe(): Promise<PageObservation> {
  if (!page) throw new Error("Page not started");
  const url = page.url();
  let location = locationOf(url);
  const headings = (await page.locator("h1, h2, h3").allInnerTexts()).map((text) => text.trim()).filter(Boolean).slice(0, 8);
  if (jurisdiction?.portalFamily === "click2gov" && location === "permit-search" && headings.includes("Status Detail")) {
    location = "permit-detail";
  }
  const candidates: Candidate[] = [];
  let phase: PageObservation["phase"] = "unknown";
  let inputValue = "";
  let displayedNumber = "";
  let displayedStatus = "";
  let resultNumbers: string[] = [];
  const visibleControls: string[] = [];
  const formLabels: string[] = [];

  if (location === "permit-detail" && jurisdiction) {
    phase = "detail";
    const fields = DETAIL_FIELDS[jurisdiction.portalFamily];
    displayedNumber = (await visibleText(fields.number)) ?? "";
    displayedStatus = (await visibleText(fields.status)) ?? "";
  } else if (location === "permit-search") {
    phase = "search";
    if (jurisdiction?.portalFamily === "accela" && onGlobalResults(url)) {
      // The search already ran; the only way forward is the exact result row or the next page of results.
      if (await page.locator(GLOBAL_RESULTS_LABEL).isVisible().catch(() => false)) visibleControls.push("Global Search results");
    } else if (jurisdiction?.portalFamily === "accela") {
      const global = globalSearch();
      const input = global ? page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true }) : page.locator(SEARCH_FIELD);
      if (await input.count() === 1 && await input.isVisible() && await input.isEnabled()) {
        inputValue = await input.inputValue();
        formLabels.push(global ? "Global Search" : "Record Number");
        visibleControls.push(global ? "Global Search field" : "Record Number field");
        if (inputValue !== requestedNumber) candidates.push({ id: "fill_record_number", description: global
          ? "Fill the portal's Global Search field with the exact requested permit number."
          : "Fill the Record Number field with the exact requested permit number." });
      }
      const search = page.locator(SEARCH_BUTTON);
      // Global Search submits from its field on Enter; its button can be covered or drawn at zero size.
      if (inputValue === requestedNumber && (global || (await search.count() === 1 && await search.isVisible() && await search.isEnabled()))) {
        if (!global) visibleControls.push("Search button");
        candidates.push({ id: "search_record_number", description: global
          ? "Submit the portal's Global Search for the exact permit number."
          : "Submit the public Building permit record search." });
      }
    } else if (jurisdiction?.portalFamily === "tyler-civic-access") {
      const input = page.locator(TYLER_SEARCH_FIELD);
      if (await input.count() === 1 && await input.isVisible() && await input.isEnabled()) {
        inputValue = await input.inputValue();
        formLabels.push("Search public records with keywords or addresses");
        visibleControls.push("Public records search field");
        if (inputValue !== requestedNumber) candidates.push({ id: "fill_record_number", description: "Fill the public records keyword field with the exact permit number." });
        else if (!recentActions.includes("search_record_number") && await page.locator(TYLER_SEARCH_BUTTON).isEnabled()) {
          candidates.push({ id: "search_record_number", description: "Submit the exact permit number in Tyler Civic Access public records search." });
        }
      } else if (/#\/home/i.test(url)) {
        candidates.push({ id: "open_public_search", description: "Open Search Public Records in Hernando County Civic Access." });
      }
    } else if (jurisdiction?.portalFamily === "click2gov") {
      const parts = parseApplicationNumber(requestedNumber);
      const year = page.locator(ST_PETE_YEAR);
      const number = page.locator(ST_PETE_NUMBER);
      if (parts && await year.count() === 1 && await number.count() === 1 && await year.isVisible() && await number.isVisible()) {
        inputValue = `${await year.inputValue()}-${await number.inputValue()}`;
        formLabels.push("Application Number: year and serial number");
        visibleControls.push("Application Number search");
        if (inputValue !== `${parts.year}-${parts.serial}`) candidates.push({ id: "fill_record_number", description: "Enter the exact two-digit application year and serial number in Click2Gov." });
        else candidates.push({ id: "search_record_number", description: "Submit the City of St. Petersburg Application Number search." });
      }
    }
    const links = await exactResultLinks();
    resultNumbers = links.map((link) => link.text);
    if (links.length > 1) phase = "results";
    if (links.length === 1) {
      const target = new URL(links[0]!.href, page.url());
      // Global Search result rows open their record through a postback rather than a link.
      if (jurisdiction && (globalSearch() || parsePortalUrl(target.toString(), "detail", jurisdiction.id))) {
        phase = "results";
        candidates.length = 0;
        candidates.push({ id: "open_exact_result", description: `Open the result whose displayed permit number exactly equals ${requestedNumber}.` });
      }
    } else if (links.length === 0 && onGlobalResults(url) && await page.locator(GLOBAL_NEXT_PAGE).count() === 1) {
      candidates.push({ id: "next_results_page", description: "Show the next page of Global Search results to look for the exact permit number." });
    }
  }

  const challengeText = await page.locator("body").innerText().then((text) => text.slice(0, 3000)).catch(() => "");
  if (/captcha|verify you are human|are you a human|access denied|sign in|log in to continue/i.test(challengeText)) {
    phase = "challenge";
    candidates.length = 0;
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ url, phase, inputValue, displayedNumber, displayedStatus, resultNumbers, headings }))
    .digest("hex").slice(0, 20);
  return {
    phase,
    location,
    fingerprint,
    headings,
    formLabels,
    visibleControls,
    resultNumbers,
    recentActions: recentActions.slice(-3),
    candidates,
  };
}

async function sendObservationOrResult(): Promise<void> {
  if (!page || !currentRun || stopped) return;
  const observation = await observe();
  lastObservation = observation;
  if (observation.phase === "challenge") {
    fail({ kind: "failed", runId: currentRun, outcome: "blocked" });
    return;
  }
  if (observation.phase === "results" && observation.resultNumbers.length > 1) {
    fail({ kind: "failed", runId: currentRun, outcome: "ambiguous" });
    return;
  }
  if (observation.phase === "search" && recentActions.includes("search_record_number")) {
    if (jurisdiction?.portalFamily === "accela" && onGlobalResults(page.url())) {
      // Global Search matches whole record numbers, so a finished search without the exact row has no such record.
      if (observation.candidates.length === 0 && await page.locator(GLOBAL_RESULTS_LABEL).isVisible().catch(() => false)) {
        fail({ kind: "failed", runId: currentRun, outcome: "not_found_in_supported_search" });
        return;
      }
    } else if (jurisdiction?.portalFamily === "accela") {
      const message = page.getByText("Your search returned no results. Please modify your search criteria and try again.", { exact: true });
      const input = page.locator(SEARCH_FIELD);
      if (await message.count() === 1 && await message.isVisible() &&
        await input.count() === 1 && await input.inputValue() === requestedNumber) {
        fail({ kind: "failed", runId: currentRun, outcome: "not_found_in_supported_search" });
        return;
      }
    } else if (jurisdiction?.portalFamily === "tyler-civic-access" &&
      /Found 0 results/i.test((await page.locator("body").innerText()).slice(0, 1000))) {
      fail({ kind: "failed", runId: currentRun, outcome: "not_found_in_supported_search" });
      return;
    }
  }
  if (observation.phase === "detail" && jurisdiction) {
    const fields = DETAIL_FIELDS[jurisdiction.portalFamily];
    const displayedNumber = await visibleText(fields.number);
    const statusValue = await visibleText(fields.status);
    // Accela's label is read from the page; the other portals' labels are part of their selectors.
    const labelText = jurisdiction.portalFamily === "accela" ? await visibleText(DETAIL_STATUS_TITLE)
      : `${STATUS_LABELS[jurisdiction.portalFamily]}:`;
    if (!displayedNumber || !sameJurisdictionPermitNumber(requestedNumber, displayedNumber, jurisdiction.id)) {
      fail({ kind: "failed", runId: currentRun, outcome: "identity_mismatch" });
      return;
    }
    if (!statusValue || !labelText) {
      fail({ kind: "failed", runId: currentRun, outcome: "status_unavailable" });
      return;
    }
    const recordUrl = jurisdiction.portalFamily === "click2gov" ? stPeteRecordUrl(requestedNumber) : page.url();
    if (!recordUrl || !parsePortalUrl(recordUrl, "detail", jurisdiction.id)) {
      fail({ kind: "failed", runId: currentRun, outcome: "record_link_unavailable" });
      return;
    }
    send({
      kind: "verified",
      runId: currentRun,
      displayedNumber,
      statusLabel: labelText,
      statusValue,
      observedAt: new Date().toISOString(),
      recordUrl,
      browserVersion: browser?.version() ?? "unknown",
    });
    await closeAll();
    return;
  }
  if (observation.phase === "unknown" || observation.candidates.length === 0) {
    fail({ kind: "failed", runId: currentRun, outcome: "unsupported_page" });
    return;
  }
  send({ kind: "observation", runId: currentRun, observation });
}

async function start(message: Extract<MainToWorker, { kind: "start" }>): Promise<void> {
  currentRun = message.runId;
  jurisdiction = getAutomatedJurisdiction(message.jurisdictionId);
  if (!jurisdiction) { fail({ kind: "failed", runId: message.runId, outcome: "unsupported_page" }); return; }
  requestedNumber = message.permitNumber;
  stopped = false;
  process.env.PLAYWRIGHT_BROWSERS_PATH = message.browserPath;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("popup", (popup) => { void popup.close(); });
  page.on("framenavigated", (frame) => {
    if (frame === page?.mainFrame() && frame.url() !== "about:blank" && locationOf(frame.url()) === "other") {
      fail({ kind: "failed", runId: message.runId, outcome: "unsupported_page" });
    }
  });
  const startUrl = jurisdiction.startUrl;
  const target = message.previousRecordUrl && parsePortalUrl(message.previousRecordUrl, "detail", jurisdiction.id)
    ? message.previousRecordUrl : startUrl;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    if (stopped) return;
    if (target !== startUrl && page && !stopped) await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    else throw new Error("Navigation failed");
  }
  if (target !== startUrl && page && !stopped && locationOf(page.url()) !== "permit-detail") {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }
  if (page && !stopped && locationOf(page.url()) === "permit-detail") await waitForDetail();
  if (globalSearch() && page && !stopped && locationOf(page.url()) === "permit-search") {
    await page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true }).first()
      .waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  }
  if (jurisdiction.portalFamily === "tyler-civic-access" && page && !stopped) {
    await page.locator("#SearchKeyword, a[href*='#/search']").first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  }
  await sendObservationOrResult();
}

async function choose(message: Extract<MainToWorker, { kind: "choose" }>): Promise<void> {
  if (!page || !currentRun || currentRun !== message.runId || !lastObservation || stopped) return;
  const fresh = await observe();
  if (fresh.fingerprint !== message.fingerprint || fresh.candidates.length > 30) {
    await sendObservationOrResult();
    return;
  }
  if (!fresh.candidates.some((candidate) => candidate.id === message.candidateId)) {
    fail({ kind: "failed", runId: currentRun, outcome: "unsupported_page" });
    return;
  }
  switch (message.candidateId) {
    case "open_public_search": {
      if (jurisdiction?.portalFamily !== "tyler-civic-access") break;
      await page.goto("https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/search",
        { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.locator(TYLER_SEARCH_FIELD).waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
      break;
    }
    case "fill_record_number": {
      if (jurisdiction?.portalFamily === "click2gov") {
        const parts = parseApplicationNumber(requestedNumber);
        if (!parts) break;
        await page.locator(ST_PETE_YEAR).fill(parts.year);
        await page.locator(ST_PETE_NUMBER).fill(parts.serial);
      } else {
        const input = jurisdiction?.portalFamily === "tyler-civic-access" ? page.locator(TYLER_SEARCH_FIELD)
          : globalSearch() ? page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true }) : page.locator(SEARCH_FIELD);
        if (await input.count() !== 1 || !(await input.isVisible()) || !(await input.isEnabled())) break;
        await input.fill(requestedNumber);
      }
      break;
    }
    case "search_record_number": {
      if (jurisdiction?.portalFamily === "click2gov") {
        const parts = parseApplicationNumber(requestedNumber);
        if (!parts || await page.locator(ST_PETE_YEAR).inputValue() !== parts.year ||
          await page.locator(ST_PETE_NUMBER).inputValue() !== parts.serial) break;
        await page.locator(ST_PETE_SEARCH_BUTTON).click();
        await page.getByRole("heading", { name: "Status Detail", exact: true })
          .waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
      } else if (jurisdiction?.portalFamily === "tyler-civic-access") {
        if (await page.locator(TYLER_SEARCH_FIELD).inputValue() !== requestedNumber) break;
        await page.locator(TYLER_SEARCH_BUTTON).click();
        await page.getByText(/Found \d+ results?/).first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
      } else if (jurisdiction?.portalFamily === "accela" && globalSearch()) {
        const input = page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true });
        if (await input.count() !== 1 || await input.inputValue() !== requestedNumber) break;
        await input.press("Enter", { noWaitAfter: true });
        await page.waitForURL((target) => onGlobalResults(target.toString()) ||
          Boolean(jurisdiction && parsePortalUrl(target.toString(), "detail", jurisdiction.id)), { timeout: 15_000 }).catch(() => undefined);
        await waitForGlobalResults("");
      } else if (jurisdiction?.portalFamily === "accela") {
        const input = page.locator(SEARCH_FIELD);
        const button = page.locator(SEARCH_BUTTON);
        if (await input.inputValue() !== requestedNumber || await button.count() !== 1 || !(await button.isVisible()) || !(await button.isEnabled())) break;
        await button.click({ noWaitAfter: true });
        await Promise.any([
          page.locator(DETAIL_NUMBER).waitFor({ state: "visible", timeout: 12_000 }),
          page.getByRole("link", { name: requestedNumber, exact: true }).waitFor({ state: "visible", timeout: 12_000 }),
          page.getByText("Your search returned no results. Please modify your search criteria and try again.", { exact: true })
            .waitFor({ state: "visible", timeout: 12_000 }),
        ]).catch(() => undefined);
      }
      break;
    }
    case "open_exact_result": {
      const links = await exactResultLinks();
      if (links.length !== 1) break;
      if (globalSearch()) {
        if (!onGlobalResults(page.url())) break;
        await page.locator(`[id="${links[0]!.id}"]`).click({ noWaitAfter: true });
        await page.locator(DETAIL_NUMBER).waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
        break;
      }
      const target = new URL(links[0]!.href, page.url());
      if (!jurisdiction || !parsePortalUrl(target.toString(), "detail", jurisdiction.id)) break;
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 12_000 });
      await waitForDetail();
      break;
    }
    case "next_results_page": {
      if (!onGlobalResults(page.url())) break;
      const rows = await globalResultRows();
      await page.locator(GLOBAL_NEXT_PAGE).click({ noWaitAfter: true });
      await waitForGlobalResults(rows);
      break;
    }
    default:
      break;
  }
  actionCount += 1;
  recentActions.push(message.candidateId);
  send({ kind: "action_count", runId: currentRun, count: actionCount });
  await sendObservationOrResult();
}

process.parentPort?.on("message", (event: { data: MainToWorker }) => {
  const message = event.data;
  if (message.kind === "cancel") {
    if (message.runId === currentRun) {
      send({ kind: "failed", runId: message.runId, outcome: "cancelled" });
      void closeAll();
    }
    return;
  }
  const task = message.kind === "start" ? start(message)
    : message.kind === "reobserve" ? sendObservationOrResult() : choose(message);
  void task.catch((error: unknown) => {
    if (process.env.PERMIT_PORTAL_SMOKE === "1") process.stderr.write(`Worker smoke error: ${String(error)}\n`);
    if (currentRun && !stopped) fail({ kind: "failed", runId: currentRun, outcome: "browser_error" });
  });
});
