import { describe, expect, it } from "vitest";
import { describeCheckEvent, describeSharedUpdate } from "../src/main/notifications.js";
import type { PermitRow } from "../src/shared/permit.js";
import { permitRow } from "./support/permit-row.js";

const base = permitRow();

const verified: PermitRow = {
  ...base,
  lastStatus: "In Process",
  lastObservedAt: "2026-09-23T12:00:00.000Z",
  latestOutcome: "success",
};

describe("check notifications", () => {
  it("announces the first verified status", () => {
    expect(describeCheckEvent(base, { ...verified }, "success")).toMatchObject({
      kind: "first-status",
      title: "HC-BLD-26-0087599",
      body: "“In Process”",
    });
  });

  it("quotes both statuses exactly when the portal wording changes", () => {
    expect(describeCheckEvent(verified, { ...verified, lastStatus: "Issued" }, "success")).toMatchObject({
      kind: "status-changed",
      body: "“In Process” → “Issued”",
    });
  });

  it("says when the new status waits on the applicant", () => {
    expect(describeCheckEvent(verified, { ...verified, lastStatus: "Awaiting Client Reply" }, "success")).toMatchObject(
      { kind: "status-changed", body: "“In Process” → “Awaiting Client Reply” · Action: AEC" },
    );
    expect(describeCheckEvent(base, { ...verified, lastStatus: "Awaiting Client Reply" }, "success")).toMatchObject({
      kind: "first-status",
      body: "“Awaiting Client Reply” · Action: AEC",
    });
  });

  it("stays quiet when the status is unchanged", () => {
    expect(describeCheckEvent(verified, verified, "success")).toBeNull();
  });

  it("announces additional disciplines and new correction rounds even when the record status stays unchanged", () => {
    const review = {
      process: "Natural Resources Review",
      status: "Corrections Required",
      date: "2026-09-24",
      dueDate: "2026-09-22",
    };

    const before = { ...verified, reviews: [review] };
    const additional = { ...review, process: "Site Engineer Review", date: "2026-09-28" };
    const event = describeCheckEvent(before, { ...before, reviews: [review, additional] }, "success");
    expect(event).toMatchObject({ kind: "review-action", body: expect.stringContaining("Site Engineer Review") });
    expect(event?.body).not.toContain("Natural Resources Review");
    expect(
      describeCheckEvent(
        before,
        { ...before, reviews: [review, { ...review, date: "2026-10-20", dueDate: "2026-10-20" }] },
        "success",
      ),
    ).toMatchObject({ kind: "review-action", body: expect.stringContaining("2026-10-20") });
  });

  it("does not repeat requests after reordered history, case changes, or failed checks", () => {
    const review = {
      process: "Natural Resources Review",
      status: "Corrections Required",
      date: "2026-09-24",
      dueDate: "2026-09-22",
    };

    const before = { ...verified, reviews: [review, { ...review, date: "2026-07-16", dueDate: "2026-07-14" }] };

    const after = {
      ...before,
      reviews: [...before.reviews].reverse().map((entry) => ({ ...entry, status: " corrections  required " })),
    };

    expect(describeCheckEvent(before, after, "success")).toBeNull();
    expect(
      describeCheckEvent(before, { ...before, reviews: [{ ...review, dueDate: "2026-09-30" }] }, "success"),
    ).toBeNull();
    expect(describeCheckEvent({ ...before, latestOutcome: "status_unavailable" }, after, "success")).toBeNull();
    expect(describeCheckEvent(verified, before, "status_unavailable")?.kind).toBe("check-failed");
  });

  it("does not announce superseded corrections or a newly pending review round", () => {
    const old = {
      process: "Stormwater Review",
      status: "Corrections Required",
      date: "2026-07-16",
      dueDate: "2026-07-14",
    };

    expect(
      describeCheckEvent(
        verified,
        { ...verified, reviews: [old, { ...old, date: null, status: null, dueDate: "2026-09-22" }] },
        "success",
      ),
    ).toBeNull();
    expect(
      describeCheckEvent(
        verified,
        { ...verified, reviews: [old, { ...old, status: "Approved", date: "2026-09-22" }] },
        "success",
      ),
    ).toBeNull();
  });

  it("reports the first failure", () => {
    expect(describeCheckEvent(verified, { ...verified, latestOutcome: "blocked" }, "blocked")).toMatchObject({
      kind: "check-failed",
      body: "Portal blocked access",
    });
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

describe("shared list notifications", () => {
  const checked = { ...verified, latestAttemptAt: "2026-09-28T12:00:00.000Z" };

  it("announces a check that finished since the list before, and stays quiet otherwise", () => {
    const issued = { ...checked, lastStatus: "Issued", latestAttemptAt: "2026-09-28T16:00:00.000Z" };

    expect(describeSharedUpdate([checked], [issued])).toMatchObject([
      { kind: "status-changed", body: "“In Process” → “Issued”" },
    ]);
    expect(describeSharedUpdate([checked], [checked])).toEqual([]);
    expect(describeSharedUpdate([], [issued])).toEqual([]);
  });

  it("announces a check the list before caught still running", () => {
    const running = { ...checked, latestAttemptAt: "2026-09-28T16:00:00.000Z", latestOutcome: null };
    const finished = { ...running, lastStatus: "Issued", latestOutcome: "success" as const };

    expect(describeSharedUpdate([checked], [running])).toEqual([]);
    expect(describeSharedUpdate([running], [finished])).toMatchObject([
      { kind: "status-changed", body: "“In Process” → “Issued”" },
    ]);
  });
});
