import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const permitNumber = process.argv[2] ?? "HC-BLD-26-0087599";
const jurisdictionId = process.argv[3] ?? "hillsborough-county-building";
const sameNumber = (displayed) => {
  if (jurisdictionId !== "st-petersburg-building") return displayed === permitNumber;
  const requested = /^(\d{2})\s*-\s*(\d{1,8})$/.exec(permitNumber);
  const shown = /^(\d{2})\s*-\s*(\d{1,8})$/.exec(displayed);
  return Boolean(requested && shown && requested[1] === shown[1] && Number(requested[2]) === Number(shown[2]));
};
const port = new EventEmitter();
let settled = false;
let actions = 0;
const deadline = setTimeout(() => {
  if (!settled) {
    settled = true;
    process.stderr.write("Portal smoke check timed out.\n");
    process.exitCode = 1;
    port.emit("message", { data: { kind: "cancel", runId: "portal-smoke" } });
  }
}, 45_000);

port.postMessage = (message) => {
  if (settled) return;
  if (message.kind === "observation") {
    actions += 1;
    if (actions > 20) {
      settled = true;
      process.stderr.write("Portal smoke check exceeded 20 actions.\n");
      process.exitCode = 1;
      clearTimeout(deadline);
      port.emit("message", { data: { kind: "cancel", runId: message.runId } });
      return;
    }
    if (process.env.PERMIT_SMOKE_DEBUG === "1") process.stderr.write(`${JSON.stringify(message.observation)}\n`);
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
    if (!sameNumber(message.displayedNumber) || !message.statusValue.trim()) {
      process.stderr.write("Identity or status verification failed.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ permitNumber: message.displayedNumber,
      statusLabel: message.statusLabel, statusValue: message.statusValue,
      observedAt: message.observedAt, recordUrl: message.recordUrl,
      browserVersion: message.browserVersion }) + "\n");
  } else if (message.kind === "failed") {
    if (process.env.PERMIT_SMOKE_DEBUG === "1") process.stderr.write(`Last action failed in ${jurisdictionId}.\n`);
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
  jurisdictionId,
  previousRecordUrl: null,
  browserPath: path.resolve("vendor/playwright-browsers"),
} });
