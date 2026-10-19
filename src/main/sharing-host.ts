import type { AppContext } from "./app-context.js";
import { describeSharedUpdate } from "./notifications.js";
import { announce } from "./notifier.js";
import { Sharing } from "./sharing.js";

export function createSharing(context: AppContext): Sharing {
  return new Sharing(context.store, context.shareService, {
    changed: () => {
      void context.broadcast();
    },
    checking: () => context.checks.checkingIds().size > 0,
    listUpdated: (before, after) => {
      if (!before) return;

      for (const event of describeSharedUpdate(before.permits, after.permits)) announce(context, event);
    },
    report: (operation, cause) => context.diagnostics.record(operation, null, cause),
  });
}
