import type { RunOutcome } from "./permit.js";

/**
 * Scheduled checks run three times each business day, in the computer's local time. A slot missed
 * while the app was closed or asleep is caught up once, but only inside business hours, so nothing
 * fires in the evening or overnight; the next morning's first slot covers it.
 */
export const CHECK_TIMES = [
  { hour: 8, minute: 30 },
  { hour: 12, minute: 30 },
  { hour: 16, minute: 30 },
] as const;

/** Scheduled checks start no earlier than the first slot and stop at the end of business. */
export const WINDOW_END = { hour: 17, minute: 0 } as const;

const TRANSIENT_RETRY_MS = 60 * 60 * 1000;

function at(day: Date, time: { hour: number; minute: number }): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

export function withinCheckWindow(now: Date): boolean {
  const first = CHECK_TIMES[0];
  return now >= at(now, first) && now < at(now, WINDOW_END);
}

/** The first scheduled slot strictly after `now`, rolling to tomorrow morning after the last one. */
export function nextSlotAfter(now: Date): Date {
  for (const time of CHECK_TIMES) {
    const slot = at(now, time);
    if (slot > now) return slot;
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return at(tomorrow, CHECK_TIMES[0]);
}

/**
 * When a permit should next be checked after an attempt that finished at `now`. Every outcome waits
 * for the next slot, except an unreachable TypeSafe service, which retries within the hour if that
 * comes sooner.
 */
export function nextDueAfter(now: Date, outcome: RunOutcome): Date {
  const slot = nextSlotAfter(now);
  if (outcome !== "api_unavailable") return slot;
  const retry = new Date(now.getTime() + TRANSIENT_RETRY_MS);
  return retry < slot ? retry : slot;
}

/** "8:30 AM, 12:30 PM, and 4:30 PM" in the user's locale. */
export function describeCheckTimes(locale?: string): string {
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const reference = new Date(2026, 0, 5);
  const times = CHECK_TIMES.map((time) => format.format(at(reference, time)));
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(times);
}

/** When a check due at `due` will actually run, given that scheduled checks wait for business hours. */
export function effectiveRunTime(due: Date, now: Date): Date {
  const start = due > now ? due : now;
  return withinCheckWindow(start) ? start : nextSlotAfter(start);
}
