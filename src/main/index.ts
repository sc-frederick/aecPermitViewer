import { app, dialog, type BrowserWindow } from "electron";
import type { AppContext, Lifecycle, Scheduler } from "./app-context.js";
import { sendSnapshot } from "./app-state.js";
import { APP_USER_MODEL_ID, HIDDEN_LAUNCH_ARG, setOpenAtLogin, type Background } from "./background.js";
import { verifyBrowserPayload } from "./browser-integrity.js";
import type { CheckQueue } from "./check-queue.js";
import { createQueue } from "./checks.js";
import { DiagnosticLog } from "./diagnostics.js";
import { createKeyStore } from "./electron-key-store.js";
import { registerDataHandlers } from "./ipc/data.js";
import { registerPermitHandlers } from "./ipc/permits.js";
import { registerSettingsHandlers } from "./ipc/settings.js";
import { registerSharingHandlers } from "./ipc/sharing.js";
import { registerUpdateHandlers } from "./ipc/updates.js";
import type { KeyStore } from "./key-store.js";
import type { CheckNotifier } from "./notification-delivery.js";
import { createNotifier } from "./notifier.js";
import { runPackagedBrowserSmoke } from "./packaged-smoke.js";
import {
  bundledBrowserPath,
  databasePath,
  dataRoot,
  diagnosticsPath,
  pagePath,
  syncConfigPath,
  updateConfigPath,
  updateScriptPath,
} from "./paths.js";
import { createScheduler } from "./scheduler.js";
import { serialBroadcast } from "./serial-broadcast.js";
import { loadShareService, type ShareService } from "./share-service.js";
import { createSharing } from "./sharing-host.js";
import type { Sharing } from "./sharing.js";
import { stopChecks } from "./shutdown.js";
import { FIRST_RUN_ARG, handleSquirrelEvent, installedApp } from "./squirrel.js";
import { PermitStore } from "./store.js";
import { UpdateManager } from "./updater.js";
import {
  createBackground,
  createMainWindow,
  denyPermissionRequests,
  setApplicationMenu,
  showWindow,
} from "./window.js";

if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);

const squirrelEvent = handleSquirrelEvent(process.argv, () => setOpenAtLogin(false));

if (squirrelEvent || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (running) showWindow(running);
  });
  app.on("activate", () => {
    if (running) showWindow(running);
  });
  void app.whenReady().then(startApp).catch(failStartup);
}

let startupFailed = false;

function failStartup(): void {
  if (startupFailed) return;
  startupFailed = true;

  if (!process.argv.includes("--smoke-browser")) {
    dialog.showErrorBox(
      "Permit Monitor could not start",
      "The local application or bundled browser could not be verified. Reinstall the app from a trusted release.",
    );
  }

  app.exit(1);
}

const lifecycle: Lifecycle = { quitting: false, quitAllowed: false };

let running: AppContext | null = null;

class MainContext implements AppContext {
  store: PermitStore;
  sharing: Sharing;
  readonly notifier: CheckNotifier;
  readonly checks: CheckQueue;
  readonly scheduler: Scheduler;
  readonly keys: KeyStore;
  readonly shareService: ShareService | null;
  readonly updates: UpdateManager;
  readonly broadcast = serialBroadcast(() => sendSnapshot(this));
  mainWindow: BrowserWindow | null = null;
  background: Background | null = null;
  shuttingDown = false;
  offerDesktopShortcut = installedApp() && process.argv.includes(FIRST_RUN_ARG);
  snapshotRevision = 0;

  constructor(
    readonly diagnostics: DiagnosticLog,
    readonly browserVerified: Promise<boolean>,
    readonly lifecycle: Lifecycle,
  ) {
    this.store = new PermitStore(databasePath());
    this.notifier = createNotifier(this);
    this.store.alignSchedule(new Date());
    this.checks = createQueue(this);
    this.scheduler = createScheduler(this);
    this.keys = createKeyStore(dataRoot());
    this.shareService = loadShareService(syncConfigPath());
    this.sharing = createSharing(this);
    this.updates = new UpdateManager(dataRoot(), app.getVersion(), updateScriptPath(), updateConfigPath());
  }
}

async function startApp(): Promise<void> {
  const payload = app.isPackaged ? verifyBrowserPayload(bundledBrowserPath()) : Promise.resolve();

  if (process.argv.includes("--smoke-browser")) {
    await payload;
    await runPackagedBrowserSmoke();

    return;
  }

  const browserVerified = payload.then(
    () => true,
    () => {
      failStartup();

      return false;
    },
  );

  const context = new MainContext(new DiagnosticLog(diagnosticsPath()), browserVerified, lifecycle);
  running = context;
  await context.sharing.start();
  denyPermissionRequests();
  context.background = createBackground(context);
  context.background.start();
  setApplicationMenu();
  const mainWindow = createMainWindow(context);
  context.mainWindow = mainWindow;
  registerPermitHandlers(context);
  registerSettingsHandlers(context);
  registerUpdateHandlers(context);
  registerDataHandlers(context);
  registerSharingHandlers(context);

  await mainWindow.loadFile(pagePath());

  if (!(process.argv.includes(HIDDEN_LAUNCH_ARG) && context.background.available)) mainWindow.show();
  await context.broadcast();

  context.scheduler.start();
  context.scheduler.scheduleDue();
}

app.on("before-quit", (event) => {
  lifecycle.quitting = true;
  const context = running;

  if (lifecycle.quitAllowed || !context) {
    context?.background?.destroy();

    return;
  }

  event.preventDefault();
  void Promise.all([stopChecks(context), context.updates.cancel(), context.sharing.stop()]).then(([stopped]) => {
    if (stopped) context.store.close();
    lifecycle.quitAllowed = true;
    app.quit();
  });
});
