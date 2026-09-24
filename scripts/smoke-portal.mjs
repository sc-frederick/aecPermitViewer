import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const permitNumber = process.argv[2] ?? "HC-BLD-26-0087599";
const port = new EventEmitter();
let settled = false;
const deadline = setTimeout(() => {
  if (!settled) {
    process.stderr.write("Portal smoke check timed out.\n");
    process.exitCode = 1;
  }
}, 45_000);

port.postMessage = (message) => {
  if (settled) return;
  if (message.kind === "observation") {
    const candidate = message.observation.candidates[0];
    if (!candidate) {
      process.stderr.write("No permitted action was offered.\n");
      settled = true;
      process.exitCode = 1;
      clearTimeout(deadline);
      return;
    }
    port.emit("message", { data: {
      kind: "choose", runId: message.runId,
      fingerprint: message.observation.fingerprint,
      candidateId: candidate.id,
    } });
  } else if (message.kind === "verified") {
    settled = true;
    clearTimeout(deadline);
    if (message.displayedNumber !== permitNumber || !message.statusValue.trim()) {
      process.stderr.write("Identity or status verification failed.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ permitNumber: message.displayedNumber,
      statusLabel: message.statusLabel, statusValue: message.statusValue,
      observedAt: message.observedAt, recordUrl: message.recordUrl,
      browserVersion: message.browserVersion }) + "\n");
  } else if (message.kind === "failed") {
    settled = true;
    clearTimeout(deadline);
    process.stderr.write(`Portal smoke check failed: ${message.outcome}.\n`);
    process.exitCode = 1;
  }
};

process.parentPort = port;
process.env.PERMIT_PORTAL_SMOKE = "1";
// Use the staged, hash-checked payload, as the app's check runner does, not Playwright's user cache.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve("vendor/playwright-browsers");
require("../dist/worker.cjs");
port.emit("message", { data: {
  kind: "start", runId: "portal-smoke", permitNumber,
  previousRecordUrl: null,
  browserPath: path.resolve("vendor/playwright-browsers"),
} });
