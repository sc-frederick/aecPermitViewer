import { actionLabel, statusAction } from "../shared/action.js";
import { isFailure, outcomeText } from "../shared/outcomes.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";
import type { KeyProblem } from "./check-queue.js";

export type CheckEventKind = "first-status" | "status-changed" | "check-failed" | "key-needed";

export interface CheckEvent {
  kind: CheckEventKind;
  /** The permit the notice is about; null for app-wide notices. */
  permitId: string | null;
  title: string;
  body: string;
}

/** The notice shown when checks can't run for want of a usable key. */
export function keyNotice(problem: KeyProblem): CheckEvent {
  switch (problem) {
    case "missing": return { kind: "key-needed", permitId: null, title: "TypeSafe key needed", body: "Add it in Settings to run checks." };
    case "unreadable": return { kind: "key-needed", permitId: null, title: "TypeSafe key unreadable", body: "Save it again in Settings." };
    case "rejected": return { kind: "key-needed", permitId: null, title: "TypeSafe key rejected", body: "Replace it in Settings. Scheduled checks are paused." };
  }
}

/** The quoted wording, followed by "Action: AEC" (or "AEC?" when marked to be safe) when the new status waits on the applicant. */
function statusBody(quoted: string, after: PermitRow): string {
  const classified = statusAction(after.jurisdictionId, after.lastStatus);

  return classified?.action === "applicant" ? `${quoted} · Action: ${actionLabel(classified)}` : quoted;
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

  if (outcome === "authentication_error") return keyNotice("rejected");

  return { kind: "check-failed", permitId: after.id, title: number, body: outcomeText[outcome] };
}
