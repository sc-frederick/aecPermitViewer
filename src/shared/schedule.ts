import * as z from "zod/mini";
import type { RunOutcome } from "./permit.js";

const checkTimeSchema = z.readonly(z.object({ hour: z.number(), minute: z.number() }));

const checkTimesSchema = z.readonly(z.tuple([checkTimeSchema], checkTimeSchema)).brand<"CheckTimes">();

export type CheckTime = z.infer<typeof checkTimeSchema>;

export type CheckTimes = z.infer<typeof checkTimesSchema>;

export const DEFAULT_CHECK_TIMES: CheckTimes = checkTimesSchema.parse([
  { hour: 8, minute: 30 },
  { hour: 12, minute: 30 },
  { hour: 16, minute: 30 },
]);

export const MAX_CHECK_TIMES = 8;

const WINDOW_GRACE_MINUTES = 30;

const TRANSIENT_RETRY_MS = 60 * 60 * 1000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function formatCheckTime(time: CheckTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function parseCheckTime(value: string): CheckTime | null {
  const match = TIME_PATTERN.exec(value);

  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

export function normalizeCheckTimes(values: readonly string[]): CheckTimes | null {
  const formatted = new Set<string>();

  for (const value of values) {
    const time = parseCheckTime(value);

    if (!time) return null;
    formatted.add(formatCheckTime(time));
  }

  const [first, ...rest] = [...formatted].sort().flatMap((value) => parseCheckTime(value) ?? []);

  if (!first || rest.length >= MAX_CHECK_TIMES) return null;

  return checkTimesSchema.parse([first, ...rest]);
}

function at(day: Date, time: CheckTime): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

function windowEnd(day: Date, times: CheckTimes): Date {
  return new Date(at(day, times[times.length - 1] ?? times[0]).getTime() + WINDOW_GRACE_MINUTES * 60_000);
}

export function withinCheckWindow(now: Date, times: CheckTimes): boolean {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  return (now >= at(now, times[0]) && now < windowEnd(now, times)) || now < windowEnd(yesterday, times);
}

export function nextSlotAfter(now: Date, times: CheckTimes): Date {
  for (const time of times) {
    const slot = at(now, time);

    if (slot > now) return slot;
  }

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return at(tomorrow, times[0]);
}

export function nextDueAfter(now: Date, outcome: RunOutcome, times: CheckTimes): Date {
  const slot = nextSlotAfter(now, times);

  if (outcome !== "api_unavailable") return slot;
  const retry = new Date(now.getTime() + TRANSIENT_RETRY_MS);

  return retry < slot ? retry : slot;
}

/**
 * A local Date at `time`, for formatting a wall-clock time; only its time of day carries meaning. The day is fixed in
 * January, when no US time zone changes its clocks, so every time of day exists on it.
 */
export function wallClockDate(time: CheckTime): Date {
  return new Date(2026, 0, 5, time.hour, time.minute, 0, 0);
}

export function describeCheckTimes(times: CheckTimes, locale?: string): string {
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });

  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    times.map((time) => format.format(wallClockDate(time))),
  );
}

export function effectiveRunTime(due: Date, now: Date, times: CheckTimes): Date {
  const start = due > now ? due : now;

  return withinCheckWindow(start, times) ? start : nextSlotAfter(start, times);
}
