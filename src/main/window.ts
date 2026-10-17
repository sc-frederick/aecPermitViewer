import { app, BrowserWindow, Menu, session } from "electron";
import path from "node:path";
import type { AppContext } from "./app-context.js";
import { keepsRunningInBackground } from "./app-state.js";
import { Background, TRAY_PLACE } from "./background.js";
import { assetsPath, preloadPath } from "./paths.js";

const BACKGROUND_HINT_SHOWN = "background_hint_shown";

/** Brings the main window to the front, restoring it if minimized. Does nothing before the window exists. */
export function showWindow(context: AppContext): void {
  if (!context.mainWindow || context.mainWindow.isDestroyed()) return;

  if (context.mainWindow.isMinimized()) context.mainWindow.restore();
  context.mainWindow.show();
  context.mainWindow.focus();
}

function openPermitInWindow(context: AppContext, permitId: string): void {
  showWindow(context);
  context.mainWindow?.webContents.send("permit:open-details", permitId);
}

/** Turns down every permission request from web content, such as notifications or media. */
export function denyPermissionRequests(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

/** The tray or menu bar icon, whose menu acts on the window, the permit list, and the schedule. Not started yet. */
export function createBackground(context: AppContext): Background {
  return new Background(assetsPath(), {
    showWindow: () => showWindow(context),
    openPermit: (permitId) => openPermitInWindow(context, permitId),
    checkAll: () => {
      if (context.sharing.following) return;

      for (const permit of context.store.listPermits()) context.checks.enqueue(permit.id, "manual");
    },
    setScheduled: (enabled) => {
      context.store.setMonitoring(enabled ? "scheduled" : "manual");
      context.scheduler.settingsChanged();
    },
    quit: () => app.quit(),
  });
}

/** Sets the application menu: the standard app, edit, and window menus on macOS, and none elsewhere. */
export function setApplicationMenu(): void {
  // macOS takes Copy, Paste, and Quit from the application menu, so without one the key and share code fields can't be
  // pasted into. Windows shows no menu bar.
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
      : null,
  );
}

/**
 * Creates the main window, hidden until shown. It can't navigate, open other windows, or attach webviews. Closing it
 * hides it instead when the app keeps running in the background.
 */
export function createMainWindow(context: AppContext): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: "#f6f1eb",
    icon: path.join(assetsPath(), "icon.png"),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.on("focus", () => context.notifier.windowFocused());
  mainWindow.on("close", (event) => {
    if (context.lifecycle.quitting || !keepsRunningInBackground(context)) return;
    event.preventDefault();
    mainWindow.hide();

    if (!context.store.getFlag(BACKGROUND_HINT_SHOWN, false)) {
      context.store.setFlag(BACKGROUND_HINT_SHOWN, true);
      void context.background?.notify({
        title: `Still running in the ${TRAY_PLACE}`,
        body:
          process.platform === "darwin"
            ? "Quit from its menu bar icon or with Command-Q."
            : "Right-click the icon to quit.",
      });
    }
  });

  return mainWindow;
}
