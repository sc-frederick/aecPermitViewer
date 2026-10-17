import { wordingKey } from "./wording-key.js";

/**
 * One dated workflow entry: a review's portal wording and dates. Pending rounds have no status or decision date yet.
 * Dates are ISO calendar dates, independent of the computer's time zone. `reviewEntrySchema` parses one.
 */
export type ReviewEntry = {
  process: string;
  status: string | null;
  date: string | null;
  dueDate: string | null;
};

/**
 * Latest entry per process by decision date, using the due date only for pending rounds. Accela lists same-day
 * events oldest first, so the last such entry wins. A new TBD round replaces that discipline's older corrections.
 */
export function latestReviews(entries: readonly ReviewEntry[]): ReviewEntry[] {
  const latest = new Map<string, ReviewEntry>();

  for (const entry of entries) {
    const name = wordingKey(entry.process);
    const previous = latest.get(name);

    if (!previous || (entry.date ?? entry.dueDate ?? "") >= (previous.date ?? previous.dueDate ?? ""))
      latest.set(name, entry);
  }

  return [...latest.values()];
}

const REQUESTS = new Set([
  "corrections required",
  "revisions required",
  "requires resubmittal",
  "resubmittal required",
  "returned for corrections",
  "awaiting client reply",
  "awaiting applicant action",
  "pending client input",
  "awaiting plans",
  "awaiting revisions",
  "waiting for revisions",
  "additional info required",
  "additional information required",
  "denied - more info required",
  "deficient",
  "deficiencies",
  "not approved",
  "disapproved",
  "denied",
]);

const SUBMISSIONS = new Set([
  "plans submitted",
  "plans received",
  "resubmitted",
  "revisions received",
  "resubmittal received",
  "routed for electronic review",
  "routed for review",
]);

// Only intake/coordination tasks establish a submission for the whole record, so a resubmittal on one discipline
// doesn't clear another discipline's outstanding request.
const COORDINATION = new Set([
  "application submittal",
  "application review",
  "plans distribution",
  "plans coordination",
]);

/**
 * Requests still awaiting an applicant response. A resubmittal or routing event on an intake/coordination task starts
 * a new round and clears requests dated before it; uploads and payments alone don't. A request dated the same day as
 * the resubmittal stays outstanding, since the portal gives no times to order them.
 */
export function outstandingReviews(entries: readonly ReviewEntry[]): ReviewEntry[] {
  let submitted: string | null = null;

  for (const entry of entries) {
    if (
      COORDINATION.has(wordingKey(entry.process)) &&
      entry.status &&
      SUBMISSIONS.has(wordingKey(entry.status)) &&
      entry.date &&
      (!submitted || entry.date > submitted)
    )
      submitted = entry.date;
  }

  return latestReviews(entries).filter(
    (entry) =>
      entry.status && REQUESTS.has(wordingKey(entry.status)) && (!submitted || !entry.date || entry.date >= submitted),
  );
}

/** Stable identity of a request, independent of workflow ordering, whitespace, and reassignment. */
export function reviewRequestKey(entry: ReviewEntry): string {
  return JSON.stringify([wordingKey(entry.process), wordingKey(entry.status ?? ""), entry.date ?? entry.dueDate]);
}

/** Human-readable portal evidence, shared by action tooltips and notifications. */
export function describeReview(entry: ReviewEntry): string {
  return `${entry.process}: “${entry.status ?? "Pending"}”${entry.date ? ` (${entry.date})` : ""}`;
}
