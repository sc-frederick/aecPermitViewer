import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, shell, session } from "electron";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { KeyStore } from "./key-store.js";
import { DiagnosticLog } from "./diagnostics.js";
import { serialBroadcast } from "./serial-broadcast.js";
import { startUtilityWorker } from "./utility-worker.js";
import { keyProblem } from "../shared/key-format.js";
import { PermitStore } from "./store.js";
import { runCheck, type ActiveCheck } from "./check-runner.js";
import { CheckQueue, type StartedCheck } from "./check-queue.js";
import { NAVIGATION_MODEL } from "./jev.js";
import { runPackagedBrowserSmoke } from "./packaged-smoke.js";
import { UpdateManager } from "./updater.js";
import { verifyBrowserPayload } from "./browser-integrity.js";
import { APP_USER_MODEL_ID, Background, getOpenAtLogin, HIDDEN_LAUNCH_ARG, openAtLoginAvailable, setOpenAtLogin } from "./background.js";
import { describeCheckEvent, keyNotice, type CheckEvent } from "./notifications.js";
import { isFailure } from "../shared/outcomes.js";
import { describeCheckTimes, formatCheckTime, MAX_CHECK_TIMES, nextSlotAfter, normalizeCheckTimes, withinCheckWindow } from "../shared/schedule.js";
import { addPermitSchema, manualStatusSchema, setProjectNumberSchema, parsePortalUrl, permitIdSchema, permitNumberProblem, resolveJurisdiction, type AppSnapshot, type RunOutcome } from "../shared/permit.js";
import { checkScope, getAutomatedJurisdiction, getJurisdiction, isManualJurisdiction } from "../shared/jurisdictions.js";
import { PREFERENCE_KEYS, type AppEvent, type BridgeResult, type KeyState, type StoredKeyState } from "../shared/bridge.js";
import { PROJECT_NUMBER_MAX } from "../shared/projects.js";

// The Squirrel ID only matches a Start menu shortcut once installed. Unpackaged runs keep
// Electron's default so development builds can still show toasts.
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);

if (process.argv.includes("--squirrel-uninstall")) {
  try { setOpenAtLogin(false); } catch { /* the uninstaller continues regardless */ }
}

// electron-squirrel-startup exports true while a Squirrel install or update event is being handled.
const squirrelStartup = require("electron-squirrel-startup") === true;

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

let checks: CheckQueue;

let schedulerTimer: NodeJS.Timeout | null = null;

let shuttingDown = false;

let quitAllowed = false;

let quitting = false;

let background: Background | null = null;

let keyNoticeShown = false;

/** Failures the user only sees as a generic message are recorded here, without their messages or any user data. */
let diagnostics: DiagnosticLog;

/** The revision of the last snapshot read. See {@link AppSnapshot.revision}. */
let snapshotRevision = 0;

/** Resolves true once the bundled browser matches its manifest. No check launches it before then. */
let browserVerified: Promise<boolean> = Promise.resolve(true);

const PREF_FLAGS = {
  notifyStatusChanges: "notify_status_changes",
  notifyFailures: "notify_failures",
  runInBackground: "run_in_background",
} as const;

const BACKGROUND_HINT_SHOWN = "background_hint_shown";

const PLAYWRIGHT_VERSION = "1.63.0";

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

  const notice: AppEvent = { tone: event.kind === "check-failed" || event.kind === "key-needed" ? "error" : "info", title: event.title, body: event.body };

  if (event.permitId) notice.permitId = event.permitId;
  const windowInFront = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused());

  // Desktop toasts are a Windows feature here; on other development platforms (for example WSL,
  // where no notification service may answer) the message stays inside the app window.
  if (windowInFront || process.platform !== "win32") {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("permit:app-event", notice);

    return;
  }

  background?.notify(notice);
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

/** The saved key's state, treating a key-storage failure as storage being unavailable. */
async function storedKeyState(operation: string): Promise<StoredKeyState> {
  return keys.state().catch((cause: unknown) => {
    diagnostics.record(operation, null, cause);

    return "unavailable" as const;
  });
}

/** Why a check someone asked for can't run with the saved key, or null when it can. */
function keyStateProblem(state: StoredKeyState): string | null {
  switch (state) {
    case "configured": return null;
    case "missing": return "Add your TypeSafe key in Settings first.";
    case "unreadable": return "Your saved key can't be read. Save it again in Settings.";
    case "unavailable": return "Key storage isn't available on this computer.";
  }
}

/** Whether checks can run for want of a key: what storage knows, plus the queue's pause after the service turned the key down. */
function effectiveKeyState(stored: StoredKeyState): KeyState {
  return stored === "configured" && checks.keyPaused ? "rejected" : stored;
}

/**
 * Reads the whole app state. The key state is the only asynchronous part, so it is read first; everything else, and the
 * revision, is read after it in one turn. A snapshot with a higher revision therefore never holds older permits or settings.
 */
async function snapshot(): Promise<AppSnapshot> {
  const stored = await storedKeyState("snapshot:key-state");
  snapshotRevision += 1;

  return {
    revision: snapshotRevision,
    permits: store.listPermits(checks.checkingIds()),
    keyState: effectiveKeyState(stored),
    appVersion: app.getVersion(),
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
 * permit queued by one scheduled run) share a single snapshot taken just after that turn. Snapshots
 * go out one at a time, so an older one can never be sent after a newer one.
 */
const broadcast = serialBroadcast(sendSnapshot);

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
  } catch (cause) {
    // The next UI request will surface local storage errors through its reply.
    diagnostics.record("snapshot:broadcast", null, cause);
  }
}

function safeSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;

  return event.senderFrame.url === pathToFileURL(path.join(__dirname, "index.html")).href;
}

const NO_INPUT = z.undefined();

/**
 * Answers a window request once its input parses; otherwise answers with `invalid`. A failure the callback didn't
 * answer itself gets a generic reply, and its classified cause is recorded under the channel's name.
 */
function handle<I, T>(channel: string, schema: z.ZodType<I>, invalid: string,
  callback: (input: I) => Promise<BridgeResult<T>> | BridgeResult<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!safeSender(event)) return { ok: false, error: "Unauthorized request." };
    const parsed = schema.safeParse(args[0]);

    if (!parsed.success) return { ok: false, error: invalid };

    try {
      return await callback(parsed.data);
    } catch (cause) {
      diagnostics.record(channel, null, cause);

      return { ok: false, error: "Something went wrong. Try again." };
    }
  });
}

/** Whether a scheduled check may start now: scheduling on, inside the check window, and the permit included. */
function scheduledEligible(permitId: string): boolean {
  if (shuttingDown || store.getMonitoring() !== "scheduled" || !withinCheckWindow(new Date(), store.getCheckTimes())) return false;

  return store.getPermit(permitId)?.monitoringEnabled === true;
}

/** The portal pacing scope for a permit. Hand-checked permits and unsupported jurisdictions have none, so they're never queued. */
function permitScope(permitId: string): string | null {
  const permit = store.getPermit(permitId);
  const profile = permit ? getAutomatedJurisdiction(permit.jurisdictionId) : null;

  return profile ? checkScope(profile) : null;
}

/** Runs one browser check and records its result. Resolves null when no run was recorded. */
function startCheck(permitId: string, key: string): StartedCheck {
  let cancelled = false;
  let running: ActiveCheck | null = null;

  const finished = (async (): Promise<RunOutcome | null> => {
    const permit = store.getPermit(permitId);

    if (!permit || !(await browserVerified) || cancelled || shuttingDown) return null;

    const runId = store.startRun({ permitId, appVersion: app.getVersion(), playwrightVersion: PLAYWRIGHT_VERSION,
      requestedModel: NAVIGATION_MODEL.model, promptVersion: NAVIGATION_MODEL.promptVersion });

    const browserPath = app.isPackaged
      ? path.join(process.resourcesPath, "playwright-browsers")
      : path.join(app.getAppPath(), "vendor", "playwright-browsers");

    const workerPath = path.join(__dirname, "worker.cjs");

    try {
      running = runCheck({ runId, permit, key, browserPath, cacheRoot: path.join(dataRoot(), "cache"),
        startWorker: (environment) => startUtilityWorker(workerPath, environment),
        report: (operation, cause) => diagnostics.record(`check:${operation}`, runId, cause) });
    } catch (cause) {
      diagnostics.record("check:create-cache", runId, cause);
      finishAndAnnounce({ runId, permitId, outcome: "browser_error", actionCount: 0,
        requestCount: 0, actualModel: null, browserVersion: null });

      return "browser_error";
    }

    if (cancelled) running.cancel();
    // The row already shows checking, but an open history now has a started run to show.
    void broadcast();
    const result = await running.result;
    await running.closed;
    finishAndAnnounce({ runId, permitId, ...result });

    return result.outcome;
  })();

  return { finished, cancel: () => { cancelled = true; running?.cancel(); } };
}

function createQueue(): CheckQueue {
  return new CheckQueue({
    scopeOf: permitScope,
    scheduledEligible,
    readKey: () => keys.read(),
    start: startCheck,
    defer: (permitId) => store.deferDue(permitId, nextSlotAfter(new Date(), store.getCheckTimes())),
    keyUnavailable: (problem, requested) => {
      // Someone who asked for a check hears why it didn't run, even after the first notice.
      if (requested) keyNoticeShown = false;

      // A notification problem must never stop the queue.
      try { announce(keyNotice(problem)); } catch { /* the key banner still shows in the window */ }
    },
    saveFailed: () => {
      // Persistence failures cannot be represented as a portal status.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("permit:local-error", "Couldn't save locally. Restart the app.");
    },
    changed: () => { void broadcast(); },
  });
}

async function stopChecks(): Promise<boolean> {
  shuttingDown = true;
  stopScheduler();

  const completed = await Promise.race([
    checks.stop().then(() => true),
    new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), 10_000); timer.unref(); }),
  ]);

  return completed && !checks.busy;
}

/** An update or deletion that couldn't go ahead returns to the running app. */
function resumeAfterFailedShutdown(): void {
  shuttingDown = false;
  checks.restart();
  startScheduler();
  void broadcast();
}

/** Queues due permits. The interval and resume listener are stopped before the store closes, and this checks as well. */
function scheduleDue(): void {
  if (shuttingDown || checks.keyPaused || store.getMonitoring() !== "scheduled") return;
  const now = new Date();

  // Scheduled checks stay inside the check window; anything missed overnight runs at the first morning slot.
  if (!withinCheckWindow(now, store.getCheckTimes())) return;

  for (const id of store.duePermitIds(now.toISOString())) checks.enqueue(id, "scheduled");
}

function startScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(scheduleDue, 60_000);
  schedulerTimer.unref();
  powerMonitor.on("resume", scheduleDue);
}

function stopScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  powerMonitor.off("resume", scheduleDue);
}

/** A scheduling setting changed: queued scheduled work that no longer qualifies is dropped, and newly due work queued. */
function scheduleChanged(): void {
  checks.prune();
  scheduleDue();
  void broadcast();
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

  diagnostics = new DiagnosticLog(path.join(dataRoot(), "logs", "diagnostics.jsonl"));
  store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
  store.alignSchedule(new Date());
  checks = createQueue();
  keys = new KeyStore(dataRoot());
  updates = new UpdateManager(dataRoot(), app.getVersion(),
    app.isPackaged ? path.join(process.resourcesPath, "authenticode.ps1") : path.join(__dirname, "authenticode.ps1"),
    path.join(__dirname, "update-config.json"));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  background = new Background(path.join(__dirname, "assets"), {
    showWindow,
    openPermit: openPermitInWindow,
    checkAll: () => { for (const permit of store.listPermits()) checks.enqueue(permit.id, "manual"); },
    setScheduled: (enabled) => {
      store.setMonitoring(enabled ? "scheduled" : "manual");
      scheduleChanged();
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

    // The window has no snapshot to show instead, so the request still fails; the cause is kept.
    return snapshot().catch((cause: unknown) => {
      diagnostics.record("permit:snapshot", null, cause);
      throw cause;
    });
  });
  handle("permit:add-and-check", addPermitSchema, "Enter a permit number.", (input) => {
    const jurisdictionId = resolveJurisdiction(input.jurisdiction);

    if (!jurisdictionId) {
      return { ok: false, error: "Choose a supported jurisdiction." };
    }

    const problem = permitNumberProblem(jurisdictionId, input.permitNumber);

    if (problem) return { ok: false, error: problem };

    try {
      const id = store.addPermit(input.permitNumber, jurisdictionId);
      checks.enqueue(id, "manual");

      return { ok: true, value: id };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { ok: false, error: "That permit is already in the list." };
      }

      throw error;
    }
  });
  handle("permit:check", permitIdSchema, "Permit not found.", async (id) => {
    const permit = store.getPermit(id);

    if (!permit) return { ok: false, error: "Permit not found." };

    if (isManualJurisdiction(permit.jurisdictionId)) return { ok: false, error: "This permit is checked by hand." };
    const problem = keyStateProblem(await storedKeyState("permit:check"));

    if (problem) return { ok: false, error: problem };

    // A rejected key may have been fixed on the service's side, so asking for a check still tries it.
    checks.enqueue(permit.id, "manual");

    return { ok: true, value: null };
  });
  handle("permit:open-portal", permitIdSchema, "Permit not found.", async (id) => {
    const permit = store.getPermit(id);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;

    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    // The number goes on the clipboard so it can be pasted straight into the portal's search.
    clipboard.writeText(permit.permitNumber);
    await shell.openExternal(profile.startUrl);

    return { ok: true, value: null };
  });
  handle("permit:record-manual-status", manualStatusSchema, "Enter the status shown on the portal.", async (input) => {
    const permit = store.getPermit(input.permitId);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;

    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    const recordUrl = input.recordUrl || profile.startUrl;

    if (!parsePortalUrl(recordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: `Use a link from ${profile.label}'s portal, or leave it blank.` };
    }

    store.recordManualStatus({ permitId: permit.id, status: input.status, recordUrl, appVersion: app.getVersion() });
    await broadcast();

    return { ok: true, value: null };
  });
  handle("permit:cancel", permitIdSchema, "Permit not found.", (id) => {
    checks.cancel(id);
    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:history", permitIdSchema, "Permit not found.", (id) => {
    if (!store.getPermit(id)) return { ok: false, error: "Permit not found." };

    return { ok: true, value: store.history(id) };
  });
  // The key arrives once from the settings field and is encrypted immediately. It is never
  // echoed back to the window, logged, stored in the database, or given to the browser worker.
  handle("permit:save-key", z.string(), "Enter your API key.", async (raw) => {
    const key = raw.trim();
    const problem = keyProblem(key);

    if (problem) return { ok: false, error: problem };

    const saved = await keys.save(key);

    if (saved._tag === "failed") {
      if (saved.error._tag === "KeyStorageUnavailable") return { ok: false, error: "Key storage isn't available, so the key wasn't saved." };
      diagnostics.record("permit:save-key", null, saved.error.cause);

      return { ok: false, error: "The key couldn't be saved. Try again." };
    }

    keyNoticeShown = false;
    // Work paused for want of a key picks up now rather than at the next slot.
    checks.resume();
    scheduleDue();
    await broadcast();

    return { ok: true, value: null };
  });
  handle("permit:remove-key", NO_INPUT, "Invalid request.", async () => {
    await keys.remove();
    await broadcast();

    return { ok: true, value: null };
  });
  handle("permit:open-record", permitIdSchema, "No record link yet.", async (id) => {
    const permit = store.getPermit(id);

    if (!permit?.lastRecordUrl || !parsePortalUrl(permit.lastRecordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: "No record link yet." };
    }

    await shell.openExternal(permit.lastRecordUrl);

    return { ok: true, value: null };
  });
  handle("permit:open-observation-record", permitIdSchema, "No record link for this entry.", async (id) => {
    const observation = store.getObservation(id);
    const jurisdictionId = store.getObservationJurisdictionId(id);

    if (!observation || !jurisdictionId || !parsePortalUrl(observation.recordUrl, "detail", jurisdictionId)) {
      return { ok: false, error: "No record link for this entry." };
    }

    await shell.openExternal(observation.recordUrl);

    return { ok: true, value: null };
  });
  handle("permit:remove", permitIdSchema, "Permit not found.", (id) => {
    if (!store.getPermit(id)) return { ok: false, error: "Permit not found." };

    if (!checks.remove(id)) return { ok: false, error: "Cancel the running check first." };

    store.removePermit(id);
    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:set-monitoring", z.enum(["manual", "scheduled"]), "Invalid monitoring mode.", (mode) => {
    store.setMonitoring(mode);
    scheduleChanged();

    return { ok: true, value: null };
  });
  const checkTimesProblem = `Choose between 1 and ${MAX_CHECK_TIMES} check times.`;

  handle("permit:set-check-times", z.array(z.string()), checkTimesProblem, (times) => {
    const normalized = normalizeCheckTimes(times);

    if (!normalized) return { ok: false, error: checkTimesProblem };
    store.setCheckTimes(normalized, new Date());
    scheduleChanged();

    return { ok: true, value: null };
  });
  handle("permit:set-permit-monitoring", z.object({ permitId: permitIdSchema, enabled: z.boolean() }), "Permit not found.", (input) => {
    if (!store.getPermit(input.permitId)) return { ok: false, error: "Permit not found." };
    store.setPermitMonitoring(input.permitId, input.enabled);
    scheduleChanged();

    return { ok: true, value: null };
  });
  // Any other permit ID is simply not found, so only the project number can be invalid.
  handle("permit:set-project-number", setProjectNumberSchema.extend({ permitId: z.string() }),
    `Use letters, numbers, spaces, and - . _ / only (${PROJECT_NUMBER_MAX} at most).`, (input) => {
    if (!store.setProjectNumber(input.permitId, input.projectNumber)) return { ok: false, error: "Permit not found." };
    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:set-preference", z.object({
    key: z.enum(PREFERENCE_KEYS),
    value: z.boolean(),
  }), "Invalid setting.", ({ key, value }) => {
    if (key === "openAtLogin") {
      if (!openAtLoginAvailable()) return { ok: false, error: "Available in the installed app." };
      setOpenAtLogin(value);
    } else {
      store.setFlag(PREF_FLAGS[key], value);
    }

    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:check-update", NO_INPUT, "Invalid request.", async () => {
    try {
      return { ok: true, value: await updates.check() };
    } catch {
      return { ok: false, error: "Couldn't check for updates." };
    }
  });
  handle("permit:download-update", NO_INPUT, "Invalid request.", async () => {
    try {
      return { ok: true, value: await updates.download() };
    } catch {
      return { ok: false, error: "Download failed. Nothing was changed." };
    }
  });
  handle("permit:install-update", NO_INPUT, "Invalid request.", async () => {
    let installer: string;

    try {
      installer = await updates.installerForApprovedHandoff();
    } catch {
      return { ok: false, error: "The update failed verification. Check again." };
    }

    if (!(await stopChecks())) {
      resumeAfterFailedShutdown();

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
      resumeAfterFailedShutdown();

      return { ok: false, error: "The installer couldn't start. Restart the app and try again." };
    }
  });
  handle("permit:delete-local-data", z.literal("DELETE LOCAL DATA"), "Deletion was not confirmed.", async () => {
    if (!(await stopChecks())) {
      resumeAfterFailedShutdown();

      return { ok: false, error: "A check is still running. Try again." };
    }

    store.close();

    try { setOpenAtLogin(false); } catch { /* local data deletion continues */ }

    try {
      await rm(dataRoot(), { recursive: true, force: true });
    } catch {
      store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
      resumeAfterFailedShutdown();

      return { ok: false, error: "Some local data couldn't be deleted. Try again." };
    }

    quitAllowed = true;
    app.quit();

    return { ok: true, value: null };
  });

  // Handlers are registered before the page loads so its first snapshot request never races them.
  await mainWindow.loadFile(path.join(__dirname, "index.html"));

  if (!(process.argv.includes(HIDDEN_LAUNCH_ARG) && background.available)) mainWindow.show();
  await broadcast(); // Populates the tray menu and tooltip before anything changes.

  startScheduler();
  scheduleDue();
}

app.on("before-quit", (event) => {
  quitting = true;

  if (quitAllowed || !store) {
    background?.destroy();

    return;
  }

  event.preventDefault();
  void stopChecks().then((stopped) => {
    if (stopped) store.close();
    quitAllowed = true;
    app.quit();
  });
});
