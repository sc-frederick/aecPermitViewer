import { isFailure, outcomeText } from "../shared/outcomes.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";

export type CheckEventKind = "first-status" | "status-changed" | "check-failed" | "key-needed";

export interface CheckEvent {
  kind: CheckEventKind;
  permitId: string;
  title: string;
  body: string;
}

/**
 * Decides whether a finished check is worth telling the user about. Portal wording is quoted
 * exactly and never interpreted; only the app's own facts (changed text, failed attempt) trigger.
 * Unchanged statuses and repeat failures stay quiet so scheduled checks do not nag.
 */
export function describeCheckEvent(before: PermitRow, after: PermitRow, outcome: RunOutcome): CheckEvent | null {
  const number = after.permitNumber;

  if (outcome === "success" && after.lastStatus !== null) {
    if (before.lastStatus === null) {
      return { kind: "first-status", permitId: after.id, title: number, body: `“${after.lastStatus}”` };
    }

    if (before.lastStatus !== after.lastStatus) {
      return { kind: "status-changed", permitId: after.id, title: number, body: `“${before.lastStatus}” → “${after.lastStatus}”` };
    }

    return null;
  }

  if (!isFailure(outcome) || isFailure(before.latestOutcome)) return null;

  if (outcome === "authentication_error") {
    return { kind: "key-needed", permitId: after.id, title: "TypeSafe key needed", body: "Add it in Settings." };
  }

  return { kind: "check-failed", permitId: after.id, title: number, body: outcomeText[outcome] };
}
