// The shared-list wire format: each permit with its latest status and recent daily history. The publisher builds it
// from its store; followers parse it as untrusted network input.
import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import { dailyHistory } from "../shared/history.js";
import { getJurisdiction } from "../shared/jurisdictions.js";
import {
  runOutcomeSchema,
  type CheckRunRow,
  type ObservationRow,
  type PermitHistory,
  type PermitRow,
} from "../shared/permit.js";
import { outstandingReviews, reviewsSchema } from "../shared/reviews.js";
import { normalizeCheckTimes, type CheckTimes } from "../shared/schedule.js";

/** Days of history shared per permit: one entry per day, as the details sheet shows it. */
export const SHARED_HISTORY_DAYS = 120;

/** Permits one list may hold. A month's work is 50–75; the cap only bounds what a follower parses. */
const MAX_SHARED_PERMITS = 2000;

const text = (max: number) => z.string().max(max);

const timestamp = z.iso.datetime({ offset: true });

const checkRunSchema = z.object({
  id: text(64),
  permitId: text(64),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  outcome: runOutcomeSchema.nullable(),
  actionCount: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<CheckRunRow>;

const observationSchema = z.object({
  id: text(64),
  runId: text(64),
  permitId: text(64),
  verifiedPermitNumber: text(200),
  statusLabel: text(200),
  statusValue: text(2000),
  reviews: reviewsSchema,
  observedAt: timestamp,
  recordUrl: text(2000),
}) satisfies z.ZodType<ObservationRow>;

const sharedPermitSchema = z.object({
  id: text(64),
  jurisdictionId: text(100),
  permitNumber: text(200),
  projectNumber: text(200).nullable(),
  monitoringEnabled: z.boolean(),
  lastStatus: text(2000).nullable(),
  reviews: reviewsSchema,
  lastObservedAt: timestamp.nullable(),
  lastRecordUrl: text(2000).nullable(),
  latestAttemptAt: timestamp.nullable(),
  latestOutcome: runOutcomeSchema.nullable(),
});

const sharedListSchema = z.object({
  format: z.literal(1),
  /** The publisher's daily check times ("HH:MM"), or null when it only checks on request. */
  schedule: z.array(text(5)).max(24).nullable(),
  permits: z
    .array(
      z.object({
        permit: sharedPermitSchema,
        history: z.object({
          runs: z.array(checkRunSchema).max(SHARED_HISTORY_DAYS),
          observations: z.array(observationSchema).max(SHARED_HISTORY_DAYS),
        }),
      }),
    )
    .max(MAX_SHARED_PERMITS),
});

/** A shared list as a follower uses it: permits in the publisher's order, and each permit's history by id. */
export interface SharedList {
  /** The publisher's daily check times, which followers fetch after; null when it has none or they don't parse. */
  readonly schedule: CheckTimes | null;
  readonly permits: readonly PermitRow[];
  readonly histories: ReadonlyMap<string, PermitHistory>;
}

/**
 * The latest `days` days of history, picked as the details sheet's daily history picks them. Each observation keeps
 * only its outstanding review requests, since that is all a history entry shows and the full workflow would dominate
 * the list's size. Each observation also reuses its run's id (unique, since a run has at most one observation),
 * because random ids don't compress.
 */
function recentHistory(history: PermitHistory, days: number): PermitHistory {
  const picked = dailyHistory(history).slice(0, days);

  return {
    runs: picked.map((day) => day.run),
    observations: picked.flatMap((day) =>
      day.observation
        ? [
            {
              ...day.observation,
              id: day.run.id,
              reviews: day.observation.reviews && outstandingReviews(day.observation.reviews),
            },
          ]
        : [],
    ),
  };
}

/** Serializes the list to publish. `schedule` is the publisher's check times, or null if it only checks on request. */
export function buildSharedList(
  permits: readonly PermitRow[],
  historyOf: (permitId: string) => PermitHistory,
  schedule: readonly string[] | null,
): string {
  return JSON.stringify({
    format: 1,
    schedule: schedule ? [...schedule] : null,
    permits: permits.map((permit) => sharedEntry(permit, historyOf(permit.id))),
  } satisfies z.input<typeof sharedListSchema>);
}

/**
 * Parses a published list. Permits under a jurisdiction this app version doesn't know are left out rather than failing
 * the whole list, so a publisher on a newer version can still be followed.
 *
 * @throws ZodError or SyntaxError when the text isn't a list in this format.
 */
export function parseSharedList(json: string): SharedList {
  const list = sharedListSchema.parse(JSON.parse(json));
  const histories = new Map<string, PermitHistory>();

  const permits = list.permits.flatMap(({ permit, history }): PermitRow[] => {
    const jurisdiction = getJurisdiction(permit.jurisdictionId);

    if (!jurisdiction) return [];
    histories.set(permit.id, history);

    return [{ ...permit, jurisdictionId: jurisdiction.id, nextDueAt: null, checking: false }];
  });

  return { schedule: list.schedule ? normalizeCheckTimes(list.schedule) : null, permits, histories };
}

/**
 * One permit's shared state and recent history. Live check state (`checking`, `nextDueAt`) is left out: a follower
 * can't cancel a check, and a publisher that quits mid-check would leave it showing as running.
 */
function sharedEntry(permit: PermitRow, history: PermitHistory): z.input<typeof sharedListSchema>["permits"][number] {
  return {
    permit: {
      id: permit.id,
      jurisdictionId: permit.jurisdictionId,
      permitNumber: permit.permitNumber,
      projectNumber: permit.projectNumber,
      monitoringEnabled: permit.monitoringEnabled,
      lastStatus: permit.lastStatus,
      reviews: permit.reviews,
      lastObservedAt: permit.lastObservedAt,
      lastRecordUrl: permit.lastRecordUrl,
      latestAttemptAt: permit.latestAttemptAt,
      latestOutcome: permit.latestOutcome,
    },
    history: recentHistory(history, SHARED_HISTORY_DAYS),
  };
}

/**
 * Builds the same JSON as `buildSharedList`, yielding to the event loop before each history read and each entry's
 * serialization so a long list doesn't block the main process.
 */
export async function buildSharedListAsync(
  permits: readonly PermitRow[],
  historyOf: (permitId: string) => PermitHistory,
  schedule: readonly string[] | null,
): Promise<string> {
  const entries: string[] = [];

  for (const permit of permits) {
    await setImmediate();

    const history = historyOf(permit.id);

    // A history read and its serialization each fit in one turn on their own; yield between them so pending IPC runs.
    await setImmediate();
    entries.push(JSON.stringify(sharedEntry(permit, history)));
  }

  const prefix = JSON.stringify({ format: 1, schedule: schedule ? [...schedule] : null, permits: [] }).slice(0, -2);

  return `${prefix}${entries.join(",")}]}`;
}
