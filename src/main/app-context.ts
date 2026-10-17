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
  /** Set once a quit begins, so closing the window no longer hides it to the tray. */
  quitting: boolean;
  /** Set once the app's work has stopped and its data is closed, so before-quit lets the quit go ahead. */
  quitAllowed: boolean;
}

/** When scheduled checks run. Created by `createScheduler`. */
export interface Scheduler {
  /** Queues the permits that are due, if scheduled checks may run now. */
  scheduleDue(): void;
  /** Starts checking for due permits every minute and when the computer wakes. Does nothing if already started. */
  start(): void;
  /** Stops the timer and wake listener started by `start`. */
  stop(): void;
  /** A scheduling setting changed: queued scheduled work that no longer qualifies is dropped, and newly due work queued. */
  settingsChanged(): void;
}

/**
 * The services and state main's modules share, created once at startup and passed to each module that needs them.
 * `store` and `sharing` are replaced when a failed update or deletion reopens local data, so modules read them from
 * here at each use and never keep their own reference.
 */
export interface AppContext {
  /** The local database. Replaced when a failed update or deletion reopens it. */
  store: PermitStore;
  /** Sharing over the current store. Replaced along with the store. */
  sharing: Sharing;
  /** Failures the user only sees as a generic message are recorded here, without their messages or any user data. */
  readonly diagnostics: DiagnosticLog;
  readonly keys: KeyStore;
  readonly notifier: CheckNotifier;
  readonly checks: CheckQueue;
  readonly scheduler: Scheduler;
  readonly updates: UpdateManager;
  /** The sharing service this build is configured for, or null when it has none. */
  readonly shareService: ShareService | null;
  /** Resolves true once the bundled browser matches its manifest. No check launches it before then. */
  readonly browserVerified: Promise<boolean>;
  readonly lifecycle: Lifecycle;
  /** The main window, once created. */
  mainWindow: BrowserWindow | null;
  /** The tray or menu bar icon, once created. */
  background: Background | null;
  /** Set while checks are stopped for an update or deletion; no scheduled or new check starts meanwhile. */
  shuttingDown: boolean;
  /** Squirrel has no installer pages, so the first launch after installing asks about the desktop shortcut instead. */
  offerDesktopShortcut: boolean;
  /** The revision of the last snapshot read. See `AppSnapshot.revision`. */
  snapshotRevision: number;
  /**
   * Sends the current state to the window and tray. Calls made in the same turn (for example, every permit queued by
   * one scheduled run) share a single snapshot taken just after that turn. Snapshots go out one at a time, so an older
   * one can never be sent after a newer one.
   */
  broadcast(): Promise<void>;
}
