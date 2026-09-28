import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { parseApplicationNumber, parsePortalUrl, sameJurisdictionPermitNumber, type RunOutcome } from "../shared/permit.js";
import { getAutomatedJurisdiction, usesGlobalSearch, type AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate, MainToWorker, PageObservation, WorkerToMain } from "../shared/worker-protocol.js";
import { NOTHING_DISPLAYED, type DisplayedRecord, type PortalAdapter } from "./adapter.js";
import { readDetail, TYLER_SEARCH_FIELD, tylerFoundNothing, waitForDetail, waitForTylerResults, waitForTylerSearch } from "./detail.js";
import { wmisAdapter } from "./wmis.js";
import { epermitAdapter, watchEpermitForm } from "./epermit.js";
import { plainUserAgent, regPermittingAdapter, regPermittingRecordShown, waitForSearchRecordsLink } from "./regpermitting.js";

const SEARCH_FIELD = "#ctl00_PlaceHolderMain_generalSearchForm_txtGSPermitNumber";

const SEARCH_BUTTON = "#ctl00_PlaceHolderMain_btnNewSearch";

const DETAIL_NUMBER = "#ctl00_PlaceHolderMain_lblPermitNumber";

// Accela's Global Search box (Pasco replaces it with its own, injected after load) and the results page it opens.
const GLOBAL_SEARCH_FIELD = "#search_text_gq, #txtSearchCondition";

const GLOBAL_RESULTS_LABEL = "#ctl00_PlaceHolderMain_lblSearchResults";

const GLOBAL_NO_RESULTS = "#ctl00_PlaceHolderMain_pnlNoResults";

const GLOBAL_RESULT_LINK = "a[id$='_lnkPermitNumber']";

const GLOBAL_NEXT_PAGE = "a[href*='gdvPermitList']:text-is('Next >')";

const TYLER_SEARCH_BUTTON = "#button-Search";

const ST_PETE_YEAR = '[id="permit.appYear"]';

const ST_PETE_NUMBER = '[id="permit.appNumber"]';

const ST_PETE_SEARCH_BUTTON = 'input[name="finish"]';

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

/** The saved record link this run opened instead of searching, if any. */
let openedRecordUrl: string | null = null;

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

/** Reports the run's outcome and closes the browser. */
function fail(outcome: RunOutcome): void {
  if (currentRun) send({ kind: "failed", runId: currentRun, outcome });
  void closeAll();
}

function locationOf(url: string): PageObservation["location"] {
  if (!jurisdiction) return "other";

  if (parsePortalUrl(url, "search", jurisdiction.id)) return "permit-search";

  if (parsePortalUrl(url, "detail", jurisdiction.id)) return "permit-detail";

  return "other";
}

/** The module driving this run's portal, for families that don't use the generic steps below. */
function portalAdapter(): PortalAdapter | null {
  if (!page || !jurisdiction) return null;

  switch (jurisdiction.portalFamily) {
    case "wmis": return wmisAdapter(page, jurisdiction, requestedNumber);
    case "epermit": return epermitAdapter(page, jurisdiction, requestedNumber);
    case "regpermitting": return regPermittingAdapter(page, jurisdiction, requestedNumber, openedRecordUrl);
    default: return null;
  }
}

/** Read the record's displayed number, status, and status label, and the record link to save. */
async function readRecord(): Promise<DisplayedRecord> {
  const adapter = portalAdapter();

  if (adapter) return adapter.read();

  return page && jurisdiction ? readDetail(page, jurisdiction, requestedNumber) : NOTHING_DISPLAYED;
}

/**
 * A saved record link can replace the search only where the record page shows the full number and the status.
 * SWFWMD's water use pages show no status, and ePermit record pages omit the number's prefix.
 */
function recordLinkShowsRecord(profile: AutomatedJurisdictionProfile): boolean {
  return profile.portalFamily === "wmis" ? profile.module !== "WUP" : profile.portalFamily !== "epermit";
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

/** An observation for main, and the record it read on a detail page so the result doesn't read it again. */
interface Observed {
  observation: PageObservation;
  record: DisplayedRecord | null;
}

async function observe(): Promise<Observed> {
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
  let record: DisplayedRecord | null = null;

  if (location === "permit-detail" && jurisdiction) {
    phase = "detail";
    record = await readRecord();
    displayedNumber = record.displayedNumber ?? "";
    displayedStatus = record.statusValue ?? "";
  } else if (location === "permit-search") {
    phase = "search";
    const adapter = portalAdapter();

    if (adapter) {
      const search = await adapter.observe();
      phase = search.phase;
      inputValue = search.inputValue;
      formLabels.push(...search.formLabels);
      visibleControls.push(...search.visibleControls);
      resultNumbers = search.resultNumbers;
      candidates.push(...search.candidates);
    } else if (jurisdiction?.portalFamily === "accela" && onGlobalResults(url)) {
      // The search already ran; the only way forward is the exact result row or the next page of results.
      if (await page.locator(GLOBAL_RESULTS_LABEL).isVisible().catch(() => false)) visibleControls.push("Global Search results");
    } else if (jurisdiction?.portalFamily === "accela") {
      const global = globalSearch();
      const input = global ? page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true }) : page.locator(SEARCH_FIELD);

      if (await input.count() === 1 && await input.isVisible() && await input.isEnabled()) {
        inputValue = await input.inputValue();
        formLabels.push(global ? "Global Search" : "Record Number");
        visibleControls.push(global ? "Global Search field" : "Record Number field");

        if (inputValue !== requestedNumber) candidates.push({ id: "fill_record_number", established: true, description: global
          ? "Fill the portal's Global Search field with the exact requested permit number."
          : "Fill the Record Number field with the exact requested permit number." });
      }

      const search = page.locator(SEARCH_BUTTON);

      // Global Search submits from its field on Enter; its button can be covered or drawn at zero size.
      if (inputValue === requestedNumber && (global || (await search.count() === 1 && await search.isVisible() && await search.isEnabled()))) {
        if (!global) visibleControls.push("Search button");
        candidates.push({ id: "search_record_number", established: true, description: global
          ? "Submit the portal's Global Search for the exact permit number."
          : "Submit the public Building permit record search." });
      }
    } else if (jurisdiction?.portalFamily === "tyler-civic-access") {
      const input = page.locator(TYLER_SEARCH_FIELD);

      if (await input.count() === 1 && await input.isVisible() && await input.isEnabled()) {
        inputValue = await input.inputValue();
        formLabels.push("Search public records with keywords or addresses");
        visibleControls.push("Public records search field");

        if (inputValue !== requestedNumber) candidates.push({ id: "fill_record_number", established: true, description: "Fill the public records keyword field with the exact permit number." });
        else if (!recentActions.includes("search_record_number") && await page.locator(TYLER_SEARCH_BUTTON).isEnabled()) {
          candidates.push({ id: "search_record_number", established: true, description: "Submit the exact permit number in Tyler Civic Access public records search." });
        }
      } else if (/#\/home/i.test(url)) {
        candidates.push({ id: "open_public_search", established: true, description: "Open Search Public Records in Hernando County Civic Access." });
      }
    } else if (jurisdiction?.portalFamily === "click2gov") {
      const parts = parseApplicationNumber(requestedNumber);
      const year = page.locator(ST_PETE_YEAR);
      const number = page.locator(ST_PETE_NUMBER);

      if (parts && await year.count() === 1 && await number.count() === 1 && await year.isVisible() && await number.isVisible()) {
        inputValue = `${await year.inputValue()}-${await number.inputValue()}`;
        formLabels.push("Application Number: year and serial number");
        visibleControls.push("Application Number search");

        if (inputValue !== `${parts.year}-${parts.serial}`) candidates.push({ id: "fill_record_number", established: true, description: "Enter the exact two-digit application year and serial number in Click2Gov." });
        else candidates.push({ id: "search_record_number", established: true, description: "Submit the City of St. Petersburg Application Number search." });
      }
    }

    // An adapter matches its own results above.
    const links = adapter ? [] : await exactResultLinks();

    if (!adapter) resultNumbers = links.map((link) => link.text);

    if (links.length > 1) phase = "results";

    if (links.length === 1) {
      const target = new URL(links[0]!.href, page.url());

      // Global Search result rows open their record through a postback rather than a link.
      if (jurisdiction && (globalSearch() || parsePortalUrl(target.toString(), "detail", jurisdiction.id))) {
        phase = "results";
        candidates.length = 0;
        candidates.push({ id: "open_exact_result", established: true, description: `Open the result whose displayed permit number exactly equals ${requestedNumber}.` });
      }
    } else if (links.length === 0 && onGlobalResults(url) && await page.locator(GLOBAL_NEXT_PAGE).count() === 1) {
      candidates.push({ id: "next_results_page", established: true, description: "Show the next page of Global Search results to look for the exact permit number." });
    }
  }

  // Only the start of the page is needed, so it is cut down before it leaves the browser.
  const challengeText = await page.evaluate(() => document.body?.innerText.slice(0, 3000) ?? "").catch(() => "");

  if (/captcha|verify you are human|are you a human|access denied|sign in|log in to continue/i.test(challengeText)) {
    phase = "challenge";
    candidates.length = 0;
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ url, phase, inputValue, displayedNumber, displayedStatus, resultNumbers, headings }))
    .digest("hex").slice(0, 20);

  const observation = {
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

  return { observation, record };
}

async function sendObservationOrResult(): Promise<void> {
  if (!page || !currentRun || stopped) return;
  const { observation, record } = await observe();
  lastObservation = observation;

  if (observation.phase === "challenge") {
    fail("blocked");

    return;
  }

  if (observation.phase === "results" && observation.resultNumbers.length > 1) {
    fail("ambiguous");

    return;
  }

  if (observation.phase === "search" && recentActions.includes("search_record_number")) {
    const adapter = portalAdapter();

    if (adapter) {
      if (await adapter.foundNothing()) {
        fail("not_found_in_supported_search");

        return;
      }
    } else if (jurisdiction?.portalFamily === "accela" && onGlobalResults(page.url())) {
      // Global Search matches whole record numbers, so a finished search without the exact row has no such record.
      if (observation.candidates.length === 0 && await page.locator(GLOBAL_RESULTS_LABEL).isVisible().catch(() => false)) {
        fail("not_found_in_supported_search");

        return;
      }
    } else if (jurisdiction?.portalFamily === "accela") {
      const message = page.getByText("Your search returned no results. Please modify your search criteria and try again.", { exact: true });
      const input = page.locator(SEARCH_FIELD);

      if (await message.count() === 1 && await message.isVisible() &&
        await input.count() === 1 && await input.inputValue() === requestedNumber) {
        fail("not_found_in_supported_search");

        return;
      }
    } else if (jurisdiction?.portalFamily === "tyler-civic-access" && await tylerFoundNothing(page)) {
      fail("not_found_in_supported_search");

      return;
    }
  }

  if (observation.phase === "detail" && jurisdiction) {
    const { displayedNumber, statusValue, statusLabel: labelText, recordUrl } = record ?? await readRecord();

    if (!displayedNumber || !sameJurisdictionPermitNumber(requestedNumber, displayedNumber, jurisdiction.id)) {
      fail("identity_mismatch");

      return;
    }

    if (!statusValue || !labelText) {
      fail("status_unavailable");

      return;
    }

    if (!recordUrl || !parsePortalUrl(recordUrl, "detail", jurisdiction.id)) {
      fail("record_link_unavailable");

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
    fail("unsupported_page");

    return;
  }

  send({ kind: "observation", runId: currentRun, observation });
}

async function start(message: Extract<MainToWorker, { kind: "start" }>): Promise<void> {
  currentRun = message.runId;
  jurisdiction = getAutomatedJurisdiction(message.jurisdictionId);

  if (!jurisdiction) {
    fail("unsupported_page");

    return;
  }

  requestedNumber = message.permitNumber;
  stopped = false;
  process.env.PLAYWRIGHT_BROWSERS_PATH = message.browserPath;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const contextOptions: BrowserContextOptions = { acceptDownloads: false, serviceWorkers: "block" };

  if ("plainUserAgent" in jurisdiction && jurisdiction.plainUserAgent) contextOptions.userAgent = await plainUserAgent(browser);
  context = await browser.newContext(contextOptions);
  page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("popup", (popup) => { void popup.close(); });
  page.on("framenavigated", (frame) => {
    // A failed load shows Chromium's error page; the failed goto itself decides whether to retry.
    if (frame === page?.mainFrame() && frame.url() !== "about:blank" && !frame.url().startsWith("chrome-error://") &&
      locationOf(frame.url()) === "other") {
      fail("unsupported_page");
    }
  });
  const epermitFormReady = jurisdiction.portalFamily === "epermit" ? watchEpermitForm(page) : null;
  const startUrl = jurisdiction.startUrl;

  const target = message.previousRecordUrl && parsePortalUrl(message.previousRecordUrl, "detail", jurisdiction.id) &&
    recordLinkShowsRecord(jurisdiction) ? message.previousRecordUrl : startUrl;

  let landed = target;

  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    if (stopped) return;

    // A portal occasionally drops the first connection (SWFWMD's resets HTTP/2), so the search gets a second try.
    if (target === startUrl) await page.waitForTimeout(1_500);
    landed = startUrl;

    if (page && !stopped) await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  // RegPermitting's record view settles on the same address as its search, so it is recognized by content.
  const recordOpened = landed !== startUrl && page !== null && !stopped && (jurisdiction.portalFamily === "regpermitting"
    ? await regPermittingRecordShown(page, 15_000) : locationOf(page.url()) === "permit-detail");

  if (landed !== startUrl && page && !stopped && !recordOpened) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  openedRecordUrl = recordOpened ? target : null;

  if (page && !stopped && locationOf(page.url()) === "permit-detail") await waitForDetail(page, jurisdiction);

  if (globalSearch() && page && !stopped && locationOf(page.url()) === "permit-search") {
    await page.locator(GLOBAL_SEARCH_FIELD).filter({ visible: true }).first()
      .waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  }

  // A saved record link opens straight to the record, which has no search controls to wait for.
  if (jurisdiction.portalFamily === "tyler-civic-access" && page && !stopped && locationOf(page.url()) === "permit-search") {
    await waitForTylerSearch(page);
  }

  if (epermitFormReady && page && !stopped) await epermitFormReady();

  if (jurisdiction.portalFamily === "regpermitting" && page && !stopped && !openedRecordUrl) await waitForSearchRecordsLink(page);
  await sendObservationOrResult();
}

async function choose(message: Extract<MainToWorker, { kind: "choose" }>): Promise<void> {
  if (!page || !currentRun || currentRun !== message.runId || !lastObservation || stopped) return;
  const { observation: fresh } = await observe();

  if (fresh.fingerprint !== message.fingerprint || fresh.candidates.length > 30) {
    await sendObservationOrResult();

    return;
  }

  if (!fresh.candidates.some((candidate) => candidate.id === message.candidateId)) {
    fail("unsupported_page");

    return;
  }

  const adapter = portalAdapter();

  switch (message.candidateId) {
    case "open_public_search": {
      if (adapter) {
        await adapter.openSearch?.();
        break;
      }

      if (jurisdiction?.portalFamily !== "tyler-civic-access") break;
      await page.goto("https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/search",
        { waitUntil: "domcontentloaded", timeout: 15_000 });
      await waitForTylerSearch(page);
      break;
    }

    case "fill_record_number": {
      if (adapter) {
        await adapter.fill();
      } else if (jurisdiction?.portalFamily === "click2gov") {
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
      if (adapter) {
        await adapter.submit();
      } else if (jurisdiction?.portalFamily === "click2gov") {
        const parts = parseApplicationNumber(requestedNumber);

        if (!parts || await page.locator(ST_PETE_YEAR).inputValue() !== parts.year ||
          await page.locator(ST_PETE_NUMBER).inputValue() !== parts.serial) break;
        await page.locator(ST_PETE_SEARCH_BUTTON).click();
        await page.getByRole("heading", { name: "Status Detail", exact: true })
          .waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
      } else if (jurisdiction?.portalFamily === "tyler-civic-access") {
        if (await page.locator(TYLER_SEARCH_FIELD).inputValue() !== requestedNumber) break;
        await page.locator(TYLER_SEARCH_BUTTON).click();
        await waitForTylerResults(page);
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
      if (adapter) {
        await adapter.openResult();
        break;
      }

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
      await waitForDetail(page, jurisdiction);
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
    if (message.runId === currentRun) fail("cancelled");

    return;
  }

  const task = message.kind === "start" ? start(message)
    : message.kind === "reobserve" ? sendObservationOrResult() : choose(message);

  void task.catch((cause: unknown) => {
    if (process.env.PERMIT_PORTAL_SMOKE === "1") process.stderr.write(`Worker smoke error: ${String(cause)}\n`);

    if (currentRun && !stopped) fail("browser_error");
  });
});
