import type { AppContext } from "./app-context.js";
import { databasePath } from "./paths.js";
import { createSharing } from "./sharing-host.js";
import { PermitStore } from "./store.js";

/**
 * Stops scheduling and checks so local data can be closed for a quit, an update, or a deletion. Resolves false when a
 * check is still running after 10 seconds.
 */
export async function stopChecks(context: AppContext): Promise<boolean> {
  context.shuttingDown = true;
  context.scheduler.stop();

  const completed = await Promise.race([
    context.checks.stop().then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      timer.unref();
    }),
  ]);

  return completed && !context.checks.busy;
}

/** An update or deletion that couldn't go ahead returns to the running app. */
export function resumeAfterFailedShutdown(context: AppContext): void {
  context.shuttingDown = false;
  context.checks.restart();
  context.scheduler.start();
  void context.broadcast();
}

/** An update or deletion that failed after closing the store reopens it, starts sharing over it again, and resumes. */
export async function reopenAfterFailedShutdown(context: AppContext): Promise<void> {
  context.store = new PermitStore(databasePath());
  context.sharing = createSharing(context);
  await context.sharing.start();
  resumeAfterFailedShutdown(context);
}
