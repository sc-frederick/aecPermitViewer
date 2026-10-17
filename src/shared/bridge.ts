import type { AppSnapshot, PermitHistory } from "./permit.js";

/** Preferences the window can toggle. Listed here so the renderer can validate them without bundling zod. */
export const PREFERENCE_KEYS = [
  "notifyStatusChanges",
  "notifyFailures",
  "runInBackground",
  "openAtLogin",
  "desktopShortcut",
] as const;

/** One of the window's preference toggles. */
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** An IPC call's result. Failures carry a message safe to show the user; details stay in main. */
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What local key storage knows about the saved TypeSafe key, without asking the service:
 * - `configured`: a key is saved, and the last attempt to read it (if any) succeeded.
 * - `missing`: no key is saved.
 * - `unavailable`: this computer can't store a key.
 * - `unreadable`: a key is saved, but the last attempt to read or decrypt it failed.
 */
export type StoredKeyState = "configured" | "missing" | "unavailable" | "unreadable";

/**
 * The key state the window shows: the stored states plus `rejected`, meaning the service turned down the saved key.
 * Every state but `configured` pauses scheduled checks.
 */
export type KeyState = StoredKeyState | "rejected";

/** A manual update check: no feed configured (`unavailable`), up to date, or a verified newer release. */
export type UpdateCheck =
  { state: "unavailable" } | { state: "current" } | { state: "available"; version: string; size: number };

/**
 * Whether this app shares its list or follows someone else's:
 * - `off`: neither. `available` is false when this build has no sharing service.
 * - `sharing`: others can follow this app's list with `code`. `publishedAt` is when the service last accepted it.
 * - `following`: the window shows another app's list, read-only. `publishedAt` is when that app last sent it, and
 *   `checkedAt` when this app last heard from the service.
 * `problem` says why the latest publication or fetch failed, until one succeeds.
 */
export type ShareState =
  | { mode: "off"; available: boolean }
  | { mode: "sharing"; code: string; publishedAt: string | null; problem: string | null }
  | { mode: "following"; publishedAt: string | null; checkedAt: string | null; problem: string | null };

/** A check result shown in the window while it is in front; `permitId` links it to that permit's details. */
export interface AppEvent {
  tone: "info" | "error";
  title: string;
  body: string;
  permitId?: string;
}

/**
 * The API the preload script exposes to the renderer. Every input is parsed again in main; the renderer is not trusted
 * with keys or file paths. Subscriptions return a function that removes the listener.
 */
export interface PermitBridge {
  snapshot(): Promise<AppSnapshot>;
  addAndCheck(input: { jurisdiction: string; permitNumber: string }): Promise<BridgeResult<string>>;
  checkNow(permitId: string): Promise<BridgeResult<null>>;
  cancel(permitId: string): Promise<BridgeResult<null>>;
  /** Hand-checked permits: opens the portal search and copies the permit number. */
  openPortal(permitId: string): Promise<BridgeResult<null>>;
  /** Hand-checked permits: saves the status the user read, with an optional record link. */
  recordManualStatus(input: { permitId: string; status: string; recordUrl: string }): Promise<BridgeResult<null>>;
  /** Reads one page of daily history; the reply's `nextBefore` is the cursor for older entries. */
  history(permitId: string, before?: string): Promise<BridgeResult<PermitHistory>>;
  /** Sends the key to main once for encryption; it is never returned to the window. */
  saveKey(key: string): Promise<BridgeResult<null>>;
  removeKey(): Promise<BridgeResult<null>>;
  openRecord(permitId: string): Promise<BridgeResult<null>>;
  openObservationRecord(observationId: string): Promise<BridgeResult<null>>;
  removePermit(permitId: string): Promise<BridgeResult<null>>;
  setMonitoring(mode: "manual" | "scheduled"): Promise<BridgeResult<null>>;
  /** Replaces the daily check times ("HH:MM", 1–8 of them). */
  setCheckTimes(times: string[]): Promise<BridgeResult<null>>;
  setPermitMonitoring(permitId: string, enabled: boolean): Promise<BridgeResult<null>>;
  /** Sets the permit's project number; an empty string clears it. */
  setProjectNumber(permitId: string, projectNumber: string): Promise<BridgeResult<null>>;
  setPreference(key: PreferenceKey, value: boolean): Promise<BridgeResult<null>>;
  checkForUpdate(): Promise<BridgeResult<UpdateCheck>>;
  downloadUpdate(): Promise<BridgeResult<string>>;
  installUpdate(): Promise<BridgeResult<null>>;
  /** macOS: opens the page with the newest Mac download in the browser. */
  openUpdateDownload(): Promise<BridgeResult<null>>;
  deleteLocalData(confirmation: string): Promise<BridgeResult<null>>;
  /** Starts sharing this app's list. The share code arrives in the next snapshot's `share` state. */
  startSharing(): Promise<BridgeResult<null>>;
  /** Stops sharing and deletes the shared copy, so the code stops working. */
  stopSharing(): Promise<BridgeResult<null>>;
  /** Copies the share code to the clipboard. */
  copyShareCode(): Promise<BridgeResult<null>>;
  /** Shows the list a share code opens, read-only, in place of this app's own. */
  follow(code: string): Promise<BridgeResult<null>>;
  /** Goes back to this app's own list. */
  stopFollowing(): Promise<BridgeResult<null>>;
  /** Sends the shared list now, or asks for a newer followed list now. */
  syncShared(): Promise<BridgeResult<null>>;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  onLocalError(callback: (message: string) => void): () => void;
  /** A notification or tray action asked to show one permit's details. */
  onOpenDetails(callback: (permitId: string) => void): () => void;
  /** A check result worth mentioning while the window is in front. */
  onAppEvent(callback: (event: AppEvent) => void): () => void;
}
