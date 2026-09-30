import { actionLabel, permitAction } from "../shared/action.js";
import { describeReview, outstandingReviews, reviewRequestKey } from "../shared/reviews.js";
import { isFailure, outcomeText } from "../shared/outcomes.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";
import type { PermitStore } from "./store.js";
import type { KeyProblem } from "./check-queue.js";

export type CheckEventKind = "first-status" | "status-changed" | "review-action" | "check-failed" | "key-needed";

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
  const classified = permitAction(after);

  if (classified?.basis === "review") return `${quoted} · ${classified.reviews.map(describeReview).join("; ")} · Action: AEC`;

  return classified?.action === "applicant" ? `${quoted} · Action: ${actionLabel(classified)}` : quoted;
}

/**
 * Decides whether a finished check is worth telling the user about. Portal wording is quoted exactly;
 * newly observed review requests notify even when the record's wording has not changed. A new discipline or
 * correction date counts as a new request. Repeated requests and repeat failures stay quiet.
 */
export function describeCheckEvent(before: PermitRow, after: PermitRow, outcome: RunOutcome): CheckEvent | null {
  const number = after.permitNumber;

  if (outcome === "success" && after.lastStatus !== null) {
    const previousRequests = new Set(outstandingReviews(before.reviews ?? []).map(reviewRequestKey));
    const newRequests = outstandingReviews(after.reviews ?? []).filter((entry) => !previousRequests.has(reviewRequestKey(entry)));

    if (newRequests.length > 0) {
      const status = before.lastStatus && before.lastStatus !== after.lastStatus
        ? `“${before.lastStatus}” → “${after.lastStatus}”` : `“${after.lastStatus}”`;

      return { kind: "review-action", permitId: after.id, title: number,
        body: `${status} · ${newRequests.map(describeReview).join("; ")} · Action: AEC` };
    }

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

/**
 * What a follower hears when a newer shared list arrives: for each permit whose check finished since the list before,
 * the notice the publisher's own app would have given. A check still running when the earlier list went out has the
 * same start time but no outcome yet, so its finish counts. Permits new to the list stay quiet, so following a list
 * doesn't announce every permit in it, and key notices are left out because they are about the publisher's key.
 */
export function describeSharedUpdate(before: readonly PermitRow[], after: readonly PermitRow[]): CheckEvent[] {
  const previous = new Map(before.map((permit) => [permit.id, permit]));

  return after.flatMap((permit) => {
    const earlier = previous.get(permit.id);

    if (!earlier || !permit.latestOutcome) return [];

    if (earlier.latestAttemptAt === permit.latestAttemptAt && earlier.latestOutcome === permit.latestOutcome) return [];
    const event = describeCheckEvent(earlier, permit, permit.latestOutcome);

    return event && event.kind !== "key-needed" ? [event] : [];
  });
}

/** Records a completed check before describing it, using the previous completed outcome rather than its unfinished run. */
export function recordCheckEvent(store: Pick<PermitStore, "getPermitBeforeRun" | "finishRun" | "getPermit">,
  input: Parameters<PermitStore["finishRun"]>[0]): CheckEvent | null {
  const before = store.getPermitBeforeRun(input.permitId, input.runId);
  store.finishRun(input);
  const after = store.getPermit(input.permitId);

  return before && after ? describeCheckEvent(before, after, input.outcome) : null;
}
