import type { BrowserWindow } from "electron";
import type { Background } from "./background.js";
import type { CheckQueue } from "./check-queue.js";
import type { DiagnosticLog } from "./diagnostics.js";
import type { KeyStore } from "./key-store.js";
import type { CheckNotifier } from "./notification-delivery.js";
import type { ShareService } from "./share-service.js";
import type { Sharing } from "./sharing.js";
import type { PermitStore } from "./store.js";
import type { UpdateManager } from "./updater.js";

/** Quit state shared by the before-quit handler, the window, and the requests that end the app themselves. */
export interface Lifecycle {
  quitting: boolean;
  quitAllowed: boolean;
}

/** When scheduled checks run. Created by `createScheduler`. */
export interface Scheduler {
  scheduleDue(): void;
  start(): void;
  stop(): void;
  settingsChanged(): void;
}

/**
 * The services and state main's modules share, created once at startup and passed to each module that needs them.
 * `store` and `sharing` are replaced when a failed update or deletion reopens local data, so modules read them from
 * here at each use and never keep their own reference.
 */
export interface AppContext {
  store: PermitStore;
  sharing: Sharing;
  readonly diagnostics: DiagnosticLog;
  readonly keys: KeyStore;
  readonly notifier: CheckNotifier;
  readonly checks: CheckQueue;
  readonly scheduler: Scheduler;
  readonly updates: UpdateManager;
  readonly shareService: ShareService | null;
  readonly browserVerified: Promise<boolean>;
  readonly lifecycle: Lifecycle;
  mainWindow: BrowserWindow | null;
  background: Background | null;
  shuttingDown: boolean;
  offerDesktopShortcut: boolean;
  snapshotRevision: number;
  broadcast(): Promise<void>;
}
