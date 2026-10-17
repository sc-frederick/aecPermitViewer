import { describe, expect, it } from "vitest";
import { actionLabel, permitAction } from "../src/shared/action.js";
import { reviewDate } from "../src/shared/review-schema.js";
import { latestReviews, outstandingReviews, type ReviewEntry } from "../src/shared/reviews.js";

const correction: ReviewEntry = {
  process: "Stormwater Review",
  status: "Corrections Required",
  date: "2026-07-16",
  dueDate: "2026-07-14",
};

describe("review history", () => {
  it("puts a permit in AEC's court while its record is still In Process and another discipline is pending", () => {
    const reviews = [
      { ...correction, process: "Natural Resources Review", date: "2026-09-24", dueDate: "2026-09-22" },
      { ...correction, status: null, date: null, dueDate: "2026-09-22" },
    ];

    const action = permitAction({ jurisdictionId: "hillsborough-county-building", lastStatus: "In Process", reviews });
    expect(action).toMatchObject({ action: "applicant", basis: "review", reviews: [reviews[0]] });
    expect(action && actionLabel(action)).toBe("AEC");
  });

  it("orders decision dates across months and years, independent of displayed history order", () => {
    const approved = { ...correction, status: "Approved", date: "2027-01-03" };
    expect(latestReviews([approved, correction])).toEqual([approved]);
    expect(outstandingReviews([approved, correction])).toEqual([]);
  });

  it("does not resurrect old corrections when a new review round is pending", () => {
    const pending = { ...correction, status: null, date: null, dueDate: "2026-09-22" };
    expect(latestReviews([correction, pending])).toEqual([pending]);
    expect(outstandingReviews([correction, pending])).toEqual([]);
  });

  it("uses the last same-day event and treats process names without regard to case or spaces", () => {
    expect(
      outstandingReviews([correction, { ...correction, process: " stormwater  review ", status: "Approved" }]),
    ).toEqual([]);
    expect(outstandingReviews([{ ...correction, status: "Approved" }, correction])).toEqual([correction]);
  });

  it("clears old requests after explicit resubmission on another process, retaining later and same-day corrections", () => {
    const submitted = {
      ...correction,
      process: "Plans Distribution",
      status: "Routed for Electronic Review",
      date: "2026-09-08",
    };

    const current = { ...correction, process: "Natural Resources Review", date: "2026-09-24" };
    const sameDay = { ...correction, process: "Site Engineer Review", date: "2026-09-08" };
    expect(outstandingReviews([correction, submitted, current, sameDay])).toEqual([current, sameDay]);
  });

  it.each(["Document Uploaded", "Payment Received", "Approved"])(
    "does not use an unrelated %s event to clear another discipline",
    (status) => {
      expect(
        outstandingReviews([correction, { ...correction, process: "Other Review", status, date: "2026-09-24" }]),
      ).toEqual([correction]);
    },
  );

  it("keeps another discipline's request when only one discipline receives a resubmittal", () => {
    expect(
      outstandingReviews([
        correction,
        { ...correction, process: "Fire Review", status: "Resubmitted", date: "2026-09-24" },
      ]),
    ).toEqual([correction]);
  });

  it.each(["Plans Received", "Routed for Review"])(
    "recognizes Pasco's %s submission wording on coordination tasks",
    (status) => {
      expect(
        outstandingReviews([correction, { ...correction, process: "Plans Distribution", status, date: "2026-09-08" }]),
      ).toEqual([]);
    },
  );

  it.each([
    "Revisions Required",
    "Awaiting Client Reply",
    "Requires Resubmittal",
    "Not Approved",
    "Additional Info Required",
  ])("recognizes the jurisdiction's %s wording", (status) => {
    expect(outstandingReviews([{ ...correction, status }])).toHaveLength(1);
  });

  it.each(["Approved with Conditions", "No Corrections Required", "Not Applicable", "In Review"])(
    "does not mistake %s for a request",
    (status) => {
      expect(outstandingReviews([{ ...correction, status }])).toEqual([]);
    },
  );

  it("classifies by the listed portal status when no review asks for a response", () => {
    for (const reviews of [null, [], [{ ...correction, status: "Approved" }]]) {
      expect(
        permitAction({ jurisdictionId: "hillsborough-county-building", lastStatus: "In Process", reviews }),
      ).toEqual({ action: "authority", basis: "listed" });
    }
  });

  it("parses actual calendar dates and rejects rolled-over or ambiguous dates", () => {
    expect(reviewDate("9/24/2026")).toBe("2026-09-24");
    expect(reviewDate("02/29/2024")).toBe("2024-02-29");

    for (const value of ["02/29/2026", "13/01/2026", "04/31/2026", "TBD", "yesterday", "09/24/26"])
      expect(reviewDate(value)).toBeNull();
  });
});
