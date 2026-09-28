import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAutomatedJurisdiction } from "../src/shared/jurisdictions.js";
import { parseDisplayedStatus } from "../src/shared/permit.js";
import { readDetail, tylerFoundNothing, waitForDetail, waitForTylerResults, waitForTylerSearch } from "../src/worker/detail.js";

// Recorded Hernando pages, served at the portal's own address in the bundled Chromium, so the worker's reading code
// sees the markup it sees live.
const BASE = "https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod";

const PERMIT_URL = `${BASE}#/permit/f3a325c7-9779-4de4-9b08-3a6aff019939`;

const PLAN_URL = `${BASE}#/plan/5cc7d3ff-b001-4913-9fb1-0043d864fd54`;

const hernando = getAutomatedJurisdiction("hernando-county-building");

let browser: Browser;

let page: Page;

function fixture(name: string): string {
  return readFileSync(path.join("tests", "fixtures", "hernando", name), "utf8");
}

/** Opens `url` with the portal answering every request with `html`. */
async function serve(url: string, html: string): Promise<void> {
  page = await browser.newPage();
  await page.route("https://hernandocountyfl-energovweb.tylerhost.net/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

beforeAll(async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve("vendor/playwright-browsers");
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterEach(async () => {
  await page?.close();
});

afterAll(async () => {
  await browser?.close();
});

describe("Hernando record pages", () => {
  it("reads a permit's number and status from permit fields, and passes main's verification", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    await serve(PERMIT_URL, fixture("permit-detail.html"));

    const record = await readDetail(page, hernando, "BLDC-000576-2026");
    expect(record).toEqual({ displayedNumber: "BLDC-000576-2026", statusValue: "Final", statusLabel: "Status:", recordUrl: PERMIT_URL });
    expect(parseDisplayedStatus({ jurisdictionId: hernando.id, requestedNumber: "BLDC-000576-2026", displayedNumber: "BLDC-000576-2026",
      statusLabel: "Status:", statusValue: "Final", recordUrl: PERMIT_URL, observedAt: "2026-09-28T12:00:00.000Z" })._tag).toBe("ok");
  });

  it("reads a plan's number and status from plan fields", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    await serve(PLAN_URL, fixture("plan-detail.html"));

    const record = await readDetail(page, hernando, "DEVP-000011-2026");
    expect(record).toEqual({ displayedNumber: "DEVP-000011-2026", statusValue: "Deficient", statusLabel: "Status:", recordUrl: PLAN_URL });
    expect(parseDisplayedStatus({ jurisdictionId: hernando.id, requestedNumber: "DEVP-000011-2026", displayedNumber: "DEVP-000011-2026",
      statusLabel: "Status:", statusValue: "Deficient", recordUrl: PLAN_URL, observedAt: "2026-09-28T12:00:00.000Z" })._tag).toBe("ok");
  });

  it("reads nothing when the page's fields don't belong to the kind of record its address names", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    await serve(PLAN_URL, fixture("permit-detail.html"));

    expect(await readDetail(page, hernando, "BLDC-000576-2026")).toMatchObject({ displayedNumber: null, statusValue: null });
  });

  it("refuses an ambiguous status", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    const plan = fixture("plan-detail.html");
    const block = /<div class="form-group" id="label-PlanDetail-Status"[\s\S]*?<\/div>/.exec(plan)?.[0] ?? "";
    expect(block).not.toBe("");
    await serve(PLAN_URL, plan.replace(block, block + block.replace("Deficient", "Approved")));

    expect(await readDetail(page, hernando, "DEVP-000011-2026")).toMatchObject({ displayedNumber: "DEVP-000011-2026", statusValue: null });
  });

  it("reads nothing from record kinds the app doesn't check", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    await serve(`${BASE}#/case/5cc7d3ff-b001-4913-9fb1-0043d864fd54`, fixture("plan-detail.html"));

    expect(await readDetail(page, hernando, "DEVP-000011-2026")).toEqual({ displayedNumber: null, statusValue: null, statusLabel: null, recordUrl: null });
  });

  it("finds an already rendered record ready without waiting on search controls", async () => {
    if (!hernando) throw new Error("Hernando profile missing");
    await serve(PLAN_URL, fixture("plan-detail.html"));

    const started = Date.now();
    await waitForDetail(page, hernando);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("Hernando search", () => {
  it("waits for a search form that renders after load", async () => {
    const late = `<!doctype html><html><body><script>
      setTimeout(() => { const input = document.createElement("input"); input.id = "SearchKeyword"; document.body.append(input); }, 1500);
    </script></body></html>`;

    await serve(`${BASE}#/search`, late);

    await waitForTylerSearch(page);
    expect(await page.locator("#SearchKeyword").isVisible()).toBe(true);
  });

  it("settles on the visible result message and tells a finished empty search apart", async () => {
    await serve(`${BASE}#/search`, fixture("search-one-result.html"));
    const started = Date.now();
    await waitForTylerResults(page);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await tylerFoundNothing(page)).toBe(false);
    await page.close();

    await serve(`${BASE}#/search`, fixture("search-no-results.html"));
    expect(await tylerFoundNothing(page)).toBe(true);
  });
});
