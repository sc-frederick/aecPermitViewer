import { app } from "electron";
import path from "node:path";

/**
 * The private folder an unpackaged build runs in when PERMIT_MONITOR_DATA_DIR names one, as benchmarks do; null
 * otherwise. Packaged builds ignore the variable. An isolated run keeps all of its data, Electron's profile, and the
 * single-instance lock there, and never stores a key, contacts the sharing service, or touches the user's own copy.
 */
export function isolatedDataDirectory(): string | null {
  const directory = app.isPackaged ? "" : (process.env.PERMIT_MONITOR_DATA_DIR?.trim() ?? "");

  return directory ? path.resolve(directory) : null;
}

/** The folder holding the database, logs, saved key, browser cache, and update downloads. Delete local data removes it. */
export function dataRoot(): string {
  const isolated = isolatedDataDirectory();

  if (isolated) return path.join(isolated, "PermitMonitorData");
  const local = process.platform === "win32" ? process.env.LOCALAPPDATA : null;

  return path.join(local || app.getPath("userData"), "PermitMonitorData");
}

/** The SQLite database of permits, runs, and settings. */
export function databasePath(): string {
  return path.join(dataRoot(), "data", "permits.sqlite");
}

/** The diagnostics log. */
export function diagnosticsPath(): string {
  return path.join(dataRoot(), "logs", "diagnostics.jsonl");
}

/** Where browser checks keep their cache. */
export function cachePath(): string {
  return path.join(dataRoot(), "cache");
}

/** The bundled Chromium: in the app's resources once packaged, staged under vendor/ in development. */
export function bundledBrowserPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers")
    : path.join(app.getAppPath(), "vendor", "playwright-browsers");
}

/** The utility-process script that drives the browser. */
export function workerPath(): string {
  return path.join(__dirname, "worker.cjs");
}

/** The main window's preload script. */
export function preloadPath(): string {
  return path.join(__dirname, "preload.cjs");
}

/** The main window's page. Only requests from this page are answered. */
export function pagePath(): string {
  return path.join(__dirname, "index.html");
}

/** Icons for the window, tray, and notifications. */
export function assetsPath(): string {
  return path.join(__dirname, "assets");
}

/** The script that checks an update installer's Authenticode signature: in the app's resources once packaged. */
export function updateScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "authenticode.ps1")
    : path.join(__dirname, "authenticode.ps1");
}

/** The update feed settings written by scripts/build.mjs. */
export function updateConfigPath(): string {
  return path.join(__dirname, "update-config.json");
}

/** The sharing service settings written by scripts/build.mjs. */
export function syncConfigPath(): string {
  return path.join(__dirname, "sync-config.json");
}
