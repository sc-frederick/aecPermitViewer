import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAutomatedJurisdiction } from "../src/shared/jurisdictions.js";
import { parseDisplayedStatus } from "../src/shared/permit.js";
import type { DisplayedRecord } from "../src/worker/adapter.js";
import { readDetail, tylerFoundNothing, waitForLanding, waitForTylerResults } from "../src/worker/detail.js";
import { defined } from "./support/defined.js";

const BASE = "https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod";

const PERMIT_URL = `${BASE}#/permit/f3a325c7-9779-4de4-9b08-3a6aff019939`;

const PLAN_URL = `${BASE}#/plan/5cc7d3ff-b001-4913-9fb1-0043d864fd54`;

const hernando = defined(getAutomatedJurisdiction("hernando-county-building"), "the Hernando profile");

let browser: Browser;

let page: Page;

function fixture(name: string): string {
  return readFileSync(path.join("tests", "fixtures", "hernando", name), "utf8");
}

async function serve(url: string, html: string): Promise<void> {
  page = await browser.newPage();
  await page.route("https://hernandocountyfl-energovweb.tylerhost.net/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

function renderedLater(html: string): string {
  return html.replace("<body>", '<body><template id="later">').replace("</body>", "</template></body>");
}

async function render(): Promise<void> {
  await page.evaluate(() => {
    const later = document.querySelector("#later");

    if (later instanceof HTMLTemplateElement) document.body.append(later.content.cloneNode(true));
  });
}

interface WatchedWait {
  finished: Promise<void>;
  done: () => boolean;
}

function watch(wait: Promise<void>): WatchedWait {
  let done = false;

  return {
    finished: wait.then(() => {
      done = true;
    }),
    done: () => done,
  };
}

function verify(record: DisplayedRecord, requestedNumber: string): ReturnType<typeof parseDisplayedStatus> {
  const { displayedNumber, statusLabel, statusValue, recordUrl } = record;

  if (!displayedNumber || !statusLabel || !statusValue || !recordUrl) throw new Error("Record incomplete");

  return parseDisplayedStatus({
    jurisdictionId: hernando.id,
    requestedNumber,
    displayedNumber,
    statusLabel,
    statusValue,
    recordUrl,
    observedAt: "2026-09-28T12:00:00.000Z",
  });
}

beforeAll(async () => {
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
    await serve(PERMIT_URL, fixture("permit-detail.html"));

    const record = await readDetail(page, hernando, "BLDC-000576-2026");
    expect(record).toEqual({
      displayedNumber: "BLDC-000576-2026",
      statusValue: "Final",
      statusLabel: "Status:",
      recordUrl: PERMIT_URL,
    });
    expect(verify(record, "BLDC-000576-2026")).toMatchObject({
      _tag: "ok",
      value: { statusValue: "Final", recordUrl: PERMIT_URL },
    });
  });

  it("reads a plan's number and status from plan fields, and passes main's verification", async () => {
    await serve(PLAN_URL, fixture("plan-detail.html"));

    const record = await readDetail(page, hernando, "DEVP-000011-2026");
    expect(record).toEqual({
      displayedNumber: "DEVP-000011-2026",
      statusValue: "Deficient",
      statusLabel: "Status:",
      recordUrl: PLAN_URL,
    });
    expect(verify(record, "DEVP-000011-2026")).toMatchObject({
      _tag: "ok",
      value: { statusValue: "Deficient", recordUrl: PLAN_URL },
    });
  });

  it("reads nothing when the page's fields don't belong to the kind of record its address names", async () => {
    await serve(PLAN_URL, fixture("permit-detail.html"));

    expect(await readDetail(page, hernando, "BLDC-000576-2026")).toMatchObject({
      displayedNumber: null,
      statusValue: null,
    });
  });

  it("refuses an ambiguous status", async () => {
    const plan = fixture("plan-detail.html");

    const block = defined(
      /<div class="form-group" id="label-PlanDetail-Status"[\s\S]*?<\/div>/.exec(plan)?.[0],
      "the plan's status field",
    );

    await serve(PLAN_URL, plan.replace(block, block + block.replace("Deficient", "Approved")));

    expect(await readDetail(page, hernando, "DEVP-000011-2026")).toMatchObject({
      displayedNumber: "DEVP-000011-2026",
      statusValue: null,
    });
  });

  it("reads nothing from record kinds the app doesn't check", async () => {
    await serve(`${BASE}#/case/5cc7d3ff-b001-4913-9fb1-0043d864fd54`, fixture("plan-detail.html"));

    expect(await readDetail(page, hernando, "DEVP-000011-2026")).toEqual({
      displayedNumber: null,
      statusValue: null,
      statusLabel: null,
      recordUrl: null,
    });
  });

  it("lands on a saved record link once the record renders, without waiting on search controls", async () => {
    await serve(PLAN_URL, renderedLater(fixture("plan-detail.html")));

    const landing = watch(waitForLanding(page, hernando));
    expect(await readDetail(page, hernando, "DEVP-000011-2026")).toMatchObject({
      displayedNumber: null,
      statusValue: null,
    });
    expect(landing.done()).toBe(false);

    await render();
    await landing.finished;
    const record = await readDetail(page, hernando, "DEVP-000011-2026");
    expect(verify(record, "DEVP-000011-2026")._tag).toBe("ok");
  });
});

describe("Hernando search", () => {
  it("lands on the search page once its keyword field renders", async () => {
    await serve(
      `${BASE}#/search`,
      renderedLater('<!doctype html><html><body><input id="SearchKeyword"></body></html>'),
    );

    const landing = watch(waitForLanding(page, hernando));
    expect(await page.locator("#SearchKeyword").count()).toBe(0);
    expect(landing.done()).toBe(false);

    await render();
    await landing.finished;
    expect(await page.locator("#SearchKeyword").isVisible()).toBe(true);
  });

  it("settles on the result message once it shows, and tells a finished empty search apart", async () => {
    const pending = fixture("search-one-result.html").replace(
      'aria-hidden="false" class=""',
      'aria-hidden="false" class="ng-hide"',
    );

    expect(pending).not.toBe(fixture("search-one-result.html"));
    await serve(`${BASE}#/search`, pending);

    const results = watch(waitForTylerResults(page));
    expect(await page.locator("#moduleResultMessage label").filter({ visible: true }).count()).toBe(0);
    expect(results.done()).toBe(false);

    await page.getByText("Found 1 result", { exact: true }).evaluate((label) => label.classList.remove("ng-hide"));
    await results.finished;
    expect(await tylerFoundNothing(page)).toBe(false);
    await page.close();

    await serve(`${BASE}#/search`, fixture("search-no-results.html"));
    expect(await tylerFoundNothing(page)).toBe(true);
  });
});
