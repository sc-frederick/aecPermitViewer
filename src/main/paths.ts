import { app } from "electron";
import path from "node:path";

export function dataRoot(): string {
  const local = process.platform === "win32" ? process.env.LOCALAPPDATA : null;

  return path.join(local || app.getPath("userData"), "PermitMonitorData");
}

export function databasePath(): string {
  return path.join(dataRoot(), "data", "permits.sqlite");
}

export function diagnosticsPath(): string {
  return path.join(dataRoot(), "logs", "diagnostics.jsonl");
}

export function cachePath(): string {
  return path.join(dataRoot(), "cache");
}

export function bundledBrowserPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers")
    : path.join(app.getAppPath(), "vendor", "playwright-browsers");
}

export function workerPath(): string {
  return path.join(__dirname, "worker.cjs");
}

export function preloadPath(): string {
  return path.join(__dirname, "preload.cjs");
}

export function pagePath(): string {
  return path.join(__dirname, "index.html");
}

export function assetsPath(): string {
  return path.join(__dirname, "assets");
}

export function updateScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "authenticode.ps1")
    : path.join(__dirname, "authenticode.ps1");
}

export function updateConfigPath(): string {
  return path.join(__dirname, "update-config.json");
}

export function syncConfigPath(): string {
  return path.join(__dirname, "sync-config.json");
}
