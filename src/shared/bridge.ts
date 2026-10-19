import type { PermitHistory, PermitRow } from "./permit.js";

export const PREFERENCE_KEYS = [
  "notifyStatusChanges",
  "notifyFailures",
  "runInBackground",
  "openAtLogin",
  "desktopShortcut",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

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

export const DELETE_LOCAL_DATA_CONFIRMATION = "DELETE LOCAL DATA";

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type StoredKeyState = "configured" | "missing" | "unavailable" | "unreadable";

export type KeyState = StoredKeyState | "rejected";

export type UpdateCheck =
  { state: "unavailable" } | { state: "current" } | { state: "available"; version: string; size: number };

export type ShareState =
  | { mode: "off"; available: boolean }
  | { mode: "sharing"; code: string; publishedAt: string | null; problem: string | null }
  | { mode: "following"; publishedAt: string | null; checkedAt: string | null; problem: string | null };

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

export interface AppEvent {
  tone: "info" | "error";
  title: string;
  body: string;
  permitId?: string;
}

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
