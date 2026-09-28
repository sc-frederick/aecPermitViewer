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
  /** Answers the renderer's first direct snapshot request, when the page was opened with it held. */
  answerSnapshot(): void;
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

let revision = 0;

/** A snapshot as main would send it next: each one takes a higher revision than the one before. */
function snapshot(permits: PermitRow[], overrides: Partial<Omit<AppSnapshot, "revision" | "permits">> = {}): AppSnapshot {
  revision += 1;

  return {
    revision,
    permits,
    keyState: "configured",
    appVersion: "0.0.0",
    monitoring: "manual",
    checkTimes: ["08:30"],
    preferences: {
      notifyStatusChanges: true, notifyFailures: true, runInBackground: false, openAtLogin: false,
      backgroundAvailable: false, openAtLoginAvailable: false,
    },
    ...overrides,
  };
}

/**
 * Opens the renderer with `initial` as main's reply to its first snapshot request. The bridge records history requests
 * and holds them open. With `holdFirstSnapshot`, that first reply also waits until the test answers it.
 */
async function open(initial: AppSnapshot, holdFirstSnapshot = false): Promise<void> {
  await page?.close();
  page = await browser.newPage();
  await page.addInitScript(({ first, hold }) => {
    const listeners: Array<(value: AppSnapshot) => void> = [];
    const pending: Array<{ permitId: string; resolve: (value: BridgeResult<PermitHistory>) => void }> = [];
    let answerFirst: () => void = () => undefined;
    const firstReply = new Promise<AppSnapshot>((resolve) => { answerFirst = () => resolve(first); });

    if (!hold) answerFirst();
    const ok = async () => ({ ok: true, value: null });

    const control: TestBridge = {
      historyCalls: [],
      push: (next) => { for (const listener of listeners) listener(next); },
      answerSnapshot: () => answerFirst(),
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
        snapshot: () => firstReply,
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
  }, { first: initial, hold: holdFirstSnapshot });
  await page.goto(pathToFileURL(path.join(directory, "index.html")).href);

  if (!holdFirstSnapshot) await page.locator("#permit-table tbody tr").first().waitFor({ state: "attached" });
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

describe("update controls", () => {
  it("keeps Check for updates unavailable while a download is running", async () => {
    await page.evaluate(() => {
      Object.assign(window.permitMonitor, {
        checkForUpdate: async () => ({ ok: true, value: { state: "available", version: "1.1.0", size: 5_000_000 } }),
        downloadUpdate: () => new Promise((resolve) => {
          document.addEventListener("test-download-finished", () => resolve({ ok: true, value: "1.1.0" }), { once: true });
        }),
      });
    });
    await page.locator("#open-settings").click();
    await page.locator("#check-update").click();
    await page.locator("#download-update").click();
    expect(await page.locator("#check-update").isDisabled()).toBe(true);

    await page.evaluate(() => document.dispatchEvent(new Event("test-download-finished")));
    await expect.poll(() => page.locator("#update-status").innerText()).toBe("Version 1.1.0 is ready to install.");
    expect(await page.locator("#check-update").isDisabled()).toBe(false);
  });
});

describe("snapshot order", () => {
  it("keeps a newer pushed snapshot when an older direct reply arrives after it", async () => {
    const older = snapshot([permit(1, { lastStatus: "Older" })]);
    await open(older, true);
    const status = page.locator("#permit-table tbody tr td:nth-child(2)");

    await push(snapshot([permit(1, { lastStatus: "Newer" })]));
    await expect.poll(() => status.innerText()).toContain("Newer");

    await page.evaluate(() => window.testBridge.answerSnapshot());
    // Give the late reply its chance to render before checking that it didn't.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(await status.innerText()).toContain("Newer");

    await push(older);
    expect(await status.innerText()).toContain("Newer");
  });
});

describe("key banner", () => {
  it("stays up after the key is turned down, even with failure notices off, and leads to Settings", async () => {
    await open(snapshot([permit(1)], { monitoring: "scheduled", keyState: "rejected",
      preferences: { notifyStatusChanges: true, notifyFailures: false, runInBackground: false,
        openAtLogin: false, backgroundAvailable: false, openAtLoginAvailable: false } }));

    const banner = page.locator("#key-banner");
    expect(await banner.isVisible()).toBe(true);
    expect(await page.locator("#key-banner-title").innerText()).toBe("TypeSafe turned down your key. Scheduled checks are paused.");
    expect(await page.locator("#next-check").textContent()).toBe("Scheduled checks paused");

    await page.locator("#banner-add-key").click();
    expect(await page.locator("#settings-sheet").isVisible()).toBe(true);
    expect(await page.locator("#key-input").evaluate((node) => node === document.activeElement)).toBe(true);
    expect(await page.locator("#settings-key-state").innerText()).toContain("Paste a working key");
    expect(await page.locator("#key-remove").isVisible()).toBe(true);

    // Saving a key that works brings a snapshot without the pause.
    await push(snapshot([permit(1)], { monitoring: "scheduled" }));
    expect(await banner.isVisible()).toBe(false);
    expect(await page.locator("#settings-key-state").isVisible()).toBe(false);
    expect(await page.locator("#next-check").textContent()).not.toBe("Scheduled checks paused");
  });

  it("asks for the key again when the saved one can't be read", async () => {
    await open(snapshot([permit(1)], { keyState: "unreadable" }));

    expect(await page.locator("#key-banner").isVisible()).toBe(true);
    expect(await page.locator("#key-banner-title").innerText()).toBe("Your saved TypeSafe key can't be read. Checks are paused.");
    expect(await page.locator("#banner-add-key").textContent()).toBe("Save key again");
  });
});
