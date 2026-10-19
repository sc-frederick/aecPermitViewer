import { powerMonitor } from "electron";
import type { AppContext, Scheduler } from "./app-context.js";
import { withinCheckWindow } from "../shared/schedule.js";

/** Whether a scheduled check may start now: scheduling on, inside the check window, and the permit included. */
export function scheduledEligible(context: AppContext, permitId: string): boolean {
  if (
    context.shuttingDown ||
    context.sharing.following ||
    context.store.getMonitoring() !== "scheduled" ||
    !withinCheckWindow(new Date(), context.store.getCheckTimes())
  )
    return false;

  return context.store.getPermit(permitId)?.monitoringEnabled === true;
}

/** The scheduler for this app: it queues due permits each minute and on wake while scheduled monitoring is on. */
export function createScheduler(context: AppContext): Scheduler {
  let schedulerTimer: NodeJS.Timeout | null = null;

  const scheduleDue = (): void => {
    if (
      context.shuttingDown ||
      context.sharing.following ||
      context.checks.keyPaused ||
      context.store.getMonitoring() !== "scheduled"
    )
      return;
    const now = new Date();

    if (!withinCheckWindow(now, context.store.getCheckTimes())) return;

    for (const id of context.store.duePermitIds(now.toISOString())) context.checks.enqueue(id, "scheduled");
  };

  return {
    scheduleDue,
    start: () => {
      if (schedulerTimer) return;
      schedulerTimer = setInterval(scheduleDue, 60_000);
      schedulerTimer.unref();
      powerMonitor.on("resume", scheduleDue);
    },
    stop: () => {
      if (schedulerTimer) clearInterval(schedulerTimer);
      schedulerTimer = null;
      powerMonitor.off("resume", scheduleDue);
    },
    settingsChanged: () => {
      context.checks.prune();
      scheduleDue();
      void context.broadcast();
    },
  };
}
