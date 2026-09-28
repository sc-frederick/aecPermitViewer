import type { RunOutcome } from "./permit.js";

/**
 * Scheduled checks run at the user's chosen times each day, in the computer's local time. A slot
 * missed while the app was closed or asleep is caught up once, but only inside the check window
 * (first slot until half an hour after the last), so nothing fires overnight; the next morning's
 * first slot covers it. A late last slot keeps its full half hour even when that runs past midnight.
 */
export interface CheckTime { hour: number; minute: number }

/** Sorted, de-duplicated, never empty. */
export type CheckTimes = readonly [CheckTime, ...CheckTime[]];

export const DEFAULT_CHECK_TIMES: CheckTimes = [
  { hour: 8, minute: 30 },
  { hour: 12, minute: 30 },
  { hour: 16, minute: 30 },
];

export const MAX_CHECK_TIMES = 8;

const WINDOW_GRACE_MINUTES = 30;

const TRANSIENT_RETRY_MS = 60 * 60 * 1000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" as stored in settings and sent over IPC. */
export function formatCheckTime(time: CheckTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function parseCheckTime(value: string): CheckTime | null {
  const match = TIME_PATTERN.exec(value);

  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** Parses, de-duplicates, and sorts "HH:MM" strings. Returns null unless 1–MAX valid times remain. */
export function normalizeCheckTimes(values: readonly string[]): CheckTimes | null {
  const formatted = new Set<string>();

  for (const value of values) {
    const time = parseCheckTime(value);

    if (!time) return null;
    formatted.add(formatCheckTime(time));
  }

  const [first, ...rest] = [...formatted].sort().flatMap((value) => parseCheckTime(value) ?? []);

  if (!first || rest.length >= MAX_CHECK_TIMES) return null;

  return [first, ...rest];
}

function at(day: Date, time: CheckTime): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

/** When a day's check window closes: half an hour after its last slot, which is past midnight for a slot after 11:30 PM. */
function windowEnd(day: Date, times: CheckTimes): Date {
  return new Date(at(day, times[times.length - 1] ?? times[0]).getTime() + WINDOW_GRACE_MINUTES * 60_000);
}

/**
 * Whether scheduled checks may run at `now`: from today's first slot until half an hour after today's last, or still
 * inside yesterday's window when its last slot's half hour runs past midnight.
 */
export function withinCheckWindow(now: Date, times: CheckTimes): boolean {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  return (now >= at(now, times[0]) && now < windowEnd(now, times)) || now < windowEnd(yesterday, times);
}

/** The first scheduled slot strictly after `now`, rolling to tomorrow's first slot after the last one. */
export function nextSlotAfter(now: Date, times: CheckTimes): Date {
  for (const time of times) {
    const slot = at(now, time);

    if (slot > now) return slot;
  }

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return at(tomorrow, times[0]);
}

/**
 * When a permit should next be checked after an attempt that finished at `now`. Every outcome waits
 * for the next slot, except an unreachable TypeSafe service, which retries within the hour if that
 * comes sooner.
 */
export function nextDueAfter(now: Date, outcome: RunOutcome, times: CheckTimes): Date {
  const slot = nextSlotAfter(now, times);

  if (outcome !== "api_unavailable") return slot;
  const retry = new Date(now.getTime() + TRANSIENT_RETRY_MS);

  return retry < slot ? retry : slot;
}

/** "8:30 AM, 12:30 PM, and 4:30 PM" in the user's locale. */
export function describeCheckTimes(times: CheckTimes, locale?: string): string {
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const reference = new Date(2026, 0, 5);

  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" })
    .format(times.map((time) => format.format(at(reference, time))));
}

/**
 * When a check due at `due` will actually run, given that scheduled checks wait for the check window. A check that is
 * overdue within the half hour after a late slot runs then, even after midnight, rather than waiting for the next slot.
 */
export function effectiveRunTime(due: Date, now: Date, times: CheckTimes): Date {
  const start = due > now ? due : now;

  return withinCheckWindow(start, times) ? start : nextSlotAfter(start, times);
}
