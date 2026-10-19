import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { chooseNavigation, navigationClient, type NavigationDecision } from "./jev.js";
import { parseDisplayedStatus, type ObservationRow, type PermitRow, type RunOutcome } from "../shared/permit.js";
import type { MainToWorker, WorkerToMain } from "../shared/worker-protocol.js";

/** A status verified on the permit's record page, ready to save with its run. */
export type VerifiedObservation = Omit<ObservationRow, "id" | "runId" | "permitId">;

/** How a check ended: only a success carries an observation, and every success does. */
export type CheckEnding =
  { outcome: "success"; observation: VerifiedObservation } | { outcome: Exclude<RunOutcome, "success"> };

/** A finished check: how it ended, and what it cost. */
export type CheckResult = CheckEnding & {
  actionCount: number;
  requestCount: number;
  actualModel: string | null;
  browserVersion: string | null;
};

/** A check under way. `cancel` ends it as cancelled unless it has already ended. */
export interface ActiveCheck {
  result: Promise<CheckResult>;
  closed: Promise<void>;
  cancel: () => void;
}

/** A started browser worker process, as a check drives it. The adapter parses what the process sends before delivering it. */
export interface CheckWorker {
  send(message: MainToWorker): void;
  kill(): void;
  onMessage(listener: (message: WorkerToMain) => void): void;
  onExit(listener: () => void): void;
  onError(listener: () => void): void;
}

/** The started worker, or why its process couldn't be created. */
export type WorkerStart = { _tag: "started"; worker: CheckWorker } | { _tag: "failed"; cause: unknown };

/** Local steps of a check whose failure is reported for diagnosis. */
export type CheckOperation = "start-worker" | "handle-message" | "cache-cleanup";

/**
 * Receives a check's local failures, which the user only sees as the check's outcome. It must not throw; the check
 * settles the same way whether or not the report was kept.
 */
export type CheckFailureReport = (operation: CheckOperation, cause: unknown) => void;

const MAX_ACTIONS = 20;

const MAX_REQUESTS = 20;

const DEADLINE_MS = 180_000;

const MAX_CANDIDATES = 30;

const MAX_SETTLE_OBSERVATIONS = 4;

const SETTLE_DELAY_MS = 800;

const WORKER_ENVIRONMENT = ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "PATH"] as const;

/** The environment a browser worker starts with: the allow-listed variables and the bundled browser's location. */
export function workerEnvironment(browserPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const name of WORKER_ENVIRONMENT) {
    if (process.env[name]) environment[name] = process.env[name];
  }

  environment.PLAYWRIGHT_BROWSERS_PATH = browserPath;

  return environment;
}

/**
 * Starts a browser check for one permit in its own worker process and cache folder. `result` settles once the check has
 * an outcome. `closed` settles once the worker has exited and its cache folder is removed, or reported as left behind.
 * Throws only when the cache folder can't be created, before anything has started.
 */
export function runCheck(input: {
  runId: string;
  permit: PermitRow;
  key: string;
  browserPath: string;
  cacheRoot: string;
  startWorker: (environment: NodeJS.ProcessEnv) => WorkerStart;
  report: CheckFailureReport;
  removeCache?: ((cachePath: string) => Promise<void>) | undefined;
}): ActiveCheck {
  const controller = new AbortController();
  const deadline = Date.now() + DEADLINE_MS;
  let cancel = () => controller.abort();
  let markClosed: () => void = () => undefined;

  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const cachePath = path.join(input.cacheRoot, input.runId);
  mkdirSync(cachePath, { recursive: true });

  const removeCache = () => {
    void (input.removeCache?.(cachePath) ?? rm(cachePath, { recursive: true, force: true })).then(
      markClosed,
      (cause: unknown) => {
        markClosed();
        input.report("cache-cleanup", cause);
      },
    );
  };

  const result = new Promise<CheckResult>((resolve) => {
    let done = false;
    let exited = false;
    let actionCount = 0;
    let requestCount = 0;
    let actualModel: string | null = null;
    let browserVersion: string | null = null;
    let decisionPending = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    const repeated = new Map<string, number>();
    const settleAttempts = new Map<string, number>();
    let client: TypeSafeClient | null = null;
    const environment = workerEnvironment(input.browserPath);
    environment.TEMP = cachePath;
    environment.TMP = cachePath;
    const started = input.startWorker(environment);

    if (started._tag === "failed") {
      input.report("start-worker", started.cause);
      removeCache();
      resolve({ outcome: "browser_error", actionCount: 0, requestCount: 0, actualModel: null, browserVersion: null });

      return;
    }

    const worker = started.worker;

    const finish = (ending: CheckEnding) => {
      if (done) return;
      done = true;
      controller.abort();
      clearTimeout(timer);

      if (settleTimer) clearTimeout(settleTimer);

      if (!exited) {
        try {
          worker.send({ kind: "cancel", runId: input.runId });
        } catch {}

        forceKillTimer = setTimeout(() => {
          worker.kill();
        }, 5_000);
        forceKillTimer.unref();
      }

      resolve({ ...ending, actionCount, requestCount, actualModel, browserVersion });
    };

    const timer = setTimeout(() => finish({ outcome: "timeout" }), DEADLINE_MS);
    cancel = () => finish({ outcome: "cancelled" });
    worker.onExit(() => {
      exited = true;

      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (!done) finish({ outcome: "browser_error" });
      removeCache();
    });
    worker.onError(() => {
      if (!done) finish({ outcome: "browser_error" });
    });

    const failLocally = (cause: unknown) => {
      finish({ outcome: "browser_error" });
      input.report("handle-message", cause);
    };

    const sendOrFail = (message: MainToWorker) => {
      try {
        worker.send(message);
      } catch (cause) {
        failLocally(cause);
      }
    };

    const reobserveAfterSettling = () => {
      settleTimer = setTimeout(() => {
        settleTimer = null;

        if (!done) sendOrFail({ kind: "reobserve", runId: input.runId });
      }, SETTLE_DELAY_MS);
      settleTimer.unref();
    };

    worker.onMessage((message) => {
      void handleMessage(message).catch(failLocally);
    });

    async function handleMessage(message: WorkerToMain): Promise<void> {
      if (done || message.runId !== input.runId) return;

      if (Date.now() >= deadline) {
        finish({ outcome: "timeout" });

        return;
      }

      switch (message.kind) {
        case "action_count":
          actionCount = message.count;

          if (actionCount > MAX_ACTIONS) finish({ outcome: "timeout" });

          return;
        case "failed":
          finish({ outcome: message.outcome });

          return;
        case "verified": {
          browserVersion = message.browserVersion;

          const parsed = parseDisplayedStatus({
            jurisdictionId: input.permit.jurisdictionId,
            requestedNumber: input.permit.permitNumber,
            displayedNumber: message.displayedNumber,
            statusLabel: message.statusLabel,
            statusValue: message.statusValue,
            reviews: message.reviews,
            observedAt: message.observedAt,
            recordUrl: message.recordUrl,
          });

          if (parsed._tag === "err") finish({ outcome: parsed.outcome });
          else finish({ outcome: "success", observation: parsed.value });

          return;
        }

        case "observation": {
          if (decisionPending) return;

          if (requestCount >= MAX_REQUESTS || actionCount >= MAX_ACTIONS || Date.now() >= deadline) {
            finish({ outcome: "timeout" });

            return;
          }

          const observation = message.observation;

          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }

          if (observation.candidates.length === 0 || observation.candidates.length > MAX_CANDIDATES) {
            finish({ outcome: "unsupported_page" });

            return;
          }

          const [only] = observation.candidates;

          const established = only && observation.candidates.length === 1 && only.established;
          const establishedPair = only ? `${observation.fingerprint}:${only.id}` : "";

          if (established && repeated.has(establishedPair)) {
            const attempts = settleAttempts.get(establishedPair) ?? 0;

            if (attempts >= MAX_SETTLE_OBSERVATIONS) finish({ outcome: "unsupported_page" });
            else {
              settleAttempts.set(establishedPair, attempts + 1);
              reobserveAfterSettling();
            }

            return;
          }

          decisionPending = true;

          const decision: NavigationDecision = established
            ? { _tag: "chosen", candidateId: only.id, attempts: 0, actualModel: null }
            : await chooseNavigation({
                client: (client ??= navigationClient(input.key)),
                jurisdictionId: input.permit.jurisdictionId,
                observation,
                requestedNumber: input.permit.permitNumber,
                signal: controller.signal,
                remainingRequests: MAX_REQUESTS - requestCount,
                deadline,
                onAttempt: () => {
                  requestCount += 1;
                },
              });

          decisionPending = false;

          if (done) return;

          if (decision.actualModel) actualModel = decision.actualModel;

          if (
            decision._tag === "authentication_error" ||
            decision._tag === "api_unavailable" ||
            decision._tag === "unsupported_page" ||
            decision._tag === "cancelled"
          ) {
            finish({ outcome: decision._tag });

            return;
          }

          if (decision._tag === "malformed_response") {
            finish({ outcome: "api_unavailable" });

            return;
          }

          const pair = `${observation.fingerprint}:${decision._tag === "chosen" ? decision.candidateId : decision._tag}`;
          const times = (repeated.get(pair) ?? 0) + 1;
          repeated.set(pair, times);

          if (times >= 2) {
            finish({ outcome: "unsupported_page" });

            return;
          }

          if (decision._tag === "stop") {
            finish({ outcome: "unsupported_page" });

            return;
          }

          if (decision._tag === "wait") {
            reobserveAfterSettling();

            return;
          }

          sendOrFail({
            kind: "choose",
            runId: input.runId,
            fingerprint: observation.fingerprint,
            candidateId: decision.candidateId,
          });

          return;
        }
      }
    }

    sendOrFail({
      kind: "start",
      runId: input.runId,
      jurisdictionId: input.permit.jurisdictionId,
      permitNumber: input.permit.permitNumber,
      previousRecordUrl: input.permit.lastRecordUrl,
      browserPath: input.browserPath,
    });
  });

  return { result, closed, cancel: () => cancel() };
}
