import { z } from "zod";

const plainText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{Cc}+$/u);

/** One dated workflow entry, including pending rounds whose status and decision date are not yet set. */
export const reviewEntrySchema = z.object({
  process: plainText,
  status: plainText.nullable(),
  date: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
});

/** A review's portal wording and dates; dates are calendar dates, independent of the computer's time zone. */
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;

/** Null means no workflow was read (including observations saved by older app versions). */
export const reviewsSchema = z.array(reviewEntrySchema).max(3000).nullable();

/** Accela's US calendar date, or null for its pending TBD placeholder or an invalid date. */
export function reviewDate(value: string): string | null {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());

  if (!parts) return null;
  const parsed = z.iso.date().safeParse(`${parts[3]}-${parts[1]?.padStart(2, "0")}-${parts[2]?.padStart(2, "0")}`);

  return parsed.success ? parsed.data : null;
}

const key = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

/**
 * Latest entry per process by decision date, using the due date only for pending rounds. Accela lists same-day
 * events oldest first, so the last such entry wins. A new TBD round replaces that discipline's older corrections.
 */
export function latestReviews(entries: readonly ReviewEntry[]): ReviewEntry[] {
  const latest = new Map<string, ReviewEntry>();

  for (const entry of entries) {
    const name = key(entry.process);
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

// Only the portal's intake/coordination tasks establish a submission for the whole record. A resubmittal on one
// discipline must not clear another discipline's outstanding request.
const COORDINATION = new Set([
  "application submittal",
  "application review",
  "plans distribution",
  "plans coordination",
]);

/**
 * Current requests for an applicant response. A later explicit resubmittal/routing event starts a new review round,
 * when recorded on an intake/coordination task. Uploads and payments alone do not establish that corrections were answered.
 * Same-day requests remain actionable because the portal supplies no times to prove they preceded submission.
 */
export function outstandingReviews(entries: readonly ReviewEntry[]): ReviewEntry[] {
  let submitted: string | null = null;

  for (const entry of entries) {
    if (
      COORDINATION.has(key(entry.process)) &&
      entry.status &&
      SUBMISSIONS.has(key(entry.status)) &&
      entry.date &&
      (!submitted || entry.date > submitted)
    )
      submitted = entry.date;
  }

  return latestReviews(entries).filter(
    (entry) =>
      entry.status && REQUESTS.has(key(entry.status)) && (!submitted || !entry.date || entry.date >= submitted),
  );
}

/** Stable identity of a request, independent of workflow ordering, whitespace, and reassignment. */
export function reviewRequestKey(entry: ReviewEntry): string {
  return JSON.stringify([key(entry.process), key(entry.status ?? ""), entry.date ?? entry.dueDate]);
}

/** Human-readable portal evidence, shared by action tooltips and notifications. */
export function describeReview(entry: ReviewEntry): string {
  return `${entry.process}: “${entry.status ?? "Pending"}”${entry.date ? ` (${entry.date})` : ""}`;
}
