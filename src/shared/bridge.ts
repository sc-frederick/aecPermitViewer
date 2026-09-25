import type { AppSnapshot, PermitHistory, PreferenceKey } from "./permit.js";

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type UpdateCheck =
  | { state: "unavailable" }
  | { state: "current" }
  | { state: "available"; version: string; size: number };

export interface AppEvent { tone: "info" | "error"; title: string; body: string; permitId?: string }

export interface PermitBridge {
  snapshot(): Promise<AppSnapshot>;
  addAndCheck(input: { jurisdiction: string; permitNumber: string }): Promise<BridgeResult<string>>;
  checkNow(permitId: string): Promise<BridgeResult<null>>;
  cancel(permitId: string): Promise<BridgeResult<null>>;
  /** Hand-checked permits: opens the portal search and copies the permit number. */
  openPortal(permitId: string): Promise<BridgeResult<null>>;
  /** Hand-checked permits: saves the status the user read, with an optional record link. */
  recordManualStatus(input: { permitId: string; status: string; recordUrl: string }): Promise<BridgeResult<null>>;
  history(permitId: string): Promise<BridgeResult<PermitHistory>>;
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
  deleteLocalData(confirmation: string): Promise<BridgeResult<null>>;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  onLocalError(callback: (message: string) => void): () => void;
  /** A notification or tray action asked to show one permit's details. */
  onOpenDetails(callback: (permitId: string) => void): () => void;
  /** A check result worth mentioning while the window is in front. */
  onAppEvent(callback: (event: AppEvent) => void): () => void;
}
