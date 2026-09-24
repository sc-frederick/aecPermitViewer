import { describe, expect, it } from "vitest";
import { describeCheckTimes, effectiveRunTime, nextDueAfter, nextSlotAfter, withinCheckWindow } from "../src/shared/schedule.js";

// Local-time dates, matching how the app reads the computer's clock.
const on = (hour: number, minute = 0, day = 24) => new Date(2026, 8, day, hour, minute);

describe("business-hours check schedule", () => {
  it("steps through 8:30, 12:30, and 4:30, then rolls to the next morning", () => {
    expect(nextSlotAfter(on(7, 0))).toEqual(on(8, 30));
    expect(nextSlotAfter(on(8, 30))).toEqual(on(12, 30));
    expect(nextSlotAfter(on(13, 5))).toEqual(on(16, 30));
    expect(nextSlotAfter(on(16, 30))).toEqual(on(8, 30, 25));
    expect(nextSlotAfter(on(23, 59))).toEqual(on(8, 30, 25));
  });

  it("only runs scheduled checks from 8:30 AM until 5 PM", () => {
    expect(withinCheckWindow(on(8, 29))).toBe(false);
    expect(withinCheckWindow(on(8, 30))).toBe(true);
    expect(withinCheckWindow(on(16, 59))).toBe(true);
    expect(withinCheckWindow(on(17, 0))).toBe(false);
    expect(withinCheckWindow(on(21, 0))).toBe(false);
  });

  it("waits for the next slot after any result, but retries an unreachable service within the hour", () => {
    expect(nextDueAfter(on(8, 31), "success")).toEqual(on(12, 30));
    expect(nextDueAfter(on(8, 31), "blocked")).toEqual(on(12, 30));
    expect(nextDueAfter(on(8, 31), "api_unavailable")).toEqual(on(9, 31));
    expect(nextDueAfter(on(12, 0), "api_unavailable")).toEqual(on(12, 30));
  });

  it("reports when an overdue or after-hours check will actually run", () => {
    expect(effectiveRunTime(on(9, 0), on(10, 0))).toEqual(on(10, 0));
    expect(effectiveRunTime(on(16, 30), on(19, 0))).toEqual(on(8, 30, 25));
    expect(effectiveRunTime(on(17, 20), on(16, 50))).toEqual(on(8, 30, 25));
    expect(effectiveRunTime(on(12, 30), on(7, 0))).toEqual(on(12, 30));
  });

  it("names the three times for display", () => {
    expect(describeCheckTimes("en-US")).toBe("8:30 AM, 12:30 PM, and 4:30 PM");
  });
});
