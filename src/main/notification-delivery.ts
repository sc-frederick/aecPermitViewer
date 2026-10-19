import type { AppEvent } from "../shared/bridge.js";
import type { CheckEvent } from "./notifications.js";

export class DesktopNotificationFailed extends Error {
  readonly _tag = "DesktopNotificationFailed" as const;

  constructor(readonly code: "unsupported" | "failed" | "not_shown") {
    super("Desktop notification was not shown.");
  }
}

export type DesktopDelivery = { _tag: "shown" } | { _tag: "failed"; error: DesktopNotificationFailed };

export interface NotificationState {
  statusChanges: boolean;
  failures: boolean;
  desktop: boolean;
  windowInFront: boolean;
}

export interface NotificationDelivery {
  state(): NotificationState;
  inApp(notice: AppEvent): void;
  desktop(notice: AppEvent): Promise<DesktopDelivery>;
  failed(error: DesktopNotificationFailed): void;
}

export class CheckNotifier {
  private keyNoticeShown = false;
  private readonly pending = new Map<string, AppEvent>();

  constructor(private readonly delivery: NotificationDelivery) {}

  resetKeyNotice(): void {
    this.keyNoticeShown = false;
  }

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
