import { app } from "electron";
import type { AppContext } from "./app-context.js";
import { getOpenAtLogin } from "./background.js";
import { hasDesktopShortcut, installedApp } from "./squirrel.js";
import { isFailure } from "../shared/outcomes.js";
import { describeCheckTimes, formatCheckTime } from "../shared/schedule.js";
import type { AppSnapshot, KeyState, StoredKeyState } from "../shared/bridge.js";

/** The settings rows behind the preferences stored as flags. */
export const PREF_FLAGS = {
  notifyStatusChanges: "notify_status_changes",
  notifyFailures: "notify_failures",
  runInBackground: "run_in_background",
} as const;

/** Whether closing the window hides it to the tray or menu bar instead of quitting. */
export function keepsRunningInBackground(context: AppContext): boolean {
  return Boolean(context.background?.available) && context.store.getFlag(PREF_FLAGS.runInBackground, true);
}

/** The saved key's state, treating a key-storage failure as storage being unavailable. */
export async function storedKeyState(context: AppContext, operation: string): Promise<StoredKeyState> {
  return context.keys.state().catch((cause: unknown) => {
    context.diagnostics.record(operation, null, cause);

    return "unavailable" as const;
  });
}

/** Why a check someone asked for can't run with the saved key, or null when it can. */
export function keyStateProblem(state: StoredKeyState): string | null {
  switch (state) {
    case "configured":
      return null;
    case "missing":
      return "Add your TypeSafe key in Settings first.";
    case "unreadable":
      return "Your saved key can't be read. Save it again in Settings.";
    case "unavailable":
      return "Key storage isn't available on this computer.";
  }
}

/** The key state shown to the user: the stored state, or `rejected` while the queue is paused on a rejected key. */
function effectiveKeyState(context: AppContext, stored: StoredKeyState): KeyState {
  return stored === "configured" && context.checks.keyPaused ? "rejected" : stored;
}

/**
 * Reads the whole app state. The key state is the only asynchronous read, so it goes first; the revision and everything
 * else are read after it in one turn. A snapshot with a higher revision never holds older permits or settings.
 */
export async function snapshot(context: AppContext): Promise<AppSnapshot> {
  const stored = await storedKeyState(context, "snapshot:key-state");
  context.snapshotRevision += 1;

  return {
    revision: context.snapshotRevision,
    permits: context.sharing.following
      ? [...context.sharing.permits()]
      : context.store.listPermits(context.checks.checkingIds()),
    keyState: effectiveKeyState(context, stored),
    appVersion: app.getVersion(),
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "other",
    monitoring: context.store.getMonitoring(),
    checkTimes: context.store.getCheckTimes().map(formatCheckTime),
    preferences: {
      notifyStatusChanges: context.store.getFlag(PREF_FLAGS.notifyStatusChanges, true),
      notifyFailures: context.store.getFlag(PREF_FLAGS.notifyFailures, true),
      runInBackground: keepsRunningInBackground(context),
      openAtLogin: getOpenAtLogin(),
      desktopShortcut: hasDesktopShortcut(),
      backgroundAvailable: Boolean(context.background?.available),
      installedApp: installedApp(),
      offerDesktopShortcut: context.offerDesktopShortcut,
    },
    share: context.sharing.state(),
  };
}

/** Sends one snapshot to the window and the tray's counts to the tray. Callers go through `AppContext.broadcast`. */
export async function sendSnapshot(context: AppContext): Promise<void> {
  // Every change to this app's list passes through here, so a shared copy follows it.
  context.sharing.listChanged();

  if (!context.mainWindow || context.mainWindow.isDestroyed()) return;

  try {
    const current = await snapshot(context);
    context.background?.update({
      permits: current.permits.length,
      checking: current.permits.filter((permit) => permit.checking).length,
      failing: current.permits.filter((permit) => !permit.checking && isFailure(permit.latestOutcome)).length,
      scheduled: current.monitoring === "scheduled",
      checkTimes: describeCheckTimes(context.store.getCheckTimes()),
    });
    context.mainWindow.webContents.send("permit:snapshot-changed", current);
  } catch (cause) {
    // The next UI request will surface local storage errors through its reply.
    context.diagnostics.record("snapshot:broadcast", null, cause);
  }
}
