import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECK_TIMES,
  describeCheckTimes,
  effectiveRunTime,
  nextDueAfter,
  nextSlotAfter,
  normalizeCheckTimes,
  withinCheckWindow,
  type CheckTimes,
} from "../src/shared/schedule.js";

// Local-time dates, matching how the app reads the computer's clock.
const on = (hour: number, minute = 0, day = 24) => new Date(2026, 8, day, hour, minute);

const times = DEFAULT_CHECK_TIMES;

function checkTimes(...values: string[]): CheckTimes {
  const normalized = normalizeCheckTimes(values);

  if (!normalized) throw new Error(`Invalid check times: ${values.join(", ")}`);

  return normalized;
}

describe("default check schedule", () => {
  it("steps through 8:30, 12:30, and 4:30, then rolls to the next morning", () => {
    expect(nextSlotAfter(on(7, 0), times)).toEqual(on(8, 30));
    expect(nextSlotAfter(on(8, 30), times)).toEqual(on(12, 30));
    expect(nextSlotAfter(on(13, 5), times)).toEqual(on(16, 30));
    expect(nextSlotAfter(on(16, 30), times)).toEqual(on(8, 30, 25));
    expect(nextSlotAfter(on(23, 59), times)).toEqual(on(8, 30, 25));
  });

  it("only runs scheduled checks from 8:30 AM until 5 PM", () => {
    expect(withinCheckWindow(on(8, 29), times)).toBe(false);
    expect(withinCheckWindow(on(8, 30), times)).toBe(true);
    expect(withinCheckWindow(on(16, 59), times)).toBe(true);
    expect(withinCheckWindow(on(17, 0), times)).toBe(false);
    expect(withinCheckWindow(on(21, 0), times)).toBe(false);
  });

  it("waits for the next slot after any result, but retries an unreachable service within the hour", () => {
    expect(nextDueAfter(on(8, 31), "success", times)).toEqual(on(12, 30));
    expect(nextDueAfter(on(8, 31), "blocked", times)).toEqual(on(12, 30));
    expect(nextDueAfter(on(8, 31), "api_unavailable", times)).toEqual(on(9, 31));
    expect(nextDueAfter(on(12, 0), "api_unavailable", times)).toEqual(on(12, 30));
  });

  it("reports when an overdue or after-hours check will actually run", () => {
    expect(effectiveRunTime(on(9, 0), on(10, 0), times)).toEqual(on(10, 0));
    expect(effectiveRunTime(on(16, 30), on(19, 0), times)).toEqual(on(8, 30, 25));
    expect(effectiveRunTime(on(17, 20), on(16, 50), times)).toEqual(on(8, 30, 25));
    expect(effectiveRunTime(on(12, 30), on(7, 0), times)).toEqual(on(12, 30));
  });

  it("names the times for display", () => {
    expect(describeCheckTimes(times, "en-US")).toBe("8:30 AM, 12:30 PM, and 4:30 PM");
  });
});

describe("custom check times", () => {
  it("sorts, de-duplicates, and bounds the list", () => {
    expect(normalizeCheckTimes(["14:00", "07:15", "14:00"])).toEqual([
      { hour: 7, minute: 15 },
      { hour: 14, minute: 0 },
    ]);
    expect(normalizeCheckTimes([])).toBeNull();
    expect(normalizeCheckTimes(["7:15"])).toBeNull();
    expect(normalizeCheckTimes(["24:00"])).toBeNull();
    expect(normalizeCheckTimes(Array.from({ length: 9 }, (_, hour) => `0${hour}:00`))).toBeNull();
  });

  it("uses a single time's half-hour as the whole window", () => {
    const once = checkTimes("10:00");
    expect(nextSlotAfter(on(10, 0), once)).toEqual(on(10, 0, 25));
    expect(withinCheckWindow(on(10, 29), once)).toBe(true);
    expect(withinCheckWindow(on(10, 30), once)).toBe(false);
    expect(effectiveRunTime(on(10, 0), on(12, 0), once)).toEqual(on(10, 0, 25));
    expect(describeCheckTimes(once, "en-US")).toBe("10:00 AM");
  });

  it("stretches the window from the first time to half an hour after the last", () => {
    const spread = checkTimes("19:00", "06:00");
    expect(withinCheckWindow(on(5, 59), spread)).toBe(false);
    expect(withinCheckWindow(on(12, 0), spread)).toBe(true);
    expect(withinCheckWindow(on(19, 29), spread)).toBe(true);
    expect(nextDueAfter(on(6, 5), "success", spread)).toEqual(on(19, 0));
  });

  it("keeps a late last time's half-hour grace past midnight", () => {
    const late = checkTimes("08:30", "23:45");
    expect(withinCheckWindow(on(23, 59), late)).toBe(true);
    expect(withinCheckWindow(on(0, 5, 25), late)).toBe(true);
    expect(withinCheckWindow(on(0, 14, 25), late)).toBe(true);
    expect(withinCheckWindow(on(0, 15, 25), late)).toBe(false);
    expect(withinCheckWindow(on(8, 29, 25), late)).toBe(false);
    expect(withinCheckWindow(on(8, 30, 25), late)).toBe(true);

    // The 11:45 PM check that is overdue just after midnight runs then, not at 11:45 the next night.
    expect(effectiveRunTime(on(23, 45), on(0, 5, 25), late)).toEqual(on(0, 5, 25));
    expect(effectiveRunTime(on(23, 45), on(0, 15, 25), late)).toEqual(on(8, 30, 25));
    expect(nextDueAfter(on(0, 5, 25), "success", late)).toEqual(on(8, 30, 25));
  });

  it("leaves a window that closes before midnight shut overnight", () => {
    const evening = checkTimes("08:30", "23:00");
    expect(withinCheckWindow(on(23, 29), evening)).toBe(true);
    expect(withinCheckWindow(on(23, 30), evening)).toBe(false);
    expect(withinCheckWindow(on(0, 5, 25), evening)).toBe(false);
    expect(effectiveRunTime(on(23, 0), on(0, 5, 25), evening)).toEqual(on(8, 30, 25));
  });
});
