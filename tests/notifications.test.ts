import { describe, expect, it } from "vitest";
import { describeCheckEvent } from "../src/main/notifications.js";
import type { PermitRow } from "../src/shared/permit.js";

const base: PermitRow = {
  id: "00000000-0000-4000-8000-000000000001", jurisdictionId: "hillsborough-county-building",
  permitNumber: "HC-BLD-26-0087599", projectNumber: null, monitoringEnabled: true, lastStatus: null, lastObservedAt: null,
  lastRecordUrl: null, latestAttemptAt: null, latestOutcome: null, nextDueAt: null, checking: false,
};

const verified: PermitRow = { ...base, lastStatus: "In Process", lastObservedAt: "2026-09-23T12:00:00.000Z", latestOutcome: "success" };

describe("check notifications", () => {
  it("announces the first verified status", () => {
    expect(describeCheckEvent(base, { ...verified }, "success"))
      .toMatchObject({ kind: "first-status", title: "HC-BLD-26-0087599", body: "“In Process”" });
  });

  it("quotes both statuses exactly when the portal wording changes", () => {
    expect(describeCheckEvent(verified, { ...verified, lastStatus: "Issued" }, "success"))
      .toMatchObject({ kind: "status-changed", body: "“In Process” → “Issued”" });
  });

  it("says when the new status waits on the applicant", () => {
    expect(describeCheckEvent(verified, { ...verified, lastStatus: "Awaiting Client Reply" }, "success"))
      .toMatchObject({ kind: "status-changed", body: "“In Process” → “Awaiting Client Reply” · Action: AEC" });
    expect(describeCheckEvent(base, { ...verified, lastStatus: "Awaiting Client Reply" }, "success"))
      .toMatchObject({ kind: "first-status", body: "“Awaiting Client Reply” · Action: AEC" });
  });

  it("stays quiet when the status is unchanged", () => {
    expect(describeCheckEvent(verified, verified, "success")).toBeNull();
  });

  it("reports the first failure", () => {
    expect(describeCheckEvent(verified, { ...verified, latestOutcome: "blocked" }, "blocked"))
      .toMatchObject({ kind: "check-failed", body: "Portal blocked access" });
  });

  it("does not repeat failure notices while failures continue", () => {
    const failing = { ...verified, latestOutcome: "timeout" as const };
    expect(describeCheckEvent(failing, { ...failing, latestOutcome: "blocked" }, "blocked")).toBeNull();
  });

  it("ignores cancelled checks and groups key problems separately", () => {
    expect(describeCheckEvent(verified, verified, "cancelled")).toBeNull();
    expect(describeCheckEvent(verified, verified, "authentication_error")?.kind).toBe("key-needed");
  });
});
