import { wordingKey } from "./wording-key.js";

export type ReviewEntry = {
  process: string;
  status: string | null;
  date: string | null;
  dueDate: string | null;
};

// Accela lists same-day review events oldest first.
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

const COORDINATION = new Set([
  "application submittal",
  "application review",
  "plans distribution",
  "plans coordination",
]);

// The portal supplies dates without times, so same-day corrections cannot be ordered against resubmittal.
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

export function reviewRequestKey(entry: ReviewEntry): string {
  return JSON.stringify([wordingKey(entry.process), wordingKey(entry.status ?? ""), entry.date ?? entry.dueDate]);
}

export function describeReview(entry: ReviewEntry): string {
  return `${entry.process}: “${entry.status ?? "Pending"}”${entry.date ? ` (${entry.date})` : ""}`;
}
