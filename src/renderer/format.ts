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

export const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

export function stamp(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? stampFormat : stampFormatWithYear).format(date);
}

export function dateOnly(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? dateFormat : dateFormatWithYear).format(date);
}

export function timeNode(value: string | null, fallback = "—", format: (value: string) => string = stamp): HTMLElement {
  if (!value) return make("span", "muted", fallback);
  const node = make("time", "", format(value));
  node.dateTime = value;
  node.title = fullFormat.format(new Date(value));

  return node;
}

export function relativeTime(when: Date, now = new Date()): string {
  if (when.getTime() - now.getTime() < 60_000) return "now";
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(when) - startOf(now)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : dayFormat.format(when);

  return `${day} at ${clockFormat.format(when)}`;
}

export const permitCount = (count: number) => `${count} ${count === 1 ? "permit" : "permits"}`;
