import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCheck, type CheckWorker } from "../src/main/check-runner.js";
import { getAutomatedJurisdiction } from "../src/shared/jurisdictions.js";
import type { MainToWorker, WorkerToMain } from "../src/shared/worker-protocol.js";
import { accelaGlobalResultsAdapter } from "../src/worker/accela-global.js";
import { readDetail } from "../src/worker/detail.js";
import { defined } from "./support/defined.js";
import { permitRow } from "./support/permit-row.js";
import { temporaryDirectory } from "./support/temporary-directory.js";

const profile = defined(getAutomatedJurisdiction("hillsborough-county-building"), "Hillsborough");

const NUMBER = "HC-BLD-26-0000123";

const RESULTS_URL = "https://aca-prod.accela.com/HCFL/Cap/GlobalSearchResults.aspx";

const RECORD_URL =
  "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL";

const html = readFileSync("tests/fixtures/hillsborough/global-search-pages.html", "utf8");

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

async function serve(): Promise<void> {
  page = await browser.newPage();
  await page.route("**/*", (route) => {
    const detail = route.request().url().includes("CapDetail.aspx");

    return route.fulfill({
      contentType: "text/html",
      body: detail
        ? `<span id="ctl00_PlaceHolderMain_lblPermitNumber">${NUMBER}</span>
      <span id="ctl00_PlaceHolderMain_lblRecordStatusTitle">Record Status:</span><span id="ctl00_PlaceHolderMain_lblRecordStatus">Issued</span>
      <div id="tab-processing_status"><div id="divProcessingTable"><span class="ACA_CapDetail_NoRecord">No records found.</span></div></div>`
        : html,
    });
  });
  await page.goto(RESULTS_URL);
}

class BrowserWorker implements CheckWorker {
  private readonly messages: Array<(message: WorkerToMain) => void> = [];
  private readonly exits: Array<() => void> = [];
  readonly choices: string[] = [];
  readonly failures: unknown[] = [];
  private stopped = false;

  send(message: MainToWorker): void {
    if (message.kind === "cancel") {
      this.stopped = true;
      setImmediate(() => this.kill());

      return;
    }

    void this.drive(message).catch((cause: unknown) => {
      this.failures.push(cause);
      this.emit({ kind: "failed", runId: "fixture-run", outcome: "browser_error" });
    });
  }

  kill(): void {
    for (const exit of this.exits.splice(0)) exit();
  }

  onMessage(listener: (message: WorkerToMain) => void): void {
    this.messages.push(listener);
  }

  onExit(listener: () => void): void {
    this.exits.push(listener);
  }

  onError(): void {}

  private emit(message: WorkerToMain): void {
    setImmediate(() => {
      if (!this.stopped) for (const listener of this.messages) listener(message);
    });
  }

  private async drive(message: Exclude<MainToWorker, { kind: "cancel" }>): Promise<void> {
    const adapter = accelaGlobalResultsAdapter(page, profile, NUMBER);

    if (message.kind === "choose") {
      const fresh = await adapter.observe();

      if (fresh.pageIdentity !== message.fingerprint) throw new Error("Stale fixture choice");
      this.choices.push(message.candidateId);

      if (message.candidateId === "next_results_page") await adapter.next();
      else if (message.candidateId === "open_exact_result") await adapter.openResult();
      else throw new Error("Unsupported fixture action");
      this.emit({ kind: "action_count", runId: message.runId, count: this.choices.length });
    }

    if (page.url() === RECORD_URL) {
      const record = await readDetail(page, profile, NUMBER);
      const displayedNumber = defined(record.displayedNumber, "record number");
      const statusLabel = defined(record.statusLabel, "record label");
      const statusValue = defined(record.statusValue, "record status");
      const recordUrl = defined(record.recordUrl, "record URL");
      this.emit({
        kind: "verified",
        runId: message.runId,
        displayedNumber,
        statusLabel,
        statusValue,
        recordUrl,
        reviews: record.reviews ?? null,
        observedAt: "2026-09-30T12:00:00.000Z",
        browserVersion: browser.version(),
      });

      return;
    }

    const search = await adapter.observe();

    if (search.resultNumbers.length > 1) this.emit({ kind: "failed", runId: message.runId, outcome: "ambiguous" });
    else if (await adapter.foundNothing())
      this.emit({ kind: "failed", runId: message.runId, outcome: "not_found_in_supported_search" });
    else
      this.emit({
        kind: "observation",
        runId: message.runId,
        observation: {
          ...search,
          location: "permit-search",
          fingerprint: search.pageIdentity,
          headings: ["Global Search"],
          recentActions: this.choices.slice(-3),
        },
      });
  }
}

async function checkResults() {
  const permit = permitRow({ jurisdictionId: profile.id, permitNumber: NUMBER, checking: true });
  const worker = new BrowserWorker();

  const active = runCheck({
    runId: "fixture-run",
    permit,
    key: "unused-fixture-key",
    browserPath: "/unused",
    cacheRoot: temporaryDirectory("permit-global-fixture-"),
    startWorker: () => ({ _tag: "started", worker }),
    report: (_operation, cause) => {
      worker.failures.push(cause);
    },
  });

  try {
    const result = await active.result;
    await active.closed;
    expect(worker.failures).toEqual([]);

    return { result, choices: worker.choices };
  } finally {
    active.cancel();
  }
}

describe("Accela Global Search pagination", () => {
  it("reaches an exact match on page 3 with zero model requests and verifies the number and URL", async () => {
    await serve();
    const { result, choices } = await checkResults();
    expect(result).toMatchObject({
      outcome: "success",
      actionCount: 3,
      requestCount: 0,
      observation: { verifiedPermitNumber: NUMBER, statusValue: "Issued", recordUrl: RECORD_URL },
    });
    expect(choices).toEqual(["next_results_page", "next_results_page", "open_exact_result"]);
  });

  it("fingerprints changed nonmatching rows and page markers without including those rows in navigation context", async () => {
    await serve();
    const adapter = accelaGlobalResultsAdapter(page, profile, NUMBER);
    const first = await adapter.observe();
    expect(first.resultNumbers).toEqual([]);
    expect((await adapter.observe()).pageIdentity).toBe(first.pageIdentity);
    await page.locator("#row_lnkPermitNumber").evaluate((anchor) => {
      anchor.textContent = "HC-BLD-26-0000333";
    });
    const changedRows = await adapter.observe();
    expect(changedRows.pageIdentity).not.toBe(first.pageIdentity);
    expect(changedRows.resultNumbers).toEqual([]);
    await page.locator("#current-page").evaluate((marker) => {
      marker.textContent = "2";
    });
    expect((await adapter.observe()).pageIdentity).not.toBe(changedRows.pageIdentity);
  });

  it("keeps duplicate exact matches ambiguous", async () => {
    await serve();
    await page.locator("#results").evaluate((table, number) => {
      table.innerHTML = `<tr><td><a id="a_lnkPermitNumber" href="javascript:openRecord(1)">${number}</a></td></tr>
        <tr><td><a id="b_lnkPermitNumber" href="javascript:openRecord(2)">${number}</a></td></tr>`;
    }, NUMBER);
    const { result, choices } = await checkResults();
    expect(result.outcome).toBe("ambiguous");
    expect(choices).toEqual([]);
  });

  it("returns not found on a completed final page without the requested number", async () => {
    await serve();
    await page.locator("a:has-text('Next >')").evaluate((anchor) => anchor.remove());
    const { result, choices } = await checkResults();
    expect(result.outcome).toBe("not_found_in_supported_search");
    expect(choices).toEqual([]);
  });

  it("bounds an unchanged postback without repeating Next or calling the model", async () => {
    await serve();
    await page.locator("a:has-text('Next >')").evaluate((anchor) => anchor.setAttribute("onclick", "return false"));
    const { result, choices } = await checkResults();
    expect(result).toMatchObject({ outcome: "unsupported_page", actionCount: 1, requestCount: 0, actualModel: null });
    expect(choices).toEqual(["next_results_page"]);
  }, 25_000);
});
