import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { parsePortalUrl, samePermitNumber, START_URL } from "../shared/permit.js";
import type { Candidate, MainToWorker, PageObservation, WorkerToMain } from "../shared/worker-protocol.js";

const SEARCH_FIELD = "#ctl00_PlaceHolderMain_generalSearchForm_txtGSPermitNumber";
const SEARCH_BUTTON = "#ctl00_PlaceHolderMain_btnNewSearch";
const DETAIL_NUMBER = "#ctl00_PlaceHolderMain_lblPermitNumber";
const DETAIL_STATUS = "#ctl00_PlaceHolderMain_lblRecordStatus";
const DETAIL_STATUS_TITLE = "#ctl00_PlaceHolderMain_lblRecordStatusTitle";

let browser: Browser | null = null;
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
  if (parsePortalUrl(url, "search")) return "hillsborough-building-search";
  if (parsePortalUrl(url, "detail")) return "hillsborough-building-detail";
  return "other";
}

async function visibleText(selector: string): Promise<string | null> {
  if (!page) return null;
  const locator = page.locator(selector);
  if (await locator.count() !== 1 || !(await locator.isVisible())) return null;
  return (await locator.innerText()).trim();
}

async function exactResultLinks(): Promise<Array<{ text: string; href: string }>> {
  if (!page) return [];
  const anchors = page.locator("a");
  const count = Math.min(await anchors.count(), 250);
  const found: Array<{ text: string; href: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    if (!(await anchor.isVisible())) continue;
    const text = (await anchor.innerText()).trim();
    if (!samePermitNumber(requestedNumber, text)) continue;
    const href = await anchor.getAttribute("href");
    if (href) found.push({ text, href });
  }
  return found.filter((link, index) => found.findIndex((candidate) => candidate.href === link.href) === index);
}

async function observe(): Promise<PageObservation> {
  if (!page) throw new Error("Page not started");
  const url = page.url();
  const location = locationOf(url);
  const headings = (await page.locator("h1, h2, h3").allInnerTexts()).map((text) => text.trim()).filter(Boolean).slice(0, 8);
  const candidates: Candidate[] = [];
  let phase: PageObservation["phase"] = "unknown";
  let inputValue = "";
  let displayedNumber = "";
  let displayedStatus = "";
  let resultNumbers: string[] = [];
  const visibleControls: string[] = [];
  const formLabels: string[] = [];

  if (location === "hillsborough-building-detail") {
    phase = "detail";
    displayedNumber = (await visibleText(DETAIL_NUMBER)) ?? "";
    displayedStatus = (await visibleText(DETAIL_STATUS)) ?? "";
  } else if (location === "hillsborough-building-search") {
    phase = "search";
    const input = page.locator(SEARCH_FIELD);
    if (await input.count() === 1 && await input.isVisible() && await input.isEnabled()) {
      inputValue = await input.inputValue();
      formLabels.push("Record Number");
      visibleControls.push("Record Number field");
      if (inputValue !== requestedNumber) candidates.push({ id: "fill_record_number", description: "Fill the visible Record Number field with the exact requested permit number." });
    }
    const search = page.locator(SEARCH_BUTTON);
    if (inputValue === requestedNumber && await search.count() === 1 && await search.isVisible() && await search.isEnabled()) {
      visibleControls.push("Search button");
      candidates.push({ id: "search_record_number", description: "Submit the public Building and Site record search for the full permit number." });
    }
    const links = await exactResultLinks();
    resultNumbers = links.map((link) => link.text);
    if (links.length > 1) phase = "results";
    if (links.length === 1) {
      const target = new URL(links[0]!.href, page.url());
      if (parsePortalUrl(target.toString(), "detail")) {
        phase = "results";
        candidates.length = 0;
        candidates.push({ id: "open_exact_result", description: `Open the result whose displayed record number exactly equals ${requestedNumber}.` });
      }
    }
  }

  const challengeText = await page.locator("body").innerText().then((text) => text.slice(0, 3000)).catch(() => "");
  if (/captcha|verify you are human|access denied|sign in|log in to continue/i.test(challengeText)) {
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
    const message = page.getByText("Your search returned no results. Please modify your search criteria and try again.", { exact: true });
    const input = page.locator(SEARCH_FIELD);
    if (await message.count() === 1 && await message.isVisible() &&
      await input.count() === 1 && await input.inputValue() === requestedNumber) {
      fail({ kind: "failed", runId: currentRun, outcome: "not_found_in_supported_search" });
      return;
    }
  }
  if (observation.phase === "detail") {
    const displayedNumber = await visibleText(DETAIL_NUMBER);
    const statusValue = await visibleText(DETAIL_STATUS);
    const labelText = await visibleText(DETAIL_STATUS_TITLE);
    if (!displayedNumber || !samePermitNumber(requestedNumber, displayedNumber)) {
      fail({ kind: "failed", runId: currentRun, outcome: "identity_mismatch" });
      return;
    }
    if (!statusValue || labelText !== "Record Status:") {
      fail({ kind: "failed", runId: currentRun, outcome: "status_unavailable" });
      return;
    }
    send({
      kind: "verified",
      runId: currentRun,
      displayedNumber,
      statusLabel: labelText,
      statusValue,
      observedAt: new Date().toISOString(),
      recordUrl: page.url(),
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
  const target = message.previousRecordUrl && parsePortalUrl(message.previousRecordUrl, "detail")
    ? message.previousRecordUrl : START_URL;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    if (target !== START_URL && page && !stopped) await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    else throw new Error("Navigation failed");
  }
  if (target !== START_URL && page && !stopped && locationOf(page.url()) !== "hillsborough-building-detail") {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
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
    case "fill_record_number": {
      const input = page.locator(SEARCH_FIELD);
      if (await input.count() !== 1 || !(await input.isVisible()) || !(await input.isEnabled())) break;
      await input.fill(requestedNumber);
      break;
    }
    case "search_record_number": {
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
      break;
    }
    case "open_exact_result": {
      const links = await exactResultLinks();
      if (links.length !== 1) break;
      const target = new URL(links[0]!.href, page.url());
      if (!parsePortalUrl(target.toString(), "detail")) break;
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 12_000 });
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
