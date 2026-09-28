import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BridgeResult } from "../src/shared/bridge.js";
import type { AppSnapshot, PermitHistory, PermitRow } from "../src/shared/permit.js";

/** What the test drives in the page: snapshots from "main", and the history requests the renderer made. */
interface TestBridge {
  historyCalls: string[];
  push(next: AppSnapshot): void;
  /** Answers the index-th history request with one observation showing `status`. */
  answerHistory(index: number, status: string): void;
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
    const pending: Array<{ permitId: string; resolve: (value: BridgeResult<PermitHistory>) => void }> = [];
    const ok = async () => ({ ok: true, value: null });

    const control: TestBridge = {
      historyCalls: [],
      push: (next) => { for (const listener of listeners) listener(next); },
      answerHistory: (index: number, status: string) => {
        const request = pending[index];

        request?.resolve({ ok: true, value: { runs: [{ id: "r1", permitId: request.permitId, startedAt: "2026-09-24T12:00:00.000Z",
          finishedAt: "2026-09-24T12:01:00.000Z", outcome: "success", actionCount: 0, requestCount: 0 }],
        observations: [{ id: "o1", runId: "r1", permitId: request.permitId,
          verifiedPermitNumber: "x", statusLabel: "Record Status:", statusValue: status, observedAt: "2026-09-24T12:00:00.000Z",
          recordUrl: "https://example.test" }] } });
      },
    };

    Object.assign(window, {
      testBridge: control,
      permitMonitor: {
        snapshot: async () => first,
        history: (permitId: string) => {
          control.historyCalls.push(permitId);

          return new Promise((resolve) => pending.push({ permitId, resolve }));
        },
        onSnapshot: (callback: (value: AppSnapshot) => void) => {
          listeners.push(callback);

          return () => undefined;
        },
        onLocalError: () => () => undefined,
        onOpenDetails: () => () => undefined,
        onAppEvent: () => () => undefined,
        addAndCheck: ok, checkNow: ok, cancel: ok, openPortal: ok, recordManualStatus: ok, saveKey: ok, removeKey: ok,
        openRecord: ok, openObservationRecord: ok, removePermit: ok, setMonitoring: ok, setCheckTimes: ok,
        setPermitMonitoring: ok, setProjectNumber: ok, setPreference: ok, checkForUpdate: ok, downloadUpdate: ok,
        installUpdate: ok, deleteLocalData: ok,
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
});
