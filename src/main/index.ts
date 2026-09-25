import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, shell, session } from "electron";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { KeyStore } from "./key-store.js";
import { keyProblem } from "../shared/key-format.js";
import { PermitStore } from "./store.js";
import { runCheck, type ActiveCheck } from "./check-runner.js";
import { runPackagedBrowserSmoke } from "./packaged-smoke.js";
import { UpdateManager } from "./updater.js";
import { verifyBrowserPayload } from "./browser-integrity.js";
import { APP_USER_MODEL_ID, Background, getOpenAtLogin, HIDDEN_LAUNCH_ARG, openAtLoginAvailable, setOpenAtLogin } from "./background.js";
import { describeCheckEvent, type CheckEvent } from "./notifications.js";
import { isFailure } from "../shared/outcomes.js";
import { describeCheckTimes, formatCheckTime, MAX_CHECK_TIMES, normalizeCheckTimes, withinCheckWindow } from "../shared/schedule.js";
import { addPermitSchema, manualStatusSchema, setProjectNumberSchema, parseApplicationNumber, parsePortalUrl, permitIdSchema, resolveJurisdiction, type AppSnapshot } from "../shared/permit.js";
import { getAutomatedJurisdiction, getJurisdiction, isManualJurisdiction } from "../shared/jurisdictions.js";
import type { BridgeResult } from "../shared/bridge.js";

// The Squirrel ID only matches a Start menu shortcut once installed. Unpackaged runs keep
// Electron's default so development builds can still show toasts.
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);
if (process.argv.includes("--squirrel-uninstall")) {
  try { setOpenAtLogin(false); } catch { /* the uninstaller continues regardless */ }
}
const squirrelStartup = require("electron-squirrel-startup") as boolean;
if (squirrelStartup || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(startApp).catch(failStartup);
}

let startupFailed = false;

/** Both startup and the deferred browser check can fail; the user sees one dialog. */
function failStartup(): void {
  if (startupFailed) return;
  startupFailed = true;
  if (!process.argv.includes("--smoke-browser")) {
    dialog.showErrorBox("Permit Monitor could not start", "The local application or bundled browser could not be verified. Reinstall the app from a trusted release.");
  }
  app.exit(1);
}

let mainWindow: BrowserWindow | null = null;
let store: PermitStore;
let keys: KeyStore;
let updates: UpdateManager;
let active: { permitId: string; check: ActiveCheck } | null = null;
let pendingPermitId: string | null = null;
let pendingCancelled = false;
let processing: Promise<void> | null = null;
const queue: string[] = [];
let lastJurisdictionCheckEndedAt = 0;
let shuttingDown = false;
let quitAllowed = false;
let quitting = false;
let background: Background | null = null;
let keyNoticeShown = false;
let broadcastPending: Promise<void> | null = null;
/** Resolves true once the bundled browser matches its manifest. No check launches it before then. */
let browserVerified: Promise<boolean> = Promise.resolve(true);

const PREF_FLAGS = {
  notifyStatusChanges: "notify_status_changes",
  notifyFailures: "notify_failures",
  runInBackground: "run_in_background",
} as const;
const BACKGROUND_HINT_SHOWN = "background_hint_shown";

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openPermitInWindow(permitId: string): void {
  showWindow();
  mainWindow?.webContents.send("permit:open-details", permitId);
}

function keepsRunningInBackground(): boolean {
  return Boolean(background?.available) && store.getFlag(PREF_FLAGS.runInBackground, true);
}

/** Desktop notification when the window is out of view; an in-app notice when the user is already looking. */
function announce(event: CheckEvent): void {
  const wanted = event.kind === "first-status" || event.kind === "status-changed"
    ? store.getFlag(PREF_FLAGS.notifyStatusChanges, true)
    : store.getFlag(PREF_FLAGS.notifyFailures, true);
  if (!wanted) return;
  if (event.kind === "key-needed") {
    if (keyNoticeShown) return;
    keyNoticeShown = true;
  }
  const windowInFront = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused());
  // Desktop toasts are a Windows feature here; on other development platforms (for example WSL,
  // where no notification service may answer) the message stays inside the app window.
  if (windowInFront || process.platform !== "win32") {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const tone = event.kind === "check-failed" || event.kind === "key-needed" ? "error" : "info";
    mainWindow.webContents.send("permit:app-event", { tone, title: event.title, body: event.body, permitId: event.permitId });
    return;
  }
  background?.notify(event);
}

/** Records the result and, when it changes what the user knows, tells them. */
function finishAndAnnounce(input: Parameters<PermitStore["finishRun"]>[0]): void {
  const before = store.getPermit(input.permitId);
  store.finishRun(input);
  const after = store.getPermit(input.permitId);
  if (before && after) {
    const event = describeCheckEvent(before, after, input.outcome);
    // A notification problem must never stop the result from reaching the window.
    if (event) try { announce(event); } catch { /* the saved result and window update still proceed */ }
  }
}

function dataRoot(): string {
  const local = process.platform === "win32" ? process.env.LOCALAPPDATA : null;
  return path.join(local || app.getPath("userData"), "PermitMonitorData");
}

async function snapshot(): Promise<AppSnapshot> {
  const checking = new Set(queue);
  if (active) checking.add(active.permitId);
  if (pendingPermitId) checking.add(pendingPermitId);
  const browserVersion = store.latestBrowserVersion();
  return {
    permits: store.listPermits(checking),
    keyState: await keys.state().catch(() => "unavailable"),
    appVersion: app.getVersion(),
    browserVersion: browserVersion ? `Playwright 1.63.0 · Chromium ${browserVersion}` : "Playwright 1.63.0 · bundled Chromium",
    monitoring: store.getMonitoring(),
    checkTimes: store.getCheckTimes().map(formatCheckTime),
    preferences: {
      notifyStatusChanges: store.getFlag(PREF_FLAGS.notifyStatusChanges, true),
      notifyFailures: store.getFlag(PREF_FLAGS.notifyFailures, true),
      runInBackground: keepsRunningInBackground(),
      openAtLogin: getOpenAtLogin(),
      backgroundAvailable: Boolean(background?.available),
      openAtLoginAvailable: openAtLoginAvailable(),
    },
  };
}

/**
 * Sends the current state to the window and tray. Calls made in the same turn (for example, every
 * permit queued by one scheduled run) share a single snapshot taken just after that turn.
 */
function broadcast(): Promise<void> {
  broadcastPending ??= new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    broadcastPending = null;
    return sendSnapshot();
  });
  return broadcastPending;
}

async function sendSnapshot(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const current = await snapshot();
    background?.update({
      permits: current.permits.length,
      checking: current.permits.filter((permit) => permit.checking).length,
      failing: current.permits.filter((permit) => !permit.checking && isFailure(permit.latestOutcome)).length,
      scheduled: current.monitoring === "scheduled",
      checkTimes: describeCheckTimes(store.getCheckTimes()),
    });
    mainWindow.webContents.send("permit:snapshot-changed", current);
  } catch {
    // The next UI request will surface local storage errors through its reply.
  }
}

function safeSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  return event.senderFrame.url === pathToFileURL(path.join(__dirname, "index.html")).href;
}

function handle<T>(channel: string, callback: (raw: unknown) => Promise<BridgeResult<T>> | BridgeResult<T>): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!safeSender(event)) return { ok: false, error: "Unauthorized request." };
    try {
      return await callback(raw);
    } catch {
      return { ok: false, error: "Something went wrong. Try again." };
    }
  });
}

function scheduleCheck(permitId: string): void {
  if (shuttingDown || active?.permitId === permitId || pendingPermitId === permitId || queue.includes(permitId)) return;
  const permit = store.getPermit(permitId);
  // A permit saved under a jurisdiction the app no longer supports stays visible but is never checked,
  // and a hand-checked permit is never sent to the browser worker.
  if (!permit || !getAutomatedJurisdiction(permit.jurisdictionId)) return;
  queue.push(permitId);
  void broadcast();
  kickQueue();
}

function kickQueue(): void {
  if (processing || shuttingDown || queue.length === 0) return;
  processing = runNext().catch(() => {
    // Persistence failures cannot be represented as a portal status.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("permit:local-error", "Couldn't save locally. Restart the app.");
  }).finally(() => {
    processing = null;
    if (!shuttingDown && queue.length > 0) kickQueue();
  });
}

async function runNext(): Promise<void> {
  if (shuttingDown || queue.length === 0) return;
  const permitId = queue.shift()!;
  pendingPermitId = permitId;
  pendingCancelled = false;
  try {
  const permit = store.getPermit(permitId);
  if (!permit) return;
  const spacing = Math.max(0, 30_000 - (Date.now() - lastJurisdictionCheckEndedAt));
  if (spacing > 0) {
    const until = Date.now() + spacing;
    while (Date.now() < until && !shuttingDown && !pendingCancelled) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
    }
  }
  if (shuttingDown || pendingCancelled) return;
  const key = await keys.read().catch(() => null);
  if (shuttingDown || pendingCancelled) return;
  if (!(await browserVerified) || shuttingDown || pendingCancelled) return;
  const runId = store.startRun({ permitId, appVersion: app.getVersion(), playwrightVersion: "1.63.0" });
  if (!key) {
    finishAndAnnounce({ runId, permitId, outcome: "authentication_error", actionCount: 0,
      requestCount: 0, actualModel: null, browserVersion: null });
    lastJurisdictionCheckEndedAt = Date.now();
    return;
  }
  const browserPath = app.isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers")
    : path.join(app.getAppPath(), "vendor", "playwright-browsers");
  let check: ActiveCheck;
  try {
    check = runCheck({ runId, permit, key, browserPath, cacheRoot: path.join(dataRoot(), "cache"),
      workerPath: path.join(__dirname, "worker.cjs") });
  } catch {
    finishAndAnnounce({ runId, permitId, outcome: "browser_error", actionCount: 0,
      requestCount: 0, actualModel: null, browserVersion: null });
    return;
  }
  active = { permitId, check };
  // The row already shows checking, but an open history now has a started run to show.
  void broadcast();
  const result = await check.result;
  await check.closed;
  try {
    finishAndAnnounce({ runId, permitId, ...result });
  } finally {
    active = null;
  }
  lastJurisdictionCheckEndedAt = Date.now();
  } finally {
    pendingPermitId = null;
    pendingCancelled = false;
    // Every path out of a check, including a saved result, is sent once the permit is no longer pending.
    await broadcast();
  }
}

async function stopChecks(): Promise<boolean> {
  shuttingDown = true;
  queue.length = 0;
  active?.check.cancel();
  if (processing) {
    const completed = await Promise.race([
      processing.then(() => true),
      new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), 10_000); timer.unref(); }),
    ]);
    if (!completed) return false;
  }
  return active === null;
}

function scheduleDue(): void {
  // The interval and resume listener outlive store.close() on the quit, update, and delete paths.
  if (shuttingDown || store.getMonitoring() !== "scheduled") return;
  const now = new Date();
  // Scheduled checks stay inside the check window; anything missed overnight runs at the first morning slot.
  if (!withinCheckWindow(now, store.getCheckTimes())) return;
  for (const id of store.duePermitIds(now.toISOString())) scheduleCheck(id);
}

async function startApp(): Promise<void> {
  const payload = app.isPackaged ? verifyBrowserPayload(path.join(process.resourcesPath, "playwright-browsers")) : Promise.resolve();
  if (process.argv.includes("--smoke-browser")) {
    await payload;
    await runPackagedBrowserSmoke();
    return;
  }
  // Hashing the browser payload takes a while, so the window opens meanwhile. Checks wait for it,
  // and a mismatch still ends the app before the browser is ever launched.
  browserVerified = payload.then(() => true, () => {
    failStartup();
    return false;
  });
  store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
  store.alignSchedule(new Date());
  keys = new KeyStore(dataRoot());
  updates = new UpdateManager(dataRoot(), app.getVersion(),
    app.isPackaged ? path.join(process.resourcesPath, "authenticode.ps1") : path.join(__dirname, "authenticode.ps1"),
    path.join(__dirname, "update-config.json"));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  background = new Background(path.join(__dirname, "assets"), {
    showWindow,
    openPermit: openPermitInWindow,
    checkAll: () => { for (const permit of store.listPermits()) scheduleCheck(permit.id); },
    setScheduled: (enabled) => {
      store.setMonitoring(enabled ? "scheduled" : "manual");
      scheduleDue();
      void broadcast();
    },
    quit: () => app.quit(),
  });
  background.start();
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: "#f1ede4",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.on("close", (event) => {
    if (quitting || !keepsRunningInBackground()) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!store.getFlag(BACKGROUND_HINT_SHOWN, false)) {
      store.setFlag(BACKGROUND_HINT_SHOWN, true);
      background?.notify({ title: "Still running in the tray", body: "Right-click the icon to quit." });
    }
  });

  ipcMain.handle("permit:snapshot", async (event) => {
    if (!safeSender(event)) return null;
    return snapshot();
  });
  handle("permit:add-and-check", (raw) => {
    const parsed = addPermitSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter a permit number." };
    const jurisdictionId = resolveJurisdiction(parsed.data.jurisdiction);
    if (!jurisdictionId) {
      return { ok: false, error: "Choose a supported jurisdiction." };
    }
    const profile = getJurisdiction(jurisdictionId);
    if (profile?.portalFamily === "click2gov" && !parseApplicationNumber(parsed.data.permitNumber)) {
      return { ok: false, error: `Use the ${profile.label} application number as YY-serial, for example 25-05001277.` };
    }
    try {
      const id = store.addPermit(parsed.data.permitNumber, jurisdictionId);
      scheduleCheck(id);
      return { ok: true, value: id };
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { ok: false, error: "That permit is already in the list." };
      }
      throw error;
    }
  });
  handle("permit:check", (raw) => {
    const id = permitIdSchema.safeParse(raw);
    const permit = id.success ? store.getPermit(id.data) : null;
    if (!permit) return { ok: false, error: "Permit not found." };
    if (isManualJurisdiction(permit.jurisdictionId)) return { ok: false, error: "This permit is checked by hand." };
    scheduleCheck(permit.id);
    return { ok: true, value: null };
  });
  handle("permit:open-portal", async (raw) => {
    const id = permitIdSchema.safeParse(raw);
    const permit = id.success ? store.getPermit(id.data) : null;
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;
    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    // The number goes on the clipboard so it can be pasted straight into the portal's search.
    clipboard.writeText(permit.permitNumber);
    await shell.openExternal(profile.startUrl);
    return { ok: true, value: null };
  });
  handle("permit:record-manual-status", async (raw) => {
    const parsed = manualStatusSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter the status shown on the portal." };
    const permit = store.getPermit(parsed.data.permitId);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;
    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    const recordUrl = parsed.data.recordUrl || profile.startUrl;
    if (!parsePortalUrl(recordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: `Use a link from ${profile.label}'s portal, or leave it blank.` };
    }
    store.recordManualStatus({ permitId: permit.id, status: parsed.data.status, recordUrl, appVersion: app.getVersion() });
    await broadcast();
    return { ok: true, value: null };
  });
  handle("permit:cancel", (raw) => {
    const id = permitIdSchema.safeParse(raw);
    if (!id.success) return { ok: false, error: "Permit not found." };
    const queuedAt = queue.indexOf(id.data);
    if (queuedAt >= 0) queue.splice(queuedAt, 1);
    if (pendingPermitId === id.data) pendingCancelled = true;
    if (active?.permitId === id.data) active.check.cancel();
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:history", (raw) => {
    const id = permitIdSchema.safeParse(raw);
    if (!id.success || !store.getPermit(id.data)) return { ok: false, error: "Permit not found." };
    return { ok: true, value: store.history(id.data) };
  });
  handle("permit:save-key", async (raw) => {
    // The key arrives once from the settings field and is encrypted immediately. It is never
    // echoed back to the window, logged, stored in the database, or given to the browser worker.
    if (typeof raw !== "string") return { ok: false, error: "Enter your API key." };
    const key = raw.trim();
    const problem = keyProblem(key);
    if (problem) return { ok: false, error: problem };
    try {
      await keys.save(key);
    } catch {
      return { ok: false, error: "Key storage isn't available, so the key wasn't saved." };
    }
    keyNoticeShown = false;
    await broadcast();
    return { ok: true, value: null };
  });
  handle("permit:remove-key", async () => {
    await keys.remove();
    await broadcast();
    return { ok: true, value: null };
  });
  handle("permit:open-record", async (raw) => {
    const id = permitIdSchema.safeParse(raw);
    const permit = id.success ? store.getPermit(id.data) : null;
    if (!permit?.lastRecordUrl || !parsePortalUrl(permit.lastRecordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: "No record link yet." };
    }
    await shell.openExternal(permit.lastRecordUrl);
    return { ok: true, value: null };
  });
  handle("permit:open-observation-record", async (raw) => {
    const id = permitIdSchema.safeParse(raw);
    const observation = id.success ? store.getObservation(id.data) : null;
    const jurisdictionId = id.success ? store.getObservationJurisdictionId(id.data) : null;
    if (!observation || !jurisdictionId || !parsePortalUrl(observation.recordUrl, "detail", jurisdictionId)) {
      return { ok: false, error: "No record link for this entry." };
    }
    await shell.openExternal(observation.recordUrl);
    return { ok: true, value: null };
  });
  handle("permit:remove", (raw) => {
    const id = permitIdSchema.safeParse(raw);
    if (!id.success || !store.getPermit(id.data)) return { ok: false, error: "Permit not found." };
    const queuedAt = queue.indexOf(id.data);
    if (queuedAt >= 0) queue.splice(queuedAt, 1);
    if (active?.permitId === id.data || pendingPermitId === id.data) {
      return { ok: false, error: "Cancel the running check first." };
    }
    store.removePermit(id.data);
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:set-monitoring", (raw) => {
    const mode = z.enum(["manual", "scheduled"]).safeParse(raw);
    if (!mode.success) return { ok: false, error: "Invalid monitoring mode." };
    store.setMonitoring(mode.data);
    scheduleDue();
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:set-check-times", (raw) => {
    const times = z.array(z.string()).safeParse(raw);
    const normalized = times.success ? normalizeCheckTimes(times.data) : null;
    if (!normalized) return { ok: false, error: `Choose between 1 and ${MAX_CHECK_TIMES} check times.` };
    store.setCheckTimes(normalized, new Date());
    scheduleDue();
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:set-permit-monitoring", (raw) => {
    const parsed = z.object({ permitId: permitIdSchema, enabled: z.boolean() }).safeParse(raw);
    if (!parsed.success || !store.getPermit(parsed.data.permitId)) return { ok: false, error: "Permit not found." };
    store.setPermitMonitoring(parsed.data.permitId, parsed.data.enabled);
    scheduleDue();
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:set-project-number", (raw) => {
    const parsed = setProjectNumberSchema.safeParse(raw);
    if (!parsed.success) {
      const permitProblem = parsed.error.issues.some((issue) => issue.path[0] === "permitId");
      return { ok: false, error: permitProblem ? "Permit not found." : "Use letters, numbers, spaces, and - . _ / only (40 at most)." };
    }
    if (!store.setProjectNumber(parsed.data.permitId, parsed.data.projectNumber)) return { ok: false, error: "Permit not found." };
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:set-preference", (raw) => {
    const parsed = z.object({
      key: z.enum(["notifyStatusChanges", "notifyFailures", "runInBackground", "openAtLogin"]),
      value: z.boolean(),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid setting." };
    const { key, value } = parsed.data;
    if (key === "openAtLogin") {
      if (!openAtLoginAvailable()) return { ok: false, error: "Available in the installed app." };
      setOpenAtLogin(value);
    } else {
      store.setFlag(PREF_FLAGS[key], value);
    }
    void broadcast();
    return { ok: true, value: null };
  });
  handle("permit:check-update", async () => {
    try {
      return { ok: true, value: await updates.check() };
    } catch {
      return { ok: false, error: "Couldn't check for updates." };
    }
  });
  handle("permit:download-update", async () => {
    try {
      return { ok: true, value: await updates.download() };
    } catch {
      return { ok: false, error: "Download failed. Nothing was changed." };
    }
  });
  handle("permit:install-update", async () => {
    let installer: string;
    try {
      installer = await updates.installerForApprovedHandoff();
    } catch {
      return { ok: false, error: "The update failed verification. Check again." };
    }
    if (!(await stopChecks())) {
      shuttingDown = false;
      return { ok: false, error: "A check is still running. Try again." };
    }
    try {
      store.close();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(installer, [], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      quitAllowed = true;
      app.quit();
      return { ok: true, value: null };
    } catch {
      store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
      shuttingDown = false;
      return { ok: false, error: "The installer couldn't start. Restart the app and try again." };
    }
  });
  handle("permit:delete-local-data", async (raw) => {
    if (raw !== "DELETE LOCAL DATA") return { ok: false, error: "Deletion was not confirmed." };
    if (!(await stopChecks())) {
      shuttingDown = false;
      return { ok: false, error: "A check is still running. Try again." };
    }
    store.close();
    try { setOpenAtLogin(false); } catch { /* local data deletion continues */ }
    await rm(dataRoot(), { recursive: true, force: true });
    quitAllowed = true;
    app.quit();
    return { ok: true, value: null };
  });

  // Handlers are registered before the page loads so its first snapshot request never races them.
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  if (!(process.argv.includes(HIDDEN_LAUNCH_ARG) && background.available)) mainWindow.show();
  await broadcast(); // Populates the tray menu and tooltip before anything changes.

  setInterval(scheduleDue, 60_000).unref();
  powerMonitor.on("resume", scheduleDue);
  scheduleDue();
}

app.on("before-quit", (event) => {
  quitting = true;
  if (quitAllowed || !store) { background?.destroy(); return; }
  event.preventDefault();
  void stopChecks().then((stopped) => {
    if (stopped) store.close();
    quitAllowed = true;
    app.quit();
  });
});
