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

export interface Lifecycle {
  quitting: boolean;
  quitAllowed: boolean;
}

export interface Scheduler {
  scheduleDue(): void;
  start(): void;
  stop(): void;
  settingsChanged(): void;
}

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
