import { make } from "./dom.js";

const stampFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const stampFormatWithYear = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const dateFormatWithYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Clock time in the user's locale, such as "8:30 AM". */
export const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/** "Sep 24, 12:17 PM", with the year added when it isn't the current one. */
export function stamp(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? stampFormat : stampFormatWithYear).format(date);
}

/** "Sep 24", with the year added when it isn't the current one. */
export function dateOnly(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? dateFormat : dateFormatWithYear).format(date);
}

/** A `<time>` showing `value` through `format`, with the full date and time as its tooltip; `fallback` when null. */
export function timeNode(value: string | null, fallback = "—", format: (value: string) => string = stamp): HTMLElement {
  if (!value) return make("span", "muted", fallback);
  const node = make("time", "", format(value));
  node.dateTime = value;
  node.title = fullFormat.format(new Date(value));

  return node;
}

/** "now", "today at 12:30 PM", "tomorrow at 8:30 AM", or "Monday at 8:30 AM". */
export function relativeTime(when: Date, now = new Date()): string {
  if (when.getTime() - now.getTime() < 60_000) return "now";
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(when) - startOf(now)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : dayFormat.format(when);

  return `${day} at ${clockFormat.format(when)}`;
}

/** "1 permit" or "3 permits". */
export const permitCount = (count: number) => `${count} ${count === 1 ? "permit" : "permits"}`;
