import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, shell, session } from "electron";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { KeyStore } from "./key-store.js";
import { createKeyStore } from "./electron-key-store.js";
import { DiagnosticLog } from "./diagnostics.js";
import { serialBroadcast } from "./serial-broadcast.js";
import { startUtilityWorker } from "./utility-worker.js";
import { keyProblem } from "../shared/key-format.js";
import { PermitStore } from "./store.js";
import { runCheck, type ActiveCheck } from "./check-runner.js";
import { addAndCheck } from "./permit-commands.js";
import { CheckQueue, type StartedCheck } from "./check-queue.js";
import { NAVIGATION_MODEL } from "./jev.js";
import { runPackagedBrowserSmoke } from "./packaged-smoke.js";
import { UpdateManager } from "./updater.js";
import { verifyBrowserPayload } from "./browser-integrity.js";
import { APP_USER_MODEL_ID, Background, desktopPlatform, getOpenAtLogin, HIDDEN_LAUNCH_ARG, setOpenAtLogin, TRAY_PLACE } from "./background.js";
import { FIRST_RUN_ARG, handleSquirrelEvent, hasDesktopShortcut, installedApp, setDesktopShortcut } from "./squirrel.js";
import { recordCheckEvent, describeSharedUpdate, keyNotice, type CheckEvent } from "./notifications.js";
import { CheckNotifier, DesktopNotificationFailed } from "./notification-delivery.js";
import { isFailure } from "../shared/outcomes.js";
import { describeCheckTimes, formatCheckTime, MAX_CHECK_TIMES, nextSlotAfter, normalizeCheckTimes, withinCheckWindow } from "../shared/schedule.js";
import { addPermitSchema, manualStatusSchema, setProjectNumberSchema, parsePortalUrl, permitIdSchema, permitNumberProblem, resolveJurisdiction, type AppSnapshot, type RunOutcome } from "../shared/permit.js";
import { checkScope, getAutomatedJurisdiction, getJurisdiction, isManualJurisdiction } from "../shared/jurisdictions.js";
import { PREFERENCE_KEYS, type BridgeResult, type KeyState, type StoredKeyState } from "../shared/bridge.js";
import { PROJECT_NUMBER_MAX } from "../shared/projects.js";
import { loadShareService, type ShareService } from "./share-service.js";
import { Sharing } from "./sharing.js";

// The Squirrel ID only matches a Start menu shortcut once installed. Unpackaged runs keep
// Electron's default so development builds can still show toasts.
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);

// Squirrel runs the app to handle install, update, and uninstall events; those launches do their work and quit.
const squirrelEvent = handleSquirrelEvent(process.argv, () => setOpenAtLogin(false));

if (squirrelEvent || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  // macOS: clicking the Dock icon brings back a window closed to the menu bar.
  app.on("activate", () => showWindow());
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

let notifier: CheckNotifier;

let sharing: Sharing;

/** The sharing service this build is configured for, or null when it has none. */
let shareService: ShareService | null = null;

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

/** Squirrel has no installer pages, so the first launch after installing asks about the desktop shortcut instead. */
let offerDesktopShortcut = installedApp() && process.argv.includes(FIRST_RUN_ARG);

const PLAYWRIGHT_VERSION = "1.63.0";

/** The answer to a change to this app's own permits while the window shows a followed list instead. */
const FOLLOWING: BridgeResult<never> = { ok: false, error: "You're viewing a shared list. Stop following it in Settings to change permits." };

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
  void notifier.announce(event).catch((cause: unknown) => diagnostics.record("notification:deliver", null, cause));
}

/** Records the result and, when it changes what the user knows, tells them. */
function finishAndAnnounce(input: Parameters<PermitStore["finishRun"]>[0]): void {
  const event = recordCheckEvent(store, input);

  // A notification problem must never stop the result from reaching the window.
  // The queue announces current-key rejection after checking its generation; obsolete checks stay quiet.
  if (event && input.outcome !== "authentication_error") try { announce(event); } catch { /* the saved result and window update still proceed */ }
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
    permits: sharing.following ? [...sharing.permits()] : store.listPermits(checks.checkingIds()),
    keyState: effectiveKeyState(stored),
    appVersion: app.getVersion(),
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "other",
    monitoring: store.getMonitoring(),
    checkTimes: store.getCheckTimes().map(formatCheckTime),
    preferences: {
      notifyStatusChanges: store.getFlag(PREF_FLAGS.notifyStatusChanges, true),
      notifyFailures: store.getFlag(PREF_FLAGS.notifyFailures, true),
      runInBackground: keepsRunningInBackground(),
      openAtLogin: getOpenAtLogin(),
      desktopShortcut: hasDesktopShortcut(),
      backgroundAvailable: Boolean(background?.available),
      installedApp: installedApp(),
      offerDesktopShortcut,
    },
    share: sharing.state(),
  };
}

/**
 * Sends the current state to the window and tray. Calls made in the same turn (for example, every
 * permit queued by one scheduled run) share a single snapshot taken just after that turn. Snapshots
 * go out one at a time, so an older one can never be sent after a newer one.
 */
const broadcast = serialBroadcast(sendSnapshot);

async function sendSnapshot(): Promise<void> {
  // Every change to this app's list passes through here, so a shared copy follows it.
  sharing.listChanged();

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
  if (shuttingDown || sharing.following || store.getMonitoring() !== "scheduled" || !withinCheckWindow(new Date(), store.getCheckTimes())) return false;

  return store.getPermit(permitId)?.monitoringEnabled === true;
}

/** The portal pacing scope for a permit. Hand-checked permits and unsupported jurisdictions have none, so they're never queued. */
function permitScope(permitId: string): string | null {
  const permit = store.getPermit(permitId);
  const profile = permit ? getAutomatedJurisdiction(permit.jurisdictionId) : null;

  return profile ? checkScope(profile) : null;
}

/**
 * Runs one browser check and records its result. Resolves null when no run was recorded, including when the queue no
 * longer wants the check once the browser payload is verified.
 */
function startCheck(permitId: string, key: string, stillWanted: () => boolean): StartedCheck {
  let cancelled = false;
  let running: ActiveCheck | null = null;

  const finished = (async (): Promise<RunOutcome | null> => {
    const permit = store.getPermit(permitId);

    if (!permit || !(await browserVerified) || cancelled || shuttingDown) return null;

    // Verification can take a while; scheduled work that stopped qualifying meanwhile doesn't start.
    if (!stillWanted()) return null;

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
      if (requested) notifier.resetKeyNotice();

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
  if (shuttingDown || sharing.following || checks.keyPaused || store.getMonitoring() !== "scheduled") return;
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

/** Sharing over the current store. Recreated when the store is reopened after a failed update or deletion. */
function createSharing(): Sharing {
  return new Sharing(store, shareService, {
    changed: () => { void broadcast(); },
    checking: () => checks.checkingIds().size > 0,
    listUpdated: (before, after) => {
      // The first list after following is just what there is; only later lists bring news.
      if (!before) return;

      for (const event of describeSharedUpdate(before.permits, after.permits)) {
        try { announce(event); } catch { /* the list still reaches the window */ }
      }
    },
    report: (operation, cause) => diagnostics.record(operation, null, cause),
  });
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
  notifier = new CheckNotifier({
    state: () => ({
      statusChanges: store.getFlag(PREF_FLAGS.notifyStatusChanges, true),
      failures: store.getFlag(PREF_FLAGS.notifyFailures, true),
      desktop: desktopPlatform(),
      windowInFront: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()),
    }),
    inApp: (notice) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("permit:app-event", notice);
    },
    desktop: (notice) => background?.notify(notice) ?? Promise.resolve({ _tag: "failed", error: new DesktopNotificationFailed("unsupported") }),
    failed: (error) => diagnostics.record("notification:desktop", null, error),
  });
  store.alignSchedule(new Date());
  checks = createQueue();
  // Sharing can send a snapshot as soon as it starts, and a snapshot reads the key state.
  keys = createKeyStore(dataRoot());
  shareService = loadShareService(path.join(__dirname, "sync-config.json"));
  sharing = createSharing();
  await sharing.start();
  updates = new UpdateManager(dataRoot(), app.getVersion(),
    app.isPackaged ? path.join(process.resourcesPath, "authenticode.ps1") : path.join(__dirname, "authenticode.ps1"),
    path.join(__dirname, "update-config.json"));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  background = new Background(path.join(__dirname, "assets"), {
    showWindow,
    openPermit: openPermitInWindow,
    checkAll: () => {
      if (sharing.following) return;

      for (const permit of store.listPermits()) checks.enqueue(permit.id, "manual");
    },
    setScheduled: (enabled) => {
      store.setMonitoring(enabled ? "scheduled" : "manual");
      scheduleChanged();
    },
    quit: () => app.quit(),
  });
  background.start();
  // macOS takes Copy, Paste, and Quit from the application menu, so without one the key and share code fields can't be
  // pasted into. Windows shows no menu bar.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
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
  mainWindow.on("focus", () => notifier.windowFocused());
  mainWindow.on("close", (event) => {
    if (quitting || !keepsRunningInBackground()) return;
    event.preventDefault();
    mainWindow?.hide();

    if (!store.getFlag(BACKGROUND_HINT_SHOWN, false)) {
      store.setFlag(BACKGROUND_HINT_SHOWN, true);
      void background?.notify({ title: `Still running in the ${TRAY_PLACE}`,
        body: process.platform === "darwin" ? "Quit from its menu bar icon or with Command-Q." : "Right-click the icon to quit." });
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
    if (sharing.following) return FOLLOWING;
    const jurisdictionId = resolveJurisdiction(input.jurisdiction);

    if (!jurisdictionId) {
      return { ok: false, error: "Choose a supported jurisdiction." };
    }

    const problem = permitNumberProblem(jurisdictionId, input.permitNumber);

    if (problem) return { ok: false, error: problem };

    const added = addAndCheck(store, checks, () => { void broadcast(); }, input.permitNumber, jurisdictionId);

    if (added._tag === "err") return { ok: false, error: "That permit is already in the list." };

    return { ok: true, value: added.value };
  });
  handle("permit:check", permitIdSchema, "Permit not found.", async (id) => {
    if (sharing.following) return FOLLOWING;
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
    if (sharing.following) return FOLLOWING;
    const permit = store.getPermit(id);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;

    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    // The number goes on the clipboard so it can be pasted straight into the portal's search.
    clipboard.writeText(permit.permitNumber);
    await shell.openExternal(profile.startUrl);

    return { ok: true, value: null };
  });
  handle("permit:record-manual-status", manualStatusSchema, "Enter the status shown on the portal.", async (input) => {
    if (sharing.following) return FOLLOWING;
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
  handle("permit:history", z.object({ permitId: permitIdSchema, before: z.iso.datetime().nullable() }), "Permit not found.", ({ permitId: id, before }) => {
    if (sharing.following) {
      const history = sharing.history(id);

      return history ? { ok: true, value: history } : { ok: false, error: "Permit not found." };
    }

    if (!store.getPermit(id)) return { ok: false, error: "Permit not found." };

    return { ok: true, value: store.dailyHistory(id, 120, before) };
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

    notifier.resetKeyNotice();
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
    // A followed list's links come from another app, so they get the same portal check as this app's own.
    const permit = sharing.following ? sharing.permit(id) : store.getPermit(id);

    if (!permit?.lastRecordUrl || !parsePortalUrl(permit.lastRecordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: "No record link yet." };
    }

    await shell.openExternal(permit.lastRecordUrl);

    return { ok: true, value: null };
  });
  handle("permit:open-observation-record", permitIdSchema, "No record link for this entry.", async (id) => {
    const followed = sharing.following ? sharing.observation(id) : null;
    const observation = sharing.following ? followed?.observation : store.getObservation(id);
    const jurisdictionId = sharing.following ? followed?.permit.jurisdictionId : store.getObservationJurisdictionId(id);

    if (!observation || !jurisdictionId || !parsePortalUrl(observation.recordUrl, "detail", jurisdictionId)) {
      return { ok: false, error: "No record link for this entry." };
    }

    await shell.openExternal(observation.recordUrl);

    return { ok: true, value: null };
  });
  handle("permit:remove", permitIdSchema, "Permit not found.", (id) => {
    if (sharing.following) return FOLLOWING;

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
    if (sharing.following) return FOLLOWING;

    if (!store.getPermit(input.permitId)) return { ok: false, error: "Permit not found." };
    store.setPermitMonitoring(input.permitId, input.enabled);
    scheduleChanged();

    return { ok: true, value: null };
  });
  // Any other permit ID is simply not found, so only the project number can be invalid.
  handle("permit:set-project-number", setProjectNumberSchema.extend({ permitId: z.string() }),
    `Use letters, numbers, spaces, and - . _ / only (${PROJECT_NUMBER_MAX} at most).`, (input) => {
    if (sharing.following) return FOLLOWING;

    if (!store.setProjectNumber(input.permitId, input.projectNumber)) return { ok: false, error: "Permit not found." };
    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:set-preference", z.object({
    key: z.enum(PREFERENCE_KEYS),
    value: z.boolean(),
  }), "Invalid setting.", async ({ key, value }) => {
    if ((key === "openAtLogin" || key === "desktopShortcut") && !installedApp()) return { ok: false, error: "Available in the installed app." };

    if (key === "openAtLogin") {
      setOpenAtLogin(value);
    } else if (key === "desktopShortcut") {
      offerDesktopShortcut = false;

      try {
        await setDesktopShortcut(value);
      } catch (cause) {
        diagnostics.record("permit:desktop-shortcut", null, cause);
        void broadcast();

        return { ok: false, error: "The desktop shortcut couldn't be changed." };
      }
    } else {
      store.setFlag(PREF_FLAGS[key], value);
    }

    void broadcast();

    return { ok: true, value: null };
  });
  handle("permit:check-update", NO_INPUT, "Invalid request.", async () => {
    try {
      return { ok: true, value: await updates.check() };
    } catch (cause) {
      diagnostics.record("permit:check-update", null, cause);

      return { ok: false, error: "Couldn't check for updates." };
    }
  });
  handle("permit:download-update", NO_INPUT, "Invalid request.", async () => {
    // The feed's installer is for Windows. A Mac copy is replaced by hand from the download page.
    if (process.platform === "darwin") return { ok: false, error: "Download the new version from the download page." };

    try {
      return { ok: true, value: await updates.download() };
    } catch (cause) {
      diagnostics.record("permit:download-update", null, cause);

      return { ok: false, error: "Download failed. Nothing was changed." };
    }
  });
  handle("permit:open-update-download", NO_INPUT, "Invalid request.", async () => {
    const page = updates.macDownloadUrl();

    if (process.platform !== "darwin" || !page) return { ok: false, error: "No download page in this build." };
    await shell.openExternal(page);

    return { ok: true, value: null };
  });
  handle("permit:install-update", NO_INPUT, "Invalid request.", async () => {
    let installer: string;

    try {
      installer = await updates.installerForApprovedHandoff();
    } catch (cause) {
      diagnostics.record("permit:install-update:verify", null, cause);

      return { ok: false, error: "The update failed verification. Check again." };
    }

    if (!(await stopChecks())) {
      resumeAfterFailedShutdown();

      return { ok: false, error: "A check is still running. Try again." };
    }

    await sharing.stop();

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
    } catch (cause) {
      store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
      diagnostics.record("permit:install-update:start", null, cause);
      sharing = createSharing();
      await sharing.start();
      resumeAfterFailedShutdown();

      return { ok: false, error: "The installer couldn't start. Restart the app and try again." };
    }
  });
  handle("permit:delete-local-data", z.literal("DELETE LOCAL DATA"), "Deletion was not confirmed.", async () => {
    if (!(await stopChecks())) {
      resumeAfterFailedShutdown();

      return { ok: false, error: "A check is still running. Try again." };
    }

    // An update download writes inside the data folder, so it has to stop and let go of its files first.
    await updates.cancel();
    // The shared copy goes with the local data, so the code others hold stops working. The write key is the only way to
    // delete it, so local data stays until the deletion goes through.
    const unshared = await sharing.stopSharing();

    if (!unshared.ok) {
      resumeAfterFailedShutdown();

      return { ok: false, error: "Couldn't remove the shared copy, so nothing was deleted. Try again." };
    }

    await sharing.stop();
    store.close();
    // Stopping the queue sent a snapshot that now fails on the closed store; recording that would recreate the folder.
    diagnostics.stop();

    try { setOpenAtLogin(false); } catch { /* local data deletion continues */ }

    try {
      await rm(dataRoot(), { recursive: true, force: true });
    } catch (cause) {
      diagnostics.restart();
      diagnostics.record("permit:delete-local-data", null, cause);
      store = new PermitStore(path.join(dataRoot(), "data", "permits.sqlite"));
      sharing = createSharing();
      await sharing.start();
      resumeAfterFailedShutdown();

      return { ok: false, error: "Some local data couldn't be deleted. Try again." };
    }

    quitAllowed = true;
    app.quit();

    return { ok: true, value: null };
  });

  handle("permit:share-start", NO_INPUT, "Invalid request.", () => sharing.startSharing());
  handle("permit:share-stop", NO_INPUT, "Invalid request.", () => sharing.stopSharing());
  handle("permit:share-copy", NO_INPUT, "Invalid request.", () => {
    const code = sharing.code();

    if (!code) return { ok: false, error: "This list isn't shared." };
    clipboard.writeText(code);

    return { ok: true, value: null };
  });
  handle("permit:follow", z.string().max(200), "That isn't a share code.", async (code) => {
    const result = await sharing.follow(code);

    // Nothing of this app's own runs while another list is shown, including checks asked for by hand, such as Check
    // all from the tray; otherwise they would notify about permits the window no longer shows.
    if (result.ok) for (const permit of store.listPermits()) checks.cancel(permit.id);

    return result;
  });
  handle("permit:follow-stop", NO_INPUT, "Invalid request.", async () => {
    const result = await sharing.stopFollowing();
    scheduleDue();

    return result;
  });
  handle("permit:share-sync", NO_INPUT, "Invalid request.", () => sharing.sync());

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
  // A stopped update download removes its partial file instead of leaving it for the next run.
  void Promise.all([stopChecks(), updates.cancel(), sharing.stop()]).then(([stopped]) => {
    if (stopped) store.close();
    quitAllowed = true;
    app.quit();
  });
});
