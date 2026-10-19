import type { AppContext } from "./app-context.js";
import { PREF_FLAGS } from "./app-state.js";
import { desktopPlatform } from "./background.js";
import { CheckNotifier, DesktopNotificationFailed } from "./notification-delivery.js";
import type { CheckEvent } from "./notifications.js";

export function createNotifier(context: AppContext): CheckNotifier {
  return new CheckNotifier({
    state: () => ({
      statusChanges: context.store.getFlag(PREF_FLAGS.notifyStatusChanges, true),
      failures: context.store.getFlag(PREF_FLAGS.notifyFailures, true),
      desktop: desktopPlatform(),
      windowInFront: Boolean(
        context.mainWindow &&
        !context.mainWindow.isDestroyed() &&
        context.mainWindow.isVisible() &&
        context.mainWindow.isFocused(),
      ),
    }),
    inApp: (notice) => {
      if (context.mainWindow && !context.mainWindow.isDestroyed())
        context.mainWindow.webContents.send("permit:app-event", notice);
    },
    desktop: (notice) =>
      context.background?.notify(notice) ??
      Promise.resolve({ _tag: "failed", error: new DesktopNotificationFailed("unsupported") }),
    failed: (error) => context.diagnostics.record("notification:desktop", null, error),
  });
}

export function announce(context: AppContext, event: CheckEvent): void {
  void context.notifier
    .announce(event)
    .catch((cause: unknown) => context.diagnostics.record("notification:deliver", null, cause));
}
