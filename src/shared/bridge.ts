import type { PermitHistory, PermitRow } from "./permit.js";

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

/** The settings the window shows, with what this platform and install allow. */
export interface AppPreferences {
  notifyStatusChanges: boolean;
  notifyFailures: boolean;
  runInBackground: boolean;
  openAtLogin: boolean;
  desktopShortcut: boolean;
  backgroundAvailable: boolean;
  installedApp: boolean;
  offerDesktopShortcut: boolean;
}

/** The text the window sends with `deleteLocalData`; main deletes nothing for any other value. */
export const DELETE_LOCAL_DATA_CONFIRMATION = "DELETE LOCAL DATA";

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

/** Everything the window renders, sent whole from main on each change. */
export interface AppSnapshot {
  revision: number;
  permits: PermitRow[];
  preferences: AppPreferences;
  keyState: KeyState;
  appVersion: string;
  platform: "windows" | "mac" | "other";
  monitoring: "manual" | "scheduled";
  checkTimes: string[];
  share: ShareState;
}

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
  openPortal(permitId: string): Promise<BridgeResult<null>>;
  recordManualStatus(input: { permitId: string; status: string; recordUrl: string }): Promise<BridgeResult<null>>;
  history(permitId: string, before?: string): Promise<BridgeResult<PermitHistory>>;
  saveKey(key: string): Promise<BridgeResult<null>>;
  removeKey(): Promise<BridgeResult<null>>;
  openRecord(permitId: string): Promise<BridgeResult<null>>;
  openObservationRecord(observationId: string): Promise<BridgeResult<null>>;
  removePermit(permitId: string): Promise<BridgeResult<null>>;
  setMonitoring(mode: "manual" | "scheduled"): Promise<BridgeResult<null>>;
  setCheckTimes(times: string[]): Promise<BridgeResult<null>>;
  setPermitMonitoring(permitId: string, enabled: boolean): Promise<BridgeResult<null>>;
  setProjectNumber(permitId: string, projectNumber: string): Promise<BridgeResult<null>>;
  setPreference(key: PreferenceKey, value: boolean): Promise<BridgeResult<null>>;
  checkForUpdate(): Promise<BridgeResult<UpdateCheck>>;
  downloadUpdate(): Promise<BridgeResult<string>>;
  installUpdate(): Promise<BridgeResult<null>>;
  openUpdateDownload(): Promise<BridgeResult<null>>;
  deleteLocalData(confirmation: string): Promise<BridgeResult<null>>;
  startSharing(): Promise<BridgeResult<null>>;
  stopSharing(): Promise<BridgeResult<null>>;
  copyShareCode(): Promise<BridgeResult<null>>;
  follow(code: string): Promise<BridgeResult<null>>;
  stopFollowing(): Promise<BridgeResult<null>>;
  syncShared(): Promise<BridgeResult<null>>;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  onLocalError(callback: (message: string) => void): () => void;
  onOpenDetails(callback: (permitId: string) => void): () => void;
  onAppEvent(callback: (event: AppEvent) => void): () => void;
}
