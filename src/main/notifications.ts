import { actionOn, actionText } from "../shared/action.js";
import { isFailure, outcomeText } from "../shared/outcomes.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";

export type CheckEventKind = "first-status" | "status-changed" | "check-failed" | "key-needed";

export interface CheckEvent {
  kind: CheckEventKind;
  permitId: string;
  title: string;
  body: string;
}

/** The quoted wording, followed by "Action: AEC" when the new status waits on the applicant. */
function statusBody(quoted: string, after: PermitRow): string {
  return actionOn(after.jurisdictionId, after.lastStatus) === "applicant" ? `${quoted} · Action: ${actionText.applicant}` : quoted;
}

/**
 * Decides whether a finished check is worth telling the user about. Portal wording is quoted exactly;
 * only the app's own facts (changed text, failed attempt) trigger, and a status that waits on the
 * applicant says so after the quote. Unchanged statuses and repeat failures stay quiet so scheduled
 * checks do not nag.
 */
export function describeCheckEvent(before: PermitRow, after: PermitRow, outcome: RunOutcome): CheckEvent | null {
  const number = after.permitNumber;

  if (outcome === "success" && after.lastStatus !== null) {
    if (before.lastStatus === null) {
      return { kind: "first-status", permitId: after.id, title: number, body: statusBody(`“${after.lastStatus}”`, after) };
    }

    if (before.lastStatus !== after.lastStatus) {
      return {
        kind: "status-changed", permitId: after.id, title: number,
        body: statusBody(`“${before.lastStatus}” → “${after.lastStatus}”`, after),
      };
    }

    return null;
  }

  if (!isFailure(outcome) || isFailure(before.latestOutcome)) return null;

  if (outcome === "authentication_error") {
    return { kind: "key-needed", permitId: after.id, title: "TypeSafe key needed", body: "Add it in Settings." };
  }

  return { kind: "check-failed", permitId: after.id, title: number, body: outcomeText[outcome] };
}
