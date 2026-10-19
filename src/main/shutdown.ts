import type { AppContext } from "./app-context.js";
import { databasePath } from "./paths.js";
import { createSharing } from "./sharing-host.js";
import { PermitStore } from "./store.js";

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

export function resumeAfterFailedShutdown(context: AppContext): void {
  context.shuttingDown = false;
  context.checks.restart();
  context.scheduler.start();
  void context.broadcast();
}

export async function reopenAfterFailedShutdown(context: AppContext): Promise<void> {
  context.store = new PermitStore(databasePath());
  context.sharing = createSharing(context);
  await context.sharing.start();
  resumeAfterFailedShutdown(context);
}
