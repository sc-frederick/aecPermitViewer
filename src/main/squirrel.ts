import { app } from "electron";
import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Squirrel.Windows names shortcuts after the package title. */
const SHORTCUT_FILE = "Permit Monitor.lnk";

/** The first launch after a fresh install, started by Setup.exe once its work is done. */
export const FIRST_RUN_ARG = "--squirrel-firstrun";

/** Shortcuts, start at sign-in, and Squirrel events only exist for the installed Windows app. */
export function installedApp(): boolean {
  return process.platform === "win32" && app.isPackaged;
}

/** Squirrel's Update.exe sits in the install root, one level above the versioned app folder. */
export function updateExePath(): string {
  return path.resolve(path.dirname(process.execPath), "..", "Update.exe");
}

function shortcutArgs(action: "create" | "remove", locations: string): string[] {
  return [`--${action}Shortcut=${path.basename(process.execPath)}`, `--shortcut-locations=${locations}`];
}

/** Squirrel shows its own icon file in Installed apps. Left alone, it downloads Electron's icon there. */
function installAppIcon(): void {
  try {
    copyFileSync(path.join(process.resourcesPath, "icon.ico"), path.join(path.dirname(updateExePath()), "app.ico"));
  } catch {
    /* Installed apps keeps the previous icon */
  }
}

/**
 * Handles the install, update, and uninstall events Squirrel runs the app for, and returns true when this launch was
 * one of them. Squirrel waits up to 15 seconds and then carries on, so failures are left behind rather than reported.
 *
 * A new install gets a Start menu shortcut only; that shortcut carries the notification identity. The desktop shortcut
 * is the user's choice (see {@link setDesktopShortcut}), so updates leave it as it is.
 */
export function handleSquirrelEvent(argv: readonly string[], beforeUninstall: () => void): boolean {
  if (process.platform !== "win32") return false;
  const run = (args: string[]) => spawnSync(updateExePath(), args, { timeout: 10_000, windowsHide: true });

  switch (argv[1]) {
    case "--squirrel-install":
    case "--squirrel-updated":
      run(shortcutArgs("create", "StartMenu"));
      installAppIcon();

      return true;
    case "--squirrel-uninstall":
      try {
        beforeUninstall();
      } catch {
        /* the uninstaller continues regardless */
      }

      run(shortcutArgs("remove", "Desktop,StartMenu"));

      return true;
    case "--squirrel-obsolete":
      return true;
    default:
      return false;
  }
}

/** Whether the installed Windows app has its desktop shortcut; always false elsewhere. */
export function hasDesktopShortcut(): boolean {
  return installedApp() && existsSync(path.join(app.getPath("desktop"), SHORTCUT_FILE));
}

/** Adds or removes the desktop shortcut through Update.exe, so it matches the one Squirrel would make. */
export async function setDesktopShortcut(enabled: boolean): Promise<void> {
  if (!installedApp()) return;
  await execFileAsync(updateExePath(), shortcutArgs(enabled ? "create" : "remove", "Desktop"), {
    timeout: 15_000,
    windowsHide: true,
  });
}
