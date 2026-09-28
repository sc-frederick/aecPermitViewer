import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BridgeResult } from "../src/shared/bridge.js";
import type { AppSnapshot, PermitHistory, PermitRow } from "../src/shared/permit.js";

/** What the test drives in the page: snapshots from "main", and the requests the renderer made. */
interface TestBridge {
  historyCalls: string[];
  /** Each schedule the renderer asked main to save, in order. */
  checkTimeCalls: string[][];
  /** Reasons of promise rejections nothing in the page handled. */
  unhandled: string[];
  push(next: AppSnapshot): void;
  /** Answers the index-th history request with one observation showing `status`. */
  answerHistory(index: number, status: string): void;
  /** Answers the index-th history request with a failure main reported. */
  failHistory(index: number, error: string): void;
  /** Rejects the index-th history request, as a broken IPC channel would. */
  rejectHistory(index: number): void;
  /** Makes every later call of the named bridge method answer with a failure carrying `error`. */
  fail(method: string, error: string): void;
}

declare global {
  interface Window {
    testBridge: TestBridge;
    keptRows: Set<Element>;
  }
}

// The real renderer bundle runs in the bundled Chromium against a controlled bridge that stands in for main.
let browser: Browser;

let page: Page;

let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-renderer-"));
  await build({ entryPoints: ["src/renderer/index.ts"], outfile: path.join(directory, "renderer.js"), bundle: true,
    target: "es2022", platform: "browser", format: "iife", logLevel: "silent" });
  copyFileSync("src/renderer/index.html", path.join(directory, "index.html"));
  copyFileSync("src/renderer/styles.css", path.join(directory, "styles.css"));
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
});

function permit(index: number, overrides: Partial<PermitRow> = {}): PermitRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    jurisdictionId: "hillsborough-county-building",
    permitNumber: `HC-BLD-26-${String(index).padStart(7, "0")}`,
    projectNumber: null,
    monitoringEnabled: true,
    lastStatus: "In Process",
    lastObservedAt: "2026-09-24T12:00:00.000Z",
    lastRecordUrl: "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx",
    latestAttemptAt: "2026-09-24T12:00:00.000Z",
    latestOutcome: "success",
    nextDueAt: null,
    checking: false,
    ...overrides,
  };
}

function snapshot(permits: PermitRow[]): AppSnapshot {
  return {
    permits,
    keyState: "configured",
    appVersion: "0.0.0",
    browserVersion: "test",
    monitoring: "manual",
    checkTimes: ["08:30"],
    preferences: {
      notifyStatusChanges: true, notifyFailures: true, runInBackground: false, openAtLogin: false,
      backgroundAvailable: false, openAtLoginAvailable: false,
    },
  };
}

/** Opens the renderer with `initial` as main's first snapshot. The bridge records history requests and holds them open. */
async function open(initial: AppSnapshot): Promise<void> {
  await page?.close();
  page = await browser.newPage();
  await page.addInitScript((first) => {
    const listeners: Array<(value: AppSnapshot) => void> = [];

    const pending: Array<{ permitId: string; resolve: (value: BridgeResult<PermitHistory>) => void; reject: (cause: Error) => void }> = [];

    const failures = new Map<string, string>();

    const answer = (method: string) => async (): Promise<BridgeResult<null>> => {
      const error = failures.get(method);

      return error === undefined ? { ok: true, value: null } : { ok: false, error };
    };

    const control: TestBridge = {
      historyCalls: [],
      checkTimeCalls: [],
      unhandled: [],
      push: (next) => { for (const listener of listeners) listener(next); },
      failHistory: (index, error) => { pending[index]?.resolve({ ok: false, error }); },
      rejectHistory: (index) => { pending[index]?.reject(new Error("IPC channel closed")); },
      fail: (method, error) => { failures.set(method, error); },
      answerHistory: (index: number, status: string) => {
        const request = pending[index];

        request?.resolve({ ok: true, value: { runs: [{ id: "r1", permitId: request.permitId, startedAt: "2026-09-24T12:00:00.000Z",
          finishedAt: "2026-09-24T12:01:00.000Z", outcome: "success", actionCount: 0, requestCount: 0 }],
        observations: [{ id: "o1", runId: "r1", permitId: request.permitId,
          verifiedPermitNumber: "x", statusLabel: "Record Status:", statusValue: status, observedAt: "2026-09-24T12:00:00.000Z",
          recordUrl: "https://example.test" }] } });
      },
    };

    window.addEventListener("unhandledrejection", (event) => { control.unhandled.push(String(event.reason)); });

    const methods = ["addAndCheck", "checkNow", "cancel", "openPortal", "recordManualStatus", "saveKey", "removeKey", "openRecord",
      "openObservationRecord", "removePermit", "setMonitoring", "setPermitMonitoring", "setProjectNumber", "setPreference",
      "checkForUpdate", "downloadUpdate", "installUpdate", "deleteLocalData"];

    Object.assign(window, {
      testBridge: control,
      permitMonitor: {
        ...Object.fromEntries(methods.map((method) => [method, answer(method)])),
        snapshot: async () => first,
        history: (permitId: string) => {
          control.historyCalls.push(permitId);

          return new Promise((resolve, reject) => pending.push({ permitId, resolve, reject }));
        },
        setCheckTimes: async (times: string[]) => {
          control.checkTimeCalls.push(times);

          return answer("setCheckTimes")();
        },
        onSnapshot: (callback: (value: AppSnapshot) => void) => {
          listeners.push(callback);

          return () => undefined;
        },
        onLocalError: () => () => undefined,
        onOpenDetails: () => () => undefined,
        onAppEvent: () => () => undefined,
      },
    });
  }, initial);
  await page.goto(pathToFileURL(path.join(directory, "index.html")).href);
  await page.locator("#permit-table tbody tr").first().waitFor({ state: "attached" });
}

async function push(next: AppSnapshot): Promise<void> {
  await page.evaluate((value) => window.testBridge.push(value), next);
}

async function historyCalls(): Promise<string[]> {
  return page.evaluate(() => window.testBridge.historyCalls);
}

async function checkTimeCalls(): Promise<string[][]> {
  return page.evaluate(() => window.testBridge.checkTimeCalls);
}

/** Whether the notice is showing and a click at its center would land on it, so no dialog covers it. */
async function noticeOnTop(): Promise<boolean> {
  return page.locator("#notice").evaluate((node) => {
    if (!(node instanceof HTMLElement) || node.hidden) return false;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);

    return hit !== null && node.contains(hit);
  });
}

const fifty = Array.from({ length: 50 }, (_, index) => permit(index + 1));

beforeEach(async () => {
  await open(snapshot(fifty));
});

describe("permit table updates", () => {
  it("keeps focus and unchanged rows when another permit's check starts", async () => {
    const focused = page.locator(`button[data-action="check"][data-permit-id="${fifty[9]!.id}"]`);
    await focused.focus();
    await page.evaluate(() => {
      window.keptRows = new Set(document.querySelectorAll("#permit-table tbody tr"));
    });

    await push(snapshot(fifty.map((entry, index) => index === 19 ? { ...entry, checking: true } : entry)));

    expect(await focused.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll("#permit-table tbody tr")]
      .every((row) => window.keptRows.has(row)))).toBe(true);
    await expect.poll(() => page.locator(`button[data-permit-id="${fifty[19]!.id}"][data-action="cancel"]`).count()).toBe(1);
  });

  it("groups by project and moves rows between groups as numbers change", async () => {
    await push(snapshot(fifty.map((entry, index) => index < 3 ? { ...entry, projectNumber: "28069" } : entry)));

    const heads = await page.locator("#permit-table tr.group-row .group-head").evaluateAll((nodes) =>
      nodes.map((node) => [...node.children].map((part) => part.textContent).join(" ")));

    expect(heads).toEqual(["Project 28069 3 permits", "No project 47 permits"]);
    expect(await page.locator("#permit-table tbody tr:not(.group-row)").count()).toBe(50);

    await push(snapshot(fifty));
    expect(await page.locator("#permit-table tr.group-row").count()).toBe(0);
    expect(await page.locator("#permit-table tbody").count()).toBe(1);
  });

  it("treats a permit that leaves the list and returns as new", async () => {
    const returning = permit(1);
    await push(snapshot(fifty.slice(1)));
    await push(snapshot(fifty));

    expect(await page.locator(`#permit-table tr:has(button[data-permit-id="${returning.id}"])`).getAttribute("class")).toBe("row-enter");
  });
});

describe("check time editing", () => {
  const schedule = { ...snapshot(fifty), monitoring: "scheduled" as const, checkTimes: ["08:30", "12:30", "16:30"] };

  const times = () => page.locator("#check-time-list input").evaluateAll((nodes) =>
    nodes.map((node) => node instanceof HTMLInputElement ? node.value : null));

  beforeEach(async () => {
    await open(schedule);
    await page.locator("#open-settings").click();
  });

  it("saves the schedule without the removed time", async () => {
    await page.locator("#check-time-list button[data-remove-time]").nth(1).click();

    await expect.poll(checkTimeCalls).toEqual([["08:30", "16:30"]]);
  });

  it("removes the clicked row and holds the save until a cleared row is filled in", async () => {
    const inputs = page.locator("#check-time-list input");
    await inputs.nth(0).fill("");
    await page.locator("#check-time-list button[data-remove-time]").nth(1).click();

    expect(await times()).toEqual(["", "16:30"]);
    expect(await inputs.nth(0).getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("#check-time-error").isVisible()).toBe(true);
    expect(await checkTimeCalls()).toEqual([]);

    await inputs.nth(0).fill("09:00");
    await expect.poll(checkTimeCalls).toEqual([["09:00", "16:30"]]);
  });
});

describe("notices over dialogs", () => {
  it("shows a failed check from the details sheet in front of the sheet", async () => {
    await page.evaluate(() => window.testBridge.fail("checkNow", "The portal didn't answer."));
    await page.locator(`button[data-action="details"][data-permit-id="${permit(1).id}"]`).click();
    await page.locator("#details-check").click();

    await expect.poll(() => page.locator("#notice-text").textContent()).toBe("The portal didn't answer.");
    await expect.poll(noticeOnTop).toBe(true);
  });

  it("shows a failed delete from Settings in front of Settings", async () => {
    await page.evaluate(() => window.testBridge.fail("deleteLocalData", "Data couldn't be deleted."));
    await page.locator("#open-settings").click();
    await page.locator("#delete-local-data").click();
    await page.locator("#confirm-accept").click();

    await expect.poll(() => page.locator("#notice-text").textContent()).toBe("Data couldn't be deleted.");
    await expect.poll(noticeOnTop).toBe(true);
  });

  it("moves a showing notice in front of a sheet opened after it", async () => {
    await page.evaluate(() => window.testBridge.fail("checkNow", "The portal didn't answer."));
    await page.locator(`button[data-action="check"][data-permit-id="${permit(1).id}"]`).click();
    await expect.poll(noticeOnTop).toBe(true);

    await page.locator("#open-settings").click();
    await expect.poll(noticeOnTop).toBe(true);
  });
});

describe("AEC filter", () => {
  it("includes cautious AEC? badges, leaves unclassified permits out, and never reads as an all-clear", async () => {
    await open(snapshot([
      permit(1, { lastStatus: "Awaiting Client Reply" }),
      permit(2, { lastStatus: "Expired" }),
      permit(3, { lastStatus: "Issued" }),
      permit(4, { jurisdictionId: "swfwmd-erp", permitNumber: "43047590.008", lastStatus: "Issued" }),
    ]));
    const actionCells = page.locator("#permit-table tbody tr td:nth-child(3)");
    expect(await actionCells.allInnerTexts()).toEqual(["AEC", "AEC?", "NONE", "—"]);

    await page.selectOption("#permit-filter", "applicant");
    expect(await page.locator("#permit-table tbody tr").count()).toBe(2);

    await push(snapshot([permit(3, { lastStatus: "Issued" }), permit(4, { jurisdictionId: "swfwmd-erp", permitNumber: "43047590.008", lastStatus: "Issued" })]));
    expect(await page.locator("#empty-state").innerText()).toBe("No matches.");
  });
});

describe("details history", () => {
  it("requests history once while snapshots about other permits arrive, then again when this permit changes", async () => {
    await page.locator(`button[data-action="details"][data-permit-id="${fifty[0]!.id}"]`).click();
    expect(await historyCalls()).toEqual([fifty[0]!.id]);

    await push(snapshot(fifty.map((entry, index) => index === 5 ? { ...entry, checking: true } : entry)));
    await push(snapshot(fifty.map((entry, index) => index === 6 ? { ...entry, checking: true } : entry)));
    expect(await historyCalls()).toEqual([fifty[0]!.id]);

    await push(snapshot(fifty.map((entry, index) => index === 0 ? { ...entry, latestAttemptAt: "2026-09-25T12:00:00.000Z" } : entry)));
    expect(await historyCalls()).toEqual([fifty[0]!.id, fifty[0]!.id]);

    // The older answer arrives last and is dropped; the newer one is shown.
    await page.evaluate(() => window.testBridge.answerHistory(1, "Newer"));
    await page.evaluate(() => window.testBridge.answerHistory(0, "Older"));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Newer");
    expect(await page.locator("#history-list").innerText()).not.toContain("Older");
  });

  it("shows a failed read apart from an empty history, and retries it", async () => {
    const shown = permit(1);
    await page.locator(`button[data-action="details"][data-permit-id="${shown.id}"]`).click();
    await page.evaluate(() => window.testBridge.rejectHistory(0));

    const retry = page.locator("#history-list button[data-history-retry]");
    await retry.waitFor();
    expect(await page.locator("#history-list").innerText()).not.toContain("No checks yet");
    expect(await page.evaluate(() => window.testBridge.unhandled)).toEqual([]);

    // Snapshots about other permits leave the failure alone rather than asking again.
    await push(snapshot(fifty.map((entry, index) => index === 5 ? { ...entry, checking: true } : entry)));
    expect(await historyCalls()).toEqual([shown.id]);

    await retry.click();
    expect(await historyCalls()).toEqual([shown.id, shown.id]);
    await page.evaluate(() => window.testBridge.answerHistory(1, "Issued"));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Issued");

    await push(snapshot(fifty.map((entry, index) => index === 0 ? { ...entry, latestAttemptAt: "2026-09-25T12:00:00.000Z" } : entry)));
    await page.evaluate(() => window.testBridge.failHistory(2, "Permit not found."));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Permit not found.");
    expect(await retry.count()).toBe(1);
  });
});
