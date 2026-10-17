import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppEvent, BridgeResult } from "../src/shared/bridge.js";
import type { AppSnapshot, PermitHistory, PermitRow } from "../src/shared/permit.js";
import { defined } from "./support/defined.js";

/** What the test drives in the page: snapshots from "main", and the requests the renderer made. */
interface TestBridge {
  historyCalls: string[];
  /** Each schedule the renderer asked main to save, in order. */
  checkTimeCalls: string[][];
  /** Each setting the renderer asked main to change, in order. */
  preferenceCalls: Array<[string, boolean]>;
  /** Reasons of promise rejections nothing in the page handled. */
  unhandled: string[];
  push(next: AppSnapshot): void;
  /** Delivers a foreground notice from main. */
  appEvent(event: AppEvent): void;
  /** Delivers the permit selected from a native notification. */
  openDetails(permitId: string): void;
  /** Answers the renderer's first direct snapshot request, when the page was opened with it held. */
  answerSnapshot(): void;
  /** Answers the index-th history request with one observation showing `status`. */
  answerHistory(index: number, status: string, nextBefore?: string, startedAt?: string): void;
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

let server: Server;

let rendererUrl: string;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "permit-monitor-renderer-"));
  await build({
    entryPoints: { renderer: "src/renderer/index.ts" },
    outdir: directory,
    bundle: true,
    target: "es2022",
    platform: "browser",
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    logLevel: "silent",
  });
  copyFileSync("src/renderer/index.html", path.join(directory, "index.html"));
  copyFileSync("src/renderer/styles.css", path.join(directory, "styles.css"));
  cpSync("assets", path.join(directory, "assets"), { recursive: true });
  // Browsers restrict ES modules opened directly from file://; Electron grants
  // its own local app access. Serve the same files and CSP without weakening it.
  server = createServer((request, response) => {
    const relative = new URL(request.url ?? "/", "http://localhost").pathname.slice(1) || "index.html";
    const file = path.resolve(directory, relative);

    if (!file.startsWith(`${directory}${path.sep}`)) {
      response.writeHead(403).end();

      return;
    }

    void readFile(file).then(
      (body) => {
        response.setHeader(
          "Content-Type",
          relative.endsWith(".js")
            ? "text/javascript"
            : relative.endsWith(".css")
              ? "text/css"
              : relative.endsWith(".woff2")
                ? "font/woff2"
                : relative.endsWith(".svg")
                  ? "image/svg+xml"
                  : "text/html",
        );
        response.end(body);
      },
      () => {
        response.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.int().min(1).max(65535) }).parse(server.address());
  rendererUrl = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();

  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function permit(index: number, overrides: Partial<PermitRow> = {}): PermitRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    jurisdictionId: "hillsborough-county-building",
    permitNumber: `HC-BLD-26-${String(index).padStart(7, "0")}`,
    projectNumber: null,
    reviews: null,
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
function snapshot(
  permits: PermitRow[],
  overrides: Partial<Omit<AppSnapshot, "revision" | "permits">> = {},
): AppSnapshot {
  revision += 1;

  return {
    revision,
    permits,
    keyState: "configured",
    appVersion: "0.0.0",
    platform: "windows",
    monitoring: "manual",
    checkTimes: ["08:30"],
    preferences: {
      notifyStatusChanges: true,
      notifyFailures: true,
      runInBackground: false,
      openAtLogin: false,
      desktopShortcut: false,
      backgroundAvailable: false,
      installedApp: false,
      offerDesktopShortcut: false,
    },
    share: { mode: "off", available: true },
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
  await page.addInitScript(
    ({ first, hold }) => {
      const listeners: Array<(value: AppSnapshot) => void> = [];
      const appEvents: Array<(value: AppEvent) => void> = [];
      const openDetails: Array<(value: string) => void> = [];

      const pending: Array<{
        permitId: string;
        resolve: (value: BridgeResult<PermitHistory>) => void;
        reject: (cause: Error) => void;
      }> = [];

      const failures = new Map<string, string>();

      const answer = (method: string) => async (): Promise<BridgeResult<null>> => {
        const error = failures.get(method);

        return error === undefined ? { ok: true, value: null } : { ok: false, error };
      };

      let answerFirst: () => void = () => undefined;

      const firstReply = new Promise<AppSnapshot>((resolve) => {
        answerFirst = () => resolve(first);
      });

      if (!hold) answerFirst();

      const control: TestBridge = {
        historyCalls: [],
        checkTimeCalls: [],
        preferenceCalls: [],
        unhandled: [],
        push: (next) => {
          for (const listener of listeners) listener(next);
        },
        appEvent: (event) => {
          for (const listener of appEvents) listener(event);
        },
        openDetails: (permitId) => {
          for (const listener of openDetails) listener(permitId);
        },
        answerSnapshot: () => answerFirst(),
        failHistory: (index, error) => {
          pending[index]?.resolve({ ok: false, error });
        },
        rejectHistory: (index) => {
          pending[index]?.reject(new Error("IPC channel closed"));
        },
        fail: (method, error) => {
          failures.set(method, error);
        },
        answerHistory: (index: number, status: string, nextBefore?: string, startedAt = "2026-09-24T12:00:00.000Z") => {
          const request = pending[index];

          request?.resolve({
            ok: true,
            value: {
              nextBefore: nextBefore ?? null,
              runs: [
                {
                  id: `r${index}`,
                  permitId: request.permitId,
                  startedAt,
                  finishedAt: "2026-09-24T12:01:00.000Z",
                  outcome: "success",
                  actionCount: 0,
                  requestCount: 0,
                },
              ],
              observations: [
                {
                  id: `o${index}`,
                  runId: `r${index}`,
                  permitId: request.permitId,
                  verifiedPermitNumber: "x",
                  statusLabel: "Record Status:",
                  statusValue: status,
                  reviews: null,
                  observedAt: "2026-09-24T12:00:00.000Z",
                  recordUrl: "https://example.test",
                },
              ],
            },
          });
        },
      };

      window.addEventListener("unhandledrejection", (event) => {
        control.unhandled.push(String(event.reason));
      });

      const methods = [
        "addAndCheck",
        "checkNow",
        "cancel",
        "openPortal",
        "recordManualStatus",
        "saveKey",
        "removeKey",
        "openRecord",
        "openObservationRecord",
        "removePermit",
        "setMonitoring",
        "setPermitMonitoring",
        "setProjectNumber",
        "setPreference",
        "checkForUpdate",
        "downloadUpdate",
        "installUpdate",
        "openUpdateDownload",
        "deleteLocalData",
        "startSharing",
        "stopSharing",
        "copyShareCode",
        "follow",
        "stopFollowing",
        "syncShared",
      ];

      Object.assign(window, {
        testBridge: control,
        permitMonitor: {
          ...Object.fromEntries(methods.map((method) => [method, answer(method)])),
          snapshot: () => firstReply,
          history: (permitId: string) => {
            control.historyCalls.push(permitId);

            return new Promise((resolve, reject) => pending.push({ permitId, resolve, reject }));
          },
          setCheckTimes: async (times: string[]) => {
            control.checkTimeCalls.push(times);

            return answer("setCheckTimes")();
          },
          setPreference: async (key: string, value: boolean) => {
            control.preferenceCalls.push([key, value]);

            return answer("setPreference")();
          },
          onSnapshot: (callback: (value: AppSnapshot) => void) => {
            listeners.push(callback);

            return () => undefined;
          },
          onLocalError: () => () => undefined,
          onOpenDetails: (callback: (value: string) => void) => {
            openDetails.push(callback);

            return () => undefined;
          },
          onAppEvent: (callback: (value: AppEvent) => void) => {
            appEvents.push(callback);

            return () => undefined;
          },
        },
      });
    },
    { first: initial, hold: holdFirstSnapshot },
  );
  await page.goto(rendererUrl);

  if (!holdFirstSnapshot) await page.locator("#permit-table tbody tr").first().waitFor({ state: "attached" });
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
    const tenth = defined(fifty[9], "a tenth permit");
    const twentieth = defined(fifty[19], "a twentieth permit");
    const focused = page.locator(`button[data-action="check"][data-permit-id="${tenth.id}"]`);
    await focused.focus();
    await page.evaluate(() => {
      window.keptRows = new Set(document.querySelectorAll("#permit-table tbody tr"));
    });

    await push(snapshot(fifty.map((entry, index) => (index === 19 ? { ...entry, checking: true } : entry))));

    expect(await focused.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("#permit-table tbody tr")].every((row) => window.keptRows.has(row)),
      ),
    ).toBe(true);
    await expect
      .poll(() => page.locator(`button[data-permit-id="${twentieth.id}"][data-action="cancel"]`).count())
      .toBe(1);
  });

  it("groups by project and moves rows between groups as numbers change", async () => {
    await push(snapshot(fifty.map((entry, index) => (index < 3 ? { ...entry, projectNumber: "28069" } : entry))));

    const heads = await page
      .locator("#permit-table tr.group-row .group-head")
      .evaluateAll((nodes) => nodes.map((node) => [...node.children].map((part) => part.textContent).join(" ")));

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

    expect(
      await page.locator(`#permit-table tr:has(button[data-permit-id="${returning.id}"])`).getAttribute("class"),
    ).toBe("row-enter");
  });
});

describe("check time editing", () => {
  const schedule = { ...snapshot(fifty), monitoring: "scheduled" as const, checkTimes: ["08:30", "12:30", "16:30"] };

  const times = () =>
    page
      .locator("#check-time-list input")
      .evaluateAll((nodes) => nodes.map((node) => (node instanceof HTMLInputElement ? node.value : null)));

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

describe("notification surfaces", () => {
  it("shows a review alert above an open settings dialog", async () => {
    await page.locator("#open-settings").click();
    await page.evaluate(() =>
      window.testBridge.appEvent({
        tone: "info",
        title: "HC-SITECON-26-0000004",
        body: "Natural Resources Review: Corrections Required · Action: AEC",
      }),
    );
    expect(await page.locator("#notice").innerText()).toContain("Corrections Required · Action: AEC");
    expect(await noticeOnTop()).toBe(true);
  });

  it("opens the notification's permit and closes an unrelated dialog", async () => {
    const target = defined(fifty[9], "tenth permit");
    await page.locator("#open-settings").click();
    await page.evaluate((id) => window.testBridge.openDetails(id), target.id);
    expect(await page.locator("#settings-sheet").isVisible()).toBe(false);
    expect(await page.locator("#details-sheet").isVisible()).toBe(true);
    expect(await page.locator("#details-title").innerText()).toBe(target.permitNumber);
    expect(await historyCalls()).toEqual([target.id]);
  });
});

describe("AEC filter", () => {
  it("shows review-driven AEC action and the latest discipline statuses while preserving the portal's In Process wording", async () => {
    const reviews = [
      {
        process: "Natural Resources Review",
        status: "Corrections Required",
        date: "2026-09-24",
        dueDate: "2026-09-22",
      },
      { process: "Stormwater Review", status: "Corrections Required", date: "2026-07-16", dueDate: "2026-07-14" },
      { process: "Stormwater Review", status: null, date: null, dueDate: "2026-09-22" },
    ];

    await open(snapshot([permit(1, { reviews }), permit(2)]));
    await page.selectOption("#permit-filter", "applicant");
    expect(await page.locator("#permit-table tbody tr").count()).toBe(1);
    const row = page.locator("#permit-table tbody tr");
    expect(await row.locator(".status-value").innerText()).toBe("In Process");
    expect(await row.locator(".action").innerText()).toBe("AEC");
    expect(await row.locator(".action").getAttribute("data-tentative")).toBeNull();
    expect(await row.locator(".action").getAttribute("title")).toContain("2026-09-24");
    expect(await row.innerText()).toContain("Review response required");
    await row.locator('button[data-action="details"]').click();
    expect(await page.locator("#details-status").innerText()).toBe("In Process");
    expect(await page.locator("#details-action").innerText()).toContain("AEC");
    expect(await page.locator("#details-reviews").isVisible()).toBe(true);
    expect(await page.locator("#details-review-list li").count()).toBe(2);
    expect(await page.locator("#details-review-list li").nth(0).innerText()).toContain("AEC response required");
    expect(await page.locator("#details-review-list li").nth(1).innerText()).toContain("Pending");
    expect(await page.locator("#details-review-list li").nth(1).innerText()).not.toContain("Corrections Required");

    await push(
      snapshot([
        permit(1, {
          reviews: [{ ...defined(reviews[0], "Natural Resources"), status: "Approved", date: "2026-09-28" }],
        }),
        permit(2),
      ]),
    );
    expect(await page.locator("#details-action").innerText()).toContain("AHJ");
    expect(await page.locator("#empty-state").innerText()).toBe("No matches.");
  });

  it("includes cautious AEC? badges, leaves unclassified permits out, and never reads as an all-clear", async () => {
    await open(
      snapshot([
        permit(1, { lastStatus: "Awaiting Client Reply" }),
        permit(2, { lastStatus: "Expired" }),
        permit(3, { lastStatus: "Issued" }),
        permit(4, { jurisdictionId: "swfwmd-erp", permitNumber: "43047590.008", lastStatus: "Issued" }),
      ]),
    );
    const actionCells = page.locator("#permit-table tbody tr td:nth-child(3)");
    expect(await actionCells.allInnerTexts()).toEqual(["AEC", "AEC?", "None", "—"]);

    await page.selectOption("#permit-filter", "applicant");
    expect(await page.locator("#permit-table tbody tr").count()).toBe(2);

    await push(
      snapshot([
        permit(3, { lastStatus: "Issued" }),
        permit(4, { jurisdictionId: "swfwmd-erp", permitNumber: "43047590.008", lastStatus: "Issued" }),
      ]),
    );
    expect(await page.locator("#empty-state").innerText()).toBe("No matches.");
  });
});

describe("details history", () => {
  it("appends older daily pages, retains loaded entries after a failed page, and drops stale replies", async () => {
    const first = defined(fifty[0], "first permit");
    const second = defined(fifty[1], "second permit");
    await page.locator(`button[data-action="details"][data-permit-id="${first.id}"]`).click();
    await page.evaluate(() => window.testBridge.answerHistory(0, "Newest", "2026-09-24T00:00:00.000Z"));
    const more = page.locator("button[data-history-more]");
    await more.click();
    await page.evaluate(() => window.testBridge.failHistory(1, "Temporary local failure"));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Newest");
    await expect.poll(() => more.isEnabled()).toBe(true);
    await more.click();
    await page.evaluate(() =>
      window.testBridge.answerHistory(2, "Previous day", "2026-09-23T00:00:00.000Z", "2026-09-23T12:00:00.000Z"),
    );
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Previous day");
    expect(await page.locator("#history-list").innerText()).toContain("Newest");
    await more.click();
    await page.locator("#details-sheet [data-close]").click();
    await page.locator(`button[data-action="details"][data-permit-id="${second.id}"]`).click();
    await page.evaluate(() => {
      window.testBridge.answerHistory(4, "Second permit");
      window.testBridge.answerHistory(3, "Stale older day", undefined, "2026-09-22T12:00:00.000Z");
    });
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Second permit");
    expect(await page.locator("#history-list").innerText()).not.toContain("Stale older day");
    expect(await more.count()).toBe(0);
  });

  it("requests history once while snapshots about other permits arrive, then again when this permit changes", async () => {
    const first = defined(fifty[0], "a first permit");
    await page.locator(`button[data-action="details"][data-permit-id="${first.id}"]`).click();
    expect(await historyCalls()).toEqual([first.id]);

    await push(snapshot(fifty.map((entry, index) => (index === 5 ? { ...entry, checking: true } : entry))));
    await push(snapshot(fifty.map((entry, index) => (index === 6 ? { ...entry, checking: true } : entry))));
    expect(await historyCalls()).toEqual([first.id]);

    await push(
      snapshot(
        fifty.map((entry, index) => (index === 0 ? { ...entry, latestAttemptAt: "2026-09-25T12:00:00.000Z" } : entry)),
      ),
    );
    expect(await historyCalls()).toEqual([first.id, first.id]);

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
    await push(snapshot(fifty.map((entry, index) => (index === 5 ? { ...entry, checking: true } : entry))));
    expect(await historyCalls()).toEqual([shown.id]);

    await retry.click();
    expect(await historyCalls()).toEqual([shown.id, shown.id]);
    await page.evaluate(() => window.testBridge.answerHistory(1, "Issued"));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Issued");

    await push(
      snapshot(
        fifty.map((entry, index) => (index === 0 ? { ...entry, latestAttemptAt: "2026-09-25T12:00:00.000Z" } : entry)),
      ),
    );
    await page.evaluate(() => window.testBridge.failHistory(2, "Permit not found."));
    await expect.poll(() => page.locator("#history-list").innerText()).toContain("Permit not found.");
    expect(await retry.count()).toBe(1);
  });
});

describe("update controls", () => {
  it("keeps Check for updates unavailable while a download is running", async () => {
    await page.evaluate(() => {
      Object.assign(window.permitMonitor, {
        checkForUpdate: async () => ({ ok: true, value: { state: "available", version: "1.1.0", size: 5_000_000 } }),
        downloadUpdate: () =>
          new Promise((resolve) => {
            document.addEventListener("test-download-finished", () => resolve({ ok: true, value: "1.1.0" }), {
              once: true,
            });
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

  it("sends a Mac copy to the download page instead of installing", async () => {
    await open(snapshot([permit(1)], { platform: "mac" }));
    await page.evaluate(() => {
      Object.assign(window.permitMonitor, {
        checkForUpdate: async () => ({ ok: true, value: { state: "available", version: "1.1.0", size: 5_000_000 } }),
        downloadUpdate: async () => {
          throw new Error("downloadUpdate called on a Mac");
        },
        openUpdateDownload: async () => {
          document.body.dataset.downloadOpened = "yes";

          return { ok: true, value: null };
        },
      });
    });
    await page.locator("#open-settings").click();
    expect(await page.locator("#tray-place").innerText()).toBe("menu bar");
    expect(await page.locator("input[data-pref='openAtLogin']").isVisible()).toBe(false);
    expect(await page.locator("input[data-pref='desktopShortcut']").isVisible()).toBe(false);

    await page.locator("#check-update").click();
    await expect.poll(() => page.locator("#update-status").innerText()).toContain("replace the copy in Applications");
    await page.locator("#download-update").click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.downloadOpened)).toBe("yes");
    expect(await page.locator("#install-update").isVisible()).toBe(false);
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

describe("desktop shortcut", () => {
  const firstRun = {
    notifyStatusChanges: true,
    notifyFailures: true,
    runInBackground: false,
    openAtLogin: false,
    desktopShortcut: false,
    backgroundAvailable: true,
    installedApp: true,
    offerDesktopShortcut: true,
  };

  it("asks once on the first launch after installing and saves a no as the setting", async () => {
    await open(snapshot([permit(1)], { preferences: firstRun }));

    expect(await page.locator("#confirm-dialog").isVisible()).toBe(true);
    expect(await page.locator("#confirm-title").innerText()).toBe("Add a desktop shortcut?");
    await page.locator("#confirm-cancel").click();
    expect(await page.evaluate(() => window.testBridge.preferenceCalls)).toEqual([["desktopShortcut", false]]);

    // A snapshot main sent before it heard the answer doesn't ask again.
    await push(snapshot([permit(1)], { preferences: firstRun }));
    expect(await page.locator("#confirm-dialog").isVisible()).toBe(false);
    expect(await page.locator("#confirm-cancel").textContent()).toBe("Not now");
  });

  it("adds the shortcut when accepted, and later confirmations keep their usual wording", async () => {
    await open(snapshot([permit(1)], { preferences: firstRun }));

    await page.locator("#confirm-accept").click();
    expect(await page.evaluate(() => window.testBridge.preferenceCalls)).toEqual([["desktopShortcut", true]]);

    await page.locator("#open-settings").click();
    await page.locator("#delete-local-data").click();
    expect(await page.locator("#confirm-cancel").textContent()).toBe("Cancel");
  });

  it("is a Settings choice only in the installed app", async () => {
    const toggle = page.locator("input[data-pref='desktopShortcut']");

    expect(await toggle.isDisabled()).toBe(true);

    await push(snapshot(fifty, { preferences: { ...firstRun, desktopShortcut: true, offerDesktopShortcut: false } }));
    expect(await toggle.isDisabled()).toBe(false);
    expect(await toggle.isChecked()).toBe(true);
  });
});

describe("key banner", () => {
  it("stays up after the key is turned down, even with failure notices off, and leads to Settings", async () => {
    await open(
      snapshot([permit(1)], {
        monitoring: "scheduled",
        keyState: "rejected",
        preferences: {
          notifyStatusChanges: true,
          notifyFailures: false,
          runInBackground: false,
          openAtLogin: false,
          desktopShortcut: false,
          backgroundAvailable: false,
          installedApp: false,
          offerDesktopShortcut: false,
        },
      }),
    );

    const banner = page.locator("#key-banner");
    expect(await banner.isVisible()).toBe(true);
    expect(await page.locator("#key-banner-title").innerText()).toBe(
      "TypeSafe turned down your key. Scheduled checks are paused.",
    );
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
    expect(await page.locator("#key-banner-title").innerText()).toBe(
      "Your saved TypeSafe key can't be read. Checks are paused.",
    );
    expect(await page.locator("#banner-add-key").textContent()).toBe("Save key again");
  });
});

describe("shared lists", () => {
  it("shows a followed list read-only, without this app's key or schedule prompts", async () => {
    await open(
      snapshot([permit(1)], {
        keyState: "missing",
        monitoring: "scheduled",
        share: {
          mode: "following",
          publishedAt: "2026-09-24T12:00:00.000Z",
          checkedAt: "2026-09-24T12:05:00.000Z",
          problem: null,
        },
      }),
    );

    expect(await page.locator("#next-check").textContent()).toMatch(/^Shared list · updated Sep 24,/);
    expect(await page.locator("#share-sync").isVisible()).toBe(true);
    expect(await page.locator("#key-banner").isVisible()).toBe(false);
    expect(await page.locator("#add-button").isVisible()).toBe(false);
    expect(await page.locator("#permit-number").isVisible()).toBe(false);
    expect(await page.locator("#permit-filter").isVisible()).toBe(true);
    expect(await page.locator('#permit-table button[data-action="check"]').first().isVisible()).toBe(false);
    expect(await page.locator('#permit-table button[data-action="open"]').first().isVisible()).toBe(true);

    await page.locator('#permit-table button[data-action="details"]').first().click();
    expect(await page.locator("#details-check").isVisible()).toBe(false);
    expect(await page.locator("#details-remove").isVisible()).toBe(false);
    expect(await page.locator("#details-daily-option").isVisible()).toBe(false);
    expect(
      await page.locator("#details-project").evaluate((node) => node instanceof HTMLInputElement && node.readOnly),
    ).toBe(true);
    await page.keyboard.press("Escape");

    await page.locator("#open-settings").click();
    expect(await page.locator("#follow-on").isVisible()).toBe(true);
    expect(await page.locator("#share-off").isVisible()).toBe(false);

    // A failed fetch keeps the list and says the copy may be old.
    await push(
      snapshot([permit(1)], {
        share: {
          mode: "following",
          publishedAt: "2026-09-24T12:00:00.000Z",
          checkedAt: null,
          problem: "Couldn't reach the sharing service. Retrying.",
        },
      }),
    );
    expect(await page.locator("#next-check").textContent()).toBe("Shared list · couldn't update");
    expect(await page.locator("#share-status").textContent()).toBe("Couldn't reach the sharing service. Retrying.");

    // Leaving follow mode brings the controls back.
    await push(snapshot([permit(1)]));
    expect(await page.locator("#share-off").isVisible()).toBe(true);
    expect(await page.locator("#share-sync").isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    expect(await page.locator("#add-button").isVisible()).toBe(true);
    expect(await page.locator('#permit-table button[data-action="check"]').first().isVisible()).toBe(true);
  });

  it("shows the code while sharing and hides sharing in a build without a service", async () => {
    await open(
      snapshot([permit(1)], { share: { mode: "sharing", code: "PMS1-example", publishedAt: null, problem: null } }),
    );
    await page.locator("#open-settings").click();

    expect(await page.locator("#share-code").inputValue()).toBe("PMS1-example");
    expect(await page.locator("#share-status").textContent()).toBe(
      "Anyone with this code can view this list. It's sent after each round of checks.",
    );
    await page.keyboard.press("Escape");
    expect(await page.locator("#share-sync").isVisible()).toBe(true);
    await page.locator("#share-sync").click();
    expect(await page.locator("#notice-text").textContent()).toBe("Shared list sent.");
    await page.locator("#open-settings").click();
    expect(await page.locator("#share-off").isVisible()).toBe(false);

    await push(snapshot([permit(1)], { share: { mode: "off", available: false } }));
    expect(await page.locator("#share-status").textContent()).toBe("Sharing isn't available in this build.");
    expect(await page.locator("#share-off").isVisible()).toBe(false);
    expect(await page.locator("#share-on").isVisible()).toBe(false);
  });

  it("asks before a followed list replaces this app's own permits", async () => {
    await page.locator("#open-settings").click();
    await page.locator("#follow-input").fill("PMS1-code");
    await page.locator("#follow-save").click();

    expect(await page.locator("#confirm-body").textContent()).toBe(
      "Your own 50 permits stay on this computer but aren't shown or checked until you stop following.",
    );
    await page.locator('#confirm-dialog button[value="cancel"]').click();
    expect(await page.locator("#follow-input").inputValue()).toBe("PMS1-code");
  });
});

describe("workspace accessibility", () => {
  it("expands a shared workspace with the window while keeping dates and row actions readable", async () => {
    const project = "24082_914_E_128th_Ave-Recycling_Facility";
    await open(
      snapshot([permit(1, { projectNumber: project }), permit(2, { projectNumber: project })], {
        share: { mode: "following", publishedAt: "2026-09-24T12:00:00.000Z", checkedAt: null, problem: null },
      }),
    );
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => document.fonts.ready);
    const dock = defined(await page.locator(".nav-inner").boundingBox(), "the command dock");
    const list = defined(await page.locator(".table-card").boundingBox(), "the permit list");
    const filter = defined(await page.locator(".add-card").boundingBox(), "the shared filter");
    expect(list.x).toBe(dock.x);
    expect(list.width).toBe(dock.width);
    expect(list.width).toBeGreaterThan(1800);
    expect(filter.height).toBeLessThan(64);
    expect(await page.locator(".group-number").textContent()).toBe(project);

    const dates = await page.locator("#permit-table td:nth-child(4) time").evaluateAll((nodes) =>
      nodes.map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);

        return range.getClientRects().length;
      }),
    );

    expect(dates).toEqual([1, 1]);
    await page.setViewportSize({ width: 2560, height: 1440 });
    const expanded = defined(await page.locator(".table-card").boundingBox(), "the expanded permit list");
    expect(expanded.width - list.width).toBeGreaterThan(600);
    await page.setViewportSize({ width: 820, height: 560 });
    const record = page.locator('#permit-table button[data-action="open"]').last();
    await record.focus();
    const action = defined(await record.boundingBox(), "the focused record link");
    expect(action.x).toBeGreaterThanOrEqual(0);
    expect(action.x + action.width).toBeLessThanOrEqual(820);
    expect(action.y + action.height).toBeLessThanOrEqual(560);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(820);
  });

  it("keeps row actions reachable by keyboard in a narrow window without scrolling the whole app", async () => {
    await page.setViewportSize({ width: 820, height: 560 });
    const region = page.getByRole("region", { name: "Scrollable permit list" });
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => (document.querySelector(".table-scroll")?.scrollLeft ?? 0) > 0);
    const last = page.locator("#permit-table tbody tr").last().getByRole("button", { name: "Check now" });
    await last.focus();
    const box = await last.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(820);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(560);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(820);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.testBridge.unhandled)).toEqual([]);
  });

  it("turns off decorative effects when reduced motion changes while keeping permit controls usable", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () => document.querySelector("#warm-background")?.getAttribute("data-fallback") === "reduced-effects",
    );
    expect(await page.locator("#warm-background").isVisible()).toBe(false);
    await page.locator("#open-settings").click();
    expect(await page.locator("#settings-sheet").isVisible()).toBe(true);
    expect(await page.evaluate(() => window.testBridge.unhandled)).toEqual([]);
  });
});
