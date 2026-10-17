import { describe, expect, it } from "vitest";
import { actionLabel, actionReason, STATUS_WORDING, statusAction } from "../src/shared/action.js";
import { wordingKey } from "../src/shared/wording-key.js";
import { JURISDICTIONS, type JurisdictionId } from "../src/shared/jurisdictions.js";
import { defined } from "./support/defined.js";

function actionOn(jurisdictionId: JurisdictionId, status: string) {
  return statusAction(jurisdictionId, status)?.action;
}

describe("who a status waits on", () => {
  it("classifies each authority's own wording", () => {
    expect(actionOn("hillsborough-county-building", "Awaiting Client Reply")).toBe("applicant");
    expect(actionOn("hillsborough-county-building", "In Process")).toBe("authority");
    expect(actionOn("tampa-building", "Issued")).toBe("none");
    expect(actionOn("polk-county-building", "Inspections")).toBe("none");
    expect(actionOn("pinellas-county-building", "Awaiting Payment")).toBe("applicant");
    expect(actionOn("st-petersburg-building", "IN PROCESS")).toBe("authority");
    expect(statusAction("hernando-county-building", "Requires Resubmittal")).toEqual({
      action: "applicant",
      basis: "listed",
    });
  });

  it("ignores case and spacing, which differ between records and hand entry", () => {
    expect(actionOn("tampa-building", "in Process")).toBe("authority");
    expect(actionOn("hernando-county-building", "Issued -  PPR INSP")).toBe("none");
    expect(actionOn("hernando-county-building", "In Review ")).toBe("authority");
    expect(actionOn("st-petersburg-building", "Eplan Missing Info")).toBe("applicant");
  });

  it("counts records that stopped short, and wording the survey couldn't pin down, as AEC's", () => {
    expect(actionOn("hillsborough-county-building", "Expired")).toBe("applicant");
    expect(actionOn("polk-county-building", "Closed-Denied")).toBe("applicant");
    expect(actionOn("st-petersburg-building", "ABANDONED")).toBe("applicant");
    expect(actionOn("tampa-building", "Revision")).toBe("applicant");
    expect(actionOn("hernando-county-building", "Inactive")).toBe("applicant");
    expect(actionOn("tampa-building", "Withdrawn")).toBe("none");
  });

  it("labels explicit requests AEC and cautious or unlisted ones AEC?, with a reason for the guess", () => {
    const described = (status: string) => {
      const classified = statusAction("hillsborough-county-building", status);

      return classified && { label: actionLabel(classified), reason: actionReason(classified) };
    };

    expect(described("Awaiting Client Reply")).toEqual({ label: "AEC", reason: null });
    expect(described("In Process")).toEqual({ label: "AHJ", reason: null });
    expect(described("Expired")).toEqual({ label: "AEC?", reason: expect.stringContaining("to be safe") });
    expect(described("Corrections Required")).toEqual({
      label: "AEC?",
      reason: expect.stringContaining("isn't on the jurisdiction's list"),
    });
  });

  it("marks wording a county or city hasn't been seen to use as AEC's, and says it wasn't listed", () => {
    expect(statusAction("hillsborough-county-building", "Corrections Required")).toEqual({
      action: "applicant",
      basis: "unlisted",
    });
    // Wording listed for one authority is not carried to another.
    expect(statusAction("hillsborough-county-building", "Fees Due")).toEqual({
      action: "applicant",
      basis: "unlisted",
    });
    expect(statusAction("pasco-county-building", "Issued")).toEqual({ action: "applicant", basis: "unlisted" });
    expect(statusAction("palm-bay-building", "Permit Ready")).toEqual({ action: "applicant", basis: "unlisted" });
  });

  it("counts Baker County's ACTIVE as AEC's to be safe, since it hides lapsed permits", () => {
    expect(statusAction("baker-county-building", "active")).toEqual({ action: "applicant", basis: "cautious" });
    expect(statusAction("baker-county-building", "COMPLT")).toEqual({ action: "none", basis: "listed" });
  });

  it("leaves missing statuses and water management districts unclassified", () => {
    expect(statusAction("hillsborough-county-building", null)).toBeNull();
    expect(statusAction("sjrwmd", "Pending · Pending RAI Response")).toBeNull();
    expect(statusAction("swfwmd-erp", "Issued")).toBeNull();
  });

  it("covers every county and city, and files each wording under one action", () => {
    for (const profile of JURISDICTIONS) {
      if (profile.authorityType === "water-management-district") continue;
      const wording = defined(STATUS_WORDING[profile.id], `status wording for ${profile.id}`);
      const keys = Object.values(wording).flatMap((statuses) => statuses.map(wordingKey));
      expect(new Set(keys).size, profile.id).toBe(keys.length);
    }
  });
});
