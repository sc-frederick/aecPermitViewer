import { app, utilityProcess } from "electron";
import path from "node:path";
import type { MainToWorker, WorkerToMain } from "../shared/worker-protocol.js";

export async function runPackagedBrowserSmoke(): Promise<void> {
  const runId = "packaged-browser-smoke";
  const permitNumber = "HC-BLD-26-0087599";
  const browserPath = path.join(process.resourcesPath, "playwright-browsers");
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "PATH"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  const worker = utilityProcess.fork(path.join(__dirname, "worker.cjs"), [], { env: environment, serviceName: "Permit Browser Smoke" });
  let finished = false;
  const finish = (passed: boolean): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    worker.kill();
    app.exit(passed ? 0 : 1);
  };
  const timer = setTimeout(() => finish(false), 45_000);
  worker.on("exit", () => finish(false));
  worker.on("error", () => finish(false));
  worker.on("message", (raw: unknown) => {
    const message = raw as WorkerToMain;
    if (!message || message.runId !== runId) return;
    if (message.kind === "observation") {
      const candidate = message.observation.candidates[0];
      if (!candidate) { finish(false); return; }
      worker.postMessage({ kind: "choose", runId, fingerprint: message.observation.fingerprint,
        candidateId: candidate.id } satisfies MainToWorker);
    } else if (message.kind === "verified") {
      const passed = message.displayedNumber === permitNumber &&
        message.statusLabel === "Record Status:" && message.statusValue.trim().length > 0 &&
        message.recordUrl.startsWith("https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?");
      if (passed) process.stdout.write(`Packaged browser smoke passed (${message.browserVersion}).\n`);
      finish(passed);
    } else if (message.kind === "failed") {
      process.stderr.write(`Packaged browser smoke failed: ${message.outcome}.\n`);
      finish(false);
    }
  });
  worker.postMessage({ kind: "start", runId, jurisdictionId: "hillsborough-county-building", permitNumber,
    previousRecordUrl: null, browserPath } satisfies MainToWorker);
}
