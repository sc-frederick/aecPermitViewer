import { actionLabel, permitAction } from "../shared/action.js";
import { describeReview, outstandingReviews, reviewRequestKey } from "../shared/reviews.js";
import { isFailure, outcomeText } from "../shared/outcomes.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";
import type { PermitStore } from "./store.js";
import type { KeyProblem } from "./check-queue.js";

/** What a notice reports: a permit's first or changed status, a new review request, a failed check, or a key problem. */
export type CheckEventKind = "first-status" | "status-changed" | "review-action" | "check-failed" | "key-needed";

/** A notice for the window or a desktop notification. */
export interface CheckEvent {
  kind: CheckEventKind;
  permitId: string | null;
  title: string;
  body: string;
}

/** The notice shown when checks can't run for want of a usable key. */
export function keyNotice(problem: KeyProblem): CheckEvent {
  switch (problem) {
    case "missing":
      return {
        kind: "key-needed",
        permitId: null,
        title: "TypeSafe key needed",
        body: "Add it in Settings to run checks.",
      };
    case "unreadable":
      return {
        kind: "key-needed",
        permitId: null,
        title: "TypeSafe key unreadable",
        body: "Save it again in Settings.",
      };
    case "rejected":
      return {
        kind: "key-needed",
        permitId: null,
        title: "TypeSafe key rejected",
        body: "Replace it in Settings. Scheduled checks are paused.",
      };
  }
}

function statusBody(quoted: string, after: PermitRow): string {
  const classified = permitAction(after);

  if (classified?.basis === "review")
    return `${quoted} · ${classified.reviews.map(describeReview).join("; ")} · Action: AEC`;

  return classified?.action === "applicant" ? `${quoted} · Action: ${actionLabel(classified)}` : quoted;
}

/**
 * The notice for a finished check, or null when it isn't worth one. Portal wording is quoted exactly. A new review
 * request (a new discipline or correction date) notifies even when the status wording is unchanged; repeated requests
 * and repeat failures stay quiet.
 */
export function describeCheckEvent(before: PermitRow, after: PermitRow, outcome: RunOutcome): CheckEvent | null {
  const number = after.permitNumber;

  if (outcome === "success" && after.lastStatus !== null) {
    const previousRequests = new Set(outstandingReviews(before.reviews ?? []).map(reviewRequestKey));

    const newRequests = outstandingReviews(after.reviews ?? []).filter(
      (entry) => !previousRequests.has(reviewRequestKey(entry)),
    );

    if (newRequests.length > 0) {
      const status =
        before.lastStatus && before.lastStatus !== after.lastStatus
          ? `“${before.lastStatus}” → “${after.lastStatus}”`
          : `“${after.lastStatus}”`;

      return {
        kind: "review-action",
        permitId: after.id,
        title: number,
        body: `${status} · ${newRequests.map(describeReview).join("; ")} · Action: AEC`,
      };
    }

    if (before.lastStatus === null) {
      return {
        kind: "first-status",
        permitId: after.id,
        title: number,
        body: statusBody(`“${after.lastStatus}”`, after),
      };
    }

    if (before.lastStatus !== after.lastStatus) {
      return {
        kind: "status-changed",
        permitId: after.id,
        title: number,
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
 * Notices for a follower when a newer shared list arrives: for each permit whose check finished since the previous
 * list, the notice the publisher's app would have shown. A check still running in the previous list has the same start
 * time but no outcome, so its finish counts. Permits new to the list stay quiet, so following a list doesn't announce
 * every permit, and key notices are dropped because they concern the publisher's key.
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

/** Finishes the run in the store and returns its notice, comparing against the permit as it was before this run. */
export function recordCheckEvent(
  store: Pick<PermitStore, "getPermitBeforeRun" | "finishRun" | "getPermit">,
  input: Parameters<PermitStore["finishRun"]>[0],
): CheckEvent | null {
  const before = store.getPermitBeforeRun(input.permitId, input.runId);
  store.finishRun(input);
  const after = store.getPermit(input.permitId);

  return before && after ? describeCheckEvent(before, after, input.outcome) : null;
}
