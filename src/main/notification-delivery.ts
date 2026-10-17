import type { AppEvent } from "../shared/bridge.js";
import type { CheckEvent } from "./notifications.js";

/** A native notification that the operating system could not display. Contains no permit data. */
export class DesktopNotificationFailed extends Error {
  readonly _tag = "DesktopNotificationFailed" as const;

  constructor(
    /** The platform can't show notifications, showing one failed, or none appeared in time. */
    readonly code: "unsupported" | "failed" | "not_shown",
  ) {
    super("Desktop notification was not shown.");
  }
}

/** Native delivery succeeds only after Electron reports the notification was shown. */
export type DesktopDelivery = { _tag: "shown" } | { _tag: "failed"; error: DesktopNotificationFailed };

/** Current notification preferences and where the user is looking. */
export interface NotificationState {
  statusChanges: boolean;
  failures: boolean;
  /** False where the app doesn't post desktop notifications, so every notice is shown in the window. */
  desktop: boolean;
  windowInFront: boolean;
}

/** Main's notification destinations, kept separate from deciding which events deserve a notice. */
export interface NotificationDelivery {
  state(): NotificationState;
  inApp(notice: AppEvent): void;
  desktop(notice: AppEvent): Promise<DesktopDelivery>;
  failed(error: DesktopNotificationFailed): void;
}

/** Routes notices through the user's settings and keeps a failed desktop notice until the window is in front. */
export class CheckNotifier {
  private keyNoticeShown = false;
  private readonly pending = new Map<string, AppEvent>();

  constructor(private readonly delivery: NotificationDelivery) {}

  /** Lets the next key notice show again; called after a new key or an explicit check. */
  resetKeyNotice(): void {
    this.keyNoticeShown = false;
  }

  /**
   * Delivers a notice if the user's preferences allow it: in the window when it is in front or desktop notices are off,
   * otherwise as a desktop notification. Repeat key notices are dropped until `resetKeyNotice`.
   */
  async announce(event: CheckEvent): Promise<void> {
    const state = this.delivery.state();

    const statusNotice =
      event.kind === "first-status" || event.kind === "status-changed" || event.kind === "review-action";

    if (!(statusNotice ? state.statusChanges : state.failures)) return;

    if (event.kind === "key-needed") {
      if (this.keyNoticeShown) return;
      this.keyNoticeShown = true;
    }

    const notice: AppEvent = { tone: statusNotice ? "info" : "error", title: event.title, body: event.body };

    if (event.permitId) notice.permitId = event.permitId;
    const key = event.permitId ?? event.kind;

    if (state.windowInFront || !state.desktop) {
      this.pending.delete(key);
      this.delivery.inApp(notice);

      return;
    }

    const result = await this.delivery.desktop(notice);

    if (result._tag === "shown") {
      this.pending.delete(key);

      return;
    }

    this.delivery.failed(result.error);

    if (this.delivery.state().windowInFront) {
      this.pending.delete(key);
      this.delivery.inApp(notice);
    } else this.pending.set(key, notice);
  }

  /**
   * Shows the desktop notices that failed while the window was hidden, collapsing several into one summary. Called when
   * the window regains focus.
   */
  windowFocused(): void {
    if (!this.delivery.state().windowInFront || this.pending.size === 0) return;
    const notices = [...this.pending.values()];
    this.pending.clear();
    const first = notices[0];

    if (!first) return;
    this.delivery.inApp(
      notices.length === 1
        ? first
        : {
            tone: "error",
            title: "Desktop notifications could not be shown",
            body: `${notices.length} permits or checks have updates. Review the permit list; check the system notification settings.`,
          },
    );
  }
}
