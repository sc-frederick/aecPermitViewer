import { app } from "electron";
import type { AppContext } from "./app-context.js";
import { runCheck, type ActiveCheck } from "./check-runner.js";
import { CheckQueue, type StartedCheck } from "./check-queue.js";
import { NAVIGATION_MODEL } from "./jev.js";
import { keyNotice, recordCheckEvent } from "./notifications.js";
import { announce } from "./notifier.js";
import { bundledBrowserPath, cachePath, workerPath } from "./paths.js";
import { scheduledEligible } from "./scheduler.js";
import type { PermitStore } from "./store.js";
import { startUtilityWorker } from "./utility-worker.js";
import { checkScope, getAutomatedJurisdiction } from "../shared/jurisdictions.js";
import type { RunOutcome } from "../shared/permit.js";
import { nextSlotAfter } from "../shared/schedule.js";

/** The installed Playwright release, recorded with each run. scripts/build.mjs fills it in from playwright's package. */
declare const PLAYWRIGHT_VERSION: string;

/** Records the result and, when it changes what the user knows, tells them. */
function finishAndAnnounce(context: AppContext, input: Parameters<PermitStore["finishRun"]>[0]): void {
  const event = recordCheckEvent(context.store, input);

  // The queue announces current-key rejection after checking its generation; obsolete checks stay quiet.
  if (event && input.outcome !== "authentication_error") announce(context, event);
}

/** The portal pacing scope for a permit. Hand-checked permits and unsupported jurisdictions have none, so they're never queued. */
function permitScope(context: AppContext, permitId: string): string | null {
  const permit = context.store.getPermit(permitId);
  const profile = permit ? getAutomatedJurisdiction(permit.jurisdictionId) : null;

  return profile ? checkScope(profile) : null;
}

/**
 * Runs one browser check and records its result. `finished` resolves null when no run was recorded, including when the
 * queue stopped wanting the check while the browser payload was being verified.
 */
function startCheck(context: AppContext, permitId: string, key: string, stillWanted: () => boolean): StartedCheck {
  let cancelled = false;
  let running: ActiveCheck | null = null;

  const finished = (async (): Promise<RunOutcome | null> => {
    const permit = context.store.getPermit(permitId);

    if (!permit || !(await context.browserVerified) || cancelled || context.shuttingDown) return null;

    // Verification can take a while; scheduled work that stopped qualifying meanwhile doesn't start.
    if (!stillWanted()) return null;

    const runId = context.store.startRun({
      permitId,
      appVersion: app.getVersion(),
      playwrightVersion: PLAYWRIGHT_VERSION,
      requestedModel: NAVIGATION_MODEL.model,
      promptVersion: NAVIGATION_MODEL.promptVersion,
    });

    try {
      running = runCheck({
        runId,
        permit,
        key,
        browserPath: bundledBrowserPath(),
        cacheRoot: cachePath(),
        startWorker: (environment) => startUtilityWorker(workerPath(), environment),
        report: (operation, cause) => context.diagnostics.record(`check:${operation}`, runId, cause),
      });
    } catch (cause) {
      context.diagnostics.record("check:create-cache", runId, cause);
      finishAndAnnounce(context, {
        runId,
        permitId,
        outcome: "browser_error",
        actionCount: 0,
        requestCount: 0,
        actualModel: null,
        browserVersion: null,
      });

      return "browser_error";
    }

    if (cancelled) running.cancel();
    // The row already shows checking, but an open history now has a started run to show.
    void context.broadcast();
    const result = await running.result;
    await running.closed;
    finishAndAnnounce(context, { runId, permitId, ...result });

    return result.outcome;
  })();

  return {
    finished,
    cancel: () => {
      cancelled = true;
      running?.cancel();
    },
  };
}

/** The check queue, running checks against the current store with the saved key. */
export function createQueue(context: AppContext): CheckQueue {
  return new CheckQueue({
    scopeOf: (permitId) => permitScope(context, permitId),
    scheduledEligible: (permitId) => scheduledEligible(context, permitId),
    readKey: () => context.keys.read(),
    start: (permitId, key, stillWanted) => startCheck(context, permitId, key, stillWanted),
    defer: (permitId) => context.store.deferDue(permitId, nextSlotAfter(new Date(), context.store.getCheckTimes())),
    keyUnavailable: (problem, requested) => {
      // Someone who asked for a check hears why it didn't run, even after the first notice.
      if (requested) context.notifier.resetKeyNotice();

      announce(context, keyNotice(problem));
    },
    saveFailed: () => {
      // Persistence failures cannot be represented as a portal status.
      if (context.mainWindow && !context.mainWindow.isDestroyed())
        context.mainWindow.webContents.send("permit:local-error", "Couldn't save locally. Restart the app.");
    },
    changed: () => {
      void context.broadcast();
    },
  });
}
