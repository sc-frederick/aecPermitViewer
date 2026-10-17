import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAutomatedJurisdiction } from "../src/shared/jurisdictions.js";
import { parseDisplayedStatus, regPermittingRecordUrl } from "../src/shared/permit.js";
import type { DisplayedRecord } from "../src/worker/adapter.js";
import { regPermittingAdapter, regPermittingRecordShown } from "../src/worker/regpermitting.js";
import { defined } from "./support/defined.js";

const profile = defined(getAutomatedJurisdiction("sfwmd"), "SFWMD");

const pending = readFileSync("tests/fixtures/sfwmd/pending-record.html", "utf8");

let browser: Browser;

let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterEach(async () => {
  await page?.close();
});

afterAll(async () => {
  await browser?.close();
});

function regProfile() {
  if (profile.portalFamily !== "regpermitting") throw new Error("SFWMD profile must use RegPermitting");

  return profile;
}

function recordUrl(number: string, recordClass = "SFWMD-REG-PERMIT-WORK"): string {
  return defined(regPermittingRecordUrl(profile, `${recordClass} ${number}`), "record URL");
}

function verify(record: DisplayedRecord, requestedNumber: string) {
  return parseDisplayedStatus({
    jurisdictionId: profile.id,
    requestedNumber,
    displayedNumber: defined(record.displayedNumber, "displayed number"),
    statusLabel: defined(record.statusLabel, "status label"),
    statusValue: defined(record.statusValue, "status value"),
    recordUrl: defined(record.recordUrl, "record URL"),
    observedAt: "2026-09-30T12:00:00.000Z",
  });
}

async function serve(
  number: string,
  statusLabel: string,
  search = false,
  recordClass = "SFWMD-REG-PERMIT-WORK",
): Promise<string> {
  const permit = statusLabel === "Permit Status";

  const body = pending
    .replace("__NUMBER_LABEL__", permit ? "Permit Number" : "Application Number")
    .replace("__STATUS_LABEL__", statusLabel);

  const key = `${recordClass} ${number}`;
  const url = recordUrl(number, recordClass);
  page = await browser.newPage();
  await page.route("**/*", (route) => {
    if (route.request().url().includes("/record?")) {
      const html = search
        ? `<div id="search"><input name="${permit ? "$PpyDisplayHarness$ppyTempText" : "$PpyDisplayHarness$pAppID"}" value="${number}">
        <table id="bodyTbl_right" pl_prop="${permit ? "D_PermitSearch.pxResults" : "D_AppSearch.pxResults"}">
        <tr pl_index="1"><td><a href="#" onclick="document.querySelector('#search').remove();document.body.insertAdjacentHTML('beforeend',document.querySelector('template').innerHTML);return false">${number}</a></td></tr>
        </table></div><template>${body.replace(/<!doctype html>|<\/?html>|<\/?body>/g, "")}</template>`
        : body;

      return route.fulfill({ contentType: "text/html", body: html });
    }

    return route.fulfill({
      contentType: "text/html",
      body: `<iframe name="record" src="https://apps.sfwmd.gov/record?key=${encodeURIComponent(key)}"></iframe>`,
    });
  });
  await page.goto(search ? profile.startUrl : url);
  await defined(page.frame({ name: "record" }), "record frame").waitForLoadState("domcontentloaded");

  return url;
}

async function populate(number: string, status = "Issued"): Promise<void> {
  await defined(page.frame({ name: "record" }), "record frame").evaluate(
    ({ number, status }) => {
      const numberField = document.querySelector("#number");
      const statusField = document.querySelector("#status");

      if (numberField) numberField.textContent = number;

      if (statusField) statusField.textContent = status;
    },
    { number, status },
  );
}

/** Each kind of SFWMD record: a sample number, the label its status field carries, and its record class. */
const RECORD_KINDS: Array<[string, string, string]> = [
  ["260901-67337", "Application Status", "SFWMD-REG-PERMIT-WORK"],
  ["48-112909-P", "Permit Status", "SFWMD-REG-PERMIT-WORK"],
  ["260902-67338", "App Status", "SFWMD-REG-WUPERMIT-WORK"],
];

describe("SFWMD asynchronously populated records", () => {
  it.each(RECORD_KINDS)(
    "waits for a saved %s record's exact identity and %s value",
    async (number, statusLabel, recordClass) => {
      const url = await serve(number, statusLabel, false, recordClass);
      expect(await regPermittingRecordShown(page, 500)).toBe(true);
      const adapter = regPermittingAdapter(page, regProfile(), number, url, 2_000);
      let finished = false;

      const reading = adapter.read().then((record) => {
        finished = true;

        return record;
      });

      await page.waitForTimeout(50);
      expect(finished).toBe(false);
      await populate(number, "");
      await page.waitForTimeout(50);
      expect(finished).toBe(false);
      await populate(number);
      const record = await reading;
      expect(record).toMatchObject({ displayedNumber: number, statusLabel, statusValue: "Issued", recordUrl: url });
      expect(verify(record, number)._tag).toBe("ok");
    },
  );

  it.each(RECORD_KINDS)(
    "shares the field wait with %s search results and %s",
    async (number, statusLabel, recordClass) => {
      const url = await serve(number, statusLabel, true, recordClass);
      const adapter = regPermittingAdapter(page, regProfile(), number, null, 2_000);
      expect((await adapter.observe()).candidates.map((candidate) => candidate.id)).toEqual(["open_exact_result"]);
      await adapter.openResult();
      let finished = false;

      const reading = adapter.read().then((record) => {
        finished = true;

        return record;
      });

      await page.waitForTimeout(50);
      expect(finished).toBe(false);
      await populate(number);
      const record = await reading;
      expect(record.recordUrl).toBe(url);
      expect(verify(record, number)._tag).toBe("ok");
    },
  );

  it("returns missing fields within its bound instead of waiting indefinitely", async () => {
    const number = "48-112909-P";
    const url = await serve(number, "Permit Status");
    const adapter = regPermittingAdapter(page, regProfile(), number, url, 300);
    expect(await adapter.read()).toMatchObject({ displayedNumber: null, statusLabel: null, statusValue: null });
  });

  it("never accepts a populated wrong record", async () => {
    const number = "48-112909-P";
    const url = await serve(number, "Permit Status");
    await populate("48-112910-P");
    const record = await regPermittingAdapter(page, regProfile(), number, url, 300).read();
    expect(verify(record, number)).toMatchObject({ _tag: "err", outcome: "identity_mismatch" });
  });

  it("keeps status labels specific to the requested number kind", async () => {
    const number = "260901-67337";
    const url = await serve(number, "Application Status");
    await populate(number);
    await defined(page.frame({ name: "record" }), "record frame")
      .locator(".field-caption")
      .nth(1)
      .evaluate((caption) => {
        caption.textContent = "Permit Status";
      });
    const record = await regPermittingAdapter(page, regProfile(), number, url, 300).read();
    expect(record).toMatchObject({ displayedNumber: number, statusLabel: null, statusValue: null });
  });

  it("preserves main's approved record URL verification after fields become ready", async () => {
    const number = "48-112909-P";
    await serve(number, "Permit Status");
    await defined(page.frame({ name: "record" }), "record frame").goto("https://apps.sfwmd.gov/record?other=1");
    await populate(number);
    const record = await regPermittingAdapter(page, regProfile(), number, "https://example.invalid/record", 300).read();
    expect(record.recordUrl).toBe("https://example.invalid/record");
    expect(verify(record, number)).toMatchObject({ _tag: "err", outcome: "record_link_unavailable" });
  });
});
