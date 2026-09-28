import { utilityProcess } from "electron";
import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { chooseNavigation, navigationClient, type NavigationDecision } from "./jev.js";
import { parseDisplayedStatus, type ObservationRow, type PermitRow, type RunOutcome } from "../shared/permit.js";
import { workerToMainSchema, type MainToWorker, type WorkerToMain } from "../shared/worker-protocol.js";

export interface CheckResult {
  outcome: RunOutcome;
  observation?: Omit<ObservationRow, "id" | "runId" | "permitId">;
  actionCount: number;
  requestCount: number;
  actualModel: string | null;
  browserVersion: string | null;
}

export interface ActiveCheck {
  result: Promise<CheckResult>;
  closed: Promise<void>;
  cancel: () => void;
}

const MAX_ACTIONS = 20;

const MAX_REQUESTS = 20;

const DEADLINE_MS = 180_000;

/** More offered steps than this means the page isn't one the worker understands. */
const MAX_CANDIDATES = 30;

/** Variables the browser worker needs on Windows. The key and the rest of the app's environment stay out. */
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

export function runCheck(input: {
  runId: string;
  permit: PermitRow;
  key: string;
  browserPath: string;
  cacheRoot: string;
  workerPath: string;
}): ActiveCheck {
  const controller = new AbortController();
  const deadline = Date.now() + DEADLINE_MS;
  let cancel = () => controller.abort();
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const cachePath = path.join(input.cacheRoot, input.runId);
  mkdirSync(cachePath, { recursive: true });

  const result = new Promise<CheckResult>((resolve) => {
    let done = false;
    let exited = false;
    let actionCount = 0;
    let requestCount = 0;
    let actualModel: string | null = null;
    let browserVersion: string | null = null;
    let decisionPending = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const repeated = new Map<string, number>();
    let client: TypeSafeClient | null = null;
    const environment = workerEnvironment(input.browserPath);
    environment.TEMP = cachePath;
    environment.TMP = cachePath;
    let worker: Electron.UtilityProcess;

    try {
      worker = utilityProcess.fork(path.resolve(input.workerPath), [], {
        env: environment,
        serviceName: "Permit Browser",
      });
    } catch {
      rmSync(cachePath, { recursive: true, force: true });
      markClosed();
      resolve({ outcome: "browser_error", actionCount: 0, requestCount: 0,
        actualModel: null, browserVersion: null });

      return;
    }

    const finish = (outcome: RunOutcome, observation?: CheckResult["observation"]) => {
      if (done) return;
      done = true;
      controller.abort();
      clearTimeout(timer);

      if (!exited) {
        try { worker.postMessage({ kind: "cancel", runId: input.runId } satisfies MainToWorker); } catch { /* already exited */ }

        forceKillTimer = setTimeout(() => { worker.kill(); }, 5_000);
        forceKillTimer.unref();
      }

      const result: CheckResult = { outcome, actionCount, requestCount, actualModel, browserVersion };

      if (observation) result.observation = observation;
      resolve(result);
    };

    const timer = setTimeout(() => finish("timeout"), DEADLINE_MS);
    cancel = () => finish("cancelled");
    worker.on("exit", () => {
      exited = true;

      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (!done) finish("browser_error");
      void rm(cachePath, { recursive: true, force: true }).finally(markClosed);
    });
    worker.on("error", () => { if (!done) finish("browser_error"); });
    worker.on("message", (raw) => {
      const message = workerToMainSchema.safeParse(raw);

      if (message.success) void handleMessage(message.data).catch(() => finish("api_unavailable"));
    });

    async function handleMessage(message: WorkerToMain): Promise<void> {
      if (done || message.runId !== input.runId) return;

      switch (message.kind) {
        case "action_count":
          actionCount = message.count;

          if (actionCount >= MAX_ACTIONS) finish("timeout");

          return;
        case "failed":
          finish(message.outcome);

          return;
        case "verified": {
          browserVersion = message.browserVersion;

          const parsed = parseDisplayedStatus({
            jurisdictionId: input.permit.jurisdictionId,
            requestedNumber: input.permit.permitNumber,
            displayedNumber: message.displayedNumber,
            statusLabel: message.statusLabel,
            statusValue: message.statusValue,
            observedAt: message.observedAt,
            recordUrl: message.recordUrl,
          });

          if (parsed._tag === "err") finish(parsed.outcome);
          else finish("success", parsed.value);

          return;
        }

        case "observation": {
          if (decisionPending) return;

          if (requestCount >= MAX_REQUESTS || actionCount >= MAX_ACTIONS || Date.now() >= deadline) {
            finish("timeout");

            return;
          }

          const observation = message.observation;

          if (observation.candidates.length === 0 || observation.candidates.length > MAX_CANDIDATES) {
            finish("unsupported_page");

            return;
          }

          decisionPending = true;
          const [only] = observation.candidates;

          const settled = only && observation.candidates.length === 1 && only.established &&
            !repeated.has(`${observation.fingerprint}:${only.id}`);

          // A lone step the worker's own checks established needs no model call. The worker still revalidates the
          // page before acting, and the repeat and action limits below still apply. If the page hasn't moved since
          // that step, Jev decides instead, so a slow page can still get WAIT.
          const decision: NavigationDecision = settled
            ? { _tag: "chosen", candidateId: only.id, attempts: 0, actualModel: null }
            : await chooseNavigation({
              client: client ??= navigationClient(input.key),
              jurisdictionId: input.permit.jurisdictionId,
              observation,
              requestedNumber: input.permit.permitNumber,
              signal: controller.signal,
              remainingRequests: MAX_REQUESTS - requestCount,
              deadline,
              onAttempt: () => { requestCount += 1; },
            });

          decisionPending = false;

          if (done) return;

          if (decision.actualModel) actualModel = decision.actualModel;

          if (decision._tag === "authentication_error" || decision._tag === "api_unavailable" || decision._tag === "unsupported_page" ||
            decision._tag === "cancelled") {
            finish(decision._tag);

            return;
          }

          // A reply that breaks the service's contract is the service's fault, not the portal's, so it retries like an outage.
          if (decision._tag === "malformed_response") {
            finish("api_unavailable");

            return;
          }

          const pair = `${observation.fingerprint}:${decision._tag === "chosen" ? decision.candidateId : decision._tag}`;
          const times = (repeated.get(pair) ?? 0) + 1;
          repeated.set(pair, times);

          if (times >= 2) {
            finish("unsupported_page");

            return;
          }

          if (decision._tag === "stop") {
            finish("unsupported_page");

            return;
          }

          if (decision._tag === "wait") {
            setTimeout(() => {
              if (!done) worker.postMessage({ kind: "reobserve", runId: input.runId } satisfies MainToWorker);
            }, 800).unref();

            return;
          }

          worker.postMessage({
            kind: "choose",
            runId: input.runId,
            fingerprint: observation.fingerprint,
            candidateId: decision.candidateId,
          } satisfies MainToWorker);

          return;
        }
      }
    }

    worker.postMessage({
      kind: "start",
      runId: input.runId,
      jurisdictionId: input.permit.jurisdictionId,
      permitNumber: input.permit.permitNumber,
      previousRecordUrl: input.permit.lastRecordUrl,
      browserPath: input.browserPath,
    } satisfies MainToWorker);
  });

  return { result, closed, cancel: () => cancel() };
}
