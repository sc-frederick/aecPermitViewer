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
import { reviewsSchema } from "../shared/review-schema.js";
import { outstandingReviews } from "../shared/reviews.js";
import { normalizeCheckTimes, type CheckTimes } from "../shared/schedule.js";

export const SHARED_HISTORY_DAYS = 120;

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

export interface SharedList {
  readonly schedule: CheckTimes | null;
  readonly permits: readonly PermitRow[];
  readonly histories: ReadonlyMap<string, PermitHistory>;
}

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

export function buildSharedList(
  permits: readonly PermitRow[],
  historyOf: (permitId: string) => PermitHistory,
  schedule: readonly string[] | null,
): string {
  return sharedListJson(
    schedule,
    permits.map((permit) => JSON.stringify(sharedEntry(permit, historyOf(permit.id)))),
  );
}

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

function sharedListJson(schedule: readonly string[] | null, entries: readonly string[]): string {
  return `{"format":1,"schedule":${JSON.stringify(schedule)},"permits":[${entries.join(",")}]}`;
}

export async function buildSharedListAsync(
  permits: readonly PermitRow[],
  historyOf: (permitId: string) => PermitHistory,
  schedule: readonly string[] | null,
): Promise<string> {
  const entries: string[] = [];

  for (const permit of permits) {
    await setImmediate();

    const history = historyOf(permit.id);

    await setImmediate();
    entries.push(JSON.stringify(sharedEntry(permit, history)));
  }

  return sharedListJson(schedule, entries);
}
