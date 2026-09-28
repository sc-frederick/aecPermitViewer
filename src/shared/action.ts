import type { JurisdictionId } from "./jurisdictions.js";

/** Who a verified status waits on: the applicant (AEC), the issuing authority (the AHJ), or no one. */
export const ACTION_ON = ["applicant", "authority", "none"] as const;

export type ActionOn = (typeof ACTION_ON)[number];

export const actionText: Record<ActionOn, string> = { applicant: "AEC", authority: "AHJ", none: "None" };

type StatusWording = Readonly<Record<ActionOn, readonly string[]>>;

/**
 * Each county and city portal's status wording, as its records displayed it in September 2026 (see
 * docs/PERMIT_STATUSES.md). When in doubt a status counts as AEC's: holds, wording the survey couldn't pin down,
 * and records that stopped short (expired, denied, revoked, abandoned, closed by staff) all need someone at AEC to
 * look. AHJ is only for wording the survey saw the authority working under, and None only for records that were
 * issued, finished, or deliberately ended.
 */
export const STATUS_WORDING: Partial<Record<JurisdictionId, StatusWording>> = {
  "hillsborough-county-building": {
    applicant: ["Awaiting Client Reply", "Expired"],
    authority: ["In Process"],
    none: ["Issued", "Complete", "Withdrawn", "Canceled", "Cancel"],
  },
  "pasco-county-building": {
    applicant: [
      "Awaiting Plans", "Awaiting Revisions", "Denied - More Info Required", "Fees Pending", "Pending Client Input",
      "Pending Permit Issuance", "Expired Permit",
    ],
    authority: ["Plans Received", "Plan Review In Process", "Pending Additional Review"],
    none: ["Permit Issued", "Approved", "Approved with Conditions", "Final Inspection Complete", "Closed", "Withdrawn"],
  },
  "tampa-building": {
    applicant: ["Awaiting Client Reply", "Revision", "Open", "Expired", "Administrative Close"],
    authority: ["In Process"],
    none: ["Issued", "Complete", "Withdrawn"],
  },
  "pinellas-county-building": {
    applicant: [
      "Awaiting Applicant Action", "Awaiting Plans", "Awaiting Payment", "Incomplete Submittal",
      "Closed - Expired Renewal: Deferred Payment",
    ],
    authority: ["Plans Received", "In Review"],
    none: ["Issued", "Closed - Finaled", "Closed - CO Issued", "Closed - COC Issued", "Closed - Supp-Rev Approved", "Closed - Withdrawn"],
  },
  "polk-county-building": {
    applicant: ["Additional Info Required", "Waiting for Revisions", "Fees Due", "Closure Verification", "Closed-Denied", "Expired"],
    authority: ["Application Received", "In Review", "Staff Researching", "Pending Issuance", "Certificate Pending"],
    // Polk's issued permits read "Inspections" until they close.
    none: ["Inspections", "Closed-CO Issued", "Closed-CC Issued", "Closed-Complete", "Closed-Withdrawn"],
  },
  "st-petersburg-building": {
    applicant: [
      "EPLAN MISSING INFO", "HOLD FOR NOTICE OF COMM", "CHANGE OF CONTRACTOR HOLD", "BAD CHECK HOLD", "APPLICATION HOLD",
      "INSPECT HOLD PENDING REVI", "PENDING VERIFICATION", "ADMINISTRATIVELY CLOSED", "EXPIRED", "ABANDONED", "REVOKED",
    ],
    authority: ["IN PROCESS"],
    // "APPROVED FOR PERMIT" is how Click2Gov shows an application whose permits have been printed.
    none: [
      "APPROVED FOR PERMIT", "C/O ISSUED", "TEMP CO ISSUED", "CERTIFICATE OF COMPLETION", "COMPLETED", "CLOSED", "BUSINESS CO",
      "BUSINESS CO WAIVER", "VOID",
    ],
  },
  "hernando-county-building": {
    applicant: [
      "Incomplete", "Pending/Documents Needed", "Requires Resubmittal", "Fees Due", "Approved / Pending Documents", "On Hold",
      "Health Department Hold", "Stop Work Order", "Inactive", "Denied", "Expired", "Plan Approval Expired",
    ],
    authority: ["Submitted", "Submitted - Online", "In Review", "In Review v2", "Awaiting Other Agency Reviews", "Fees Paid"],
    none: ["Issued", "Issued - PPR INSP", "Final", "Complete", "Void", "Void*"],
  },
  // Hand-checked portals: the wording their own guides and published data use, since the user types what they see.
  "orange-county-building": {
    applicant: [
      "Internet Incomplete", "Address Pending", "Deficient", "Deficiencies", "Not Approved", "Ready to Issue",
      "Pending W/Comments", "Stop Work", "Expired", "Application Expired",
    ],
    authority: ["Internet Pending", "New", "Review", "Final Plan Prep", "Final Issuance", "Final Plan Prep/Final Issuance"],
    none: ["Issued", "CO", "Complete", "Closed", "Replaced", "Void"],
  },
  // iMS calls the status a milestone. Palm Bay's own videos confirm Submitted, that an Approved permit waits on its
  // fee balance, and the plan room's Open, Reopened, and Answered comment states; the rest is the vendor's wording.
  "palm-bay-building": {
    applicant: ["Pending", "Disapproved", "Approved", "Open", "Reopened", "Answered", "Expired"],
    authority: ["Submitted", "Under Review"],
    none: ["Issued", "Finaled", "Completed", "Closed"],
  },
};

/** Portal wording compared without regard to case or runs of spaces, which vary between records and hand entry. */
function wordingKey(status: string): string {
  return status.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

const LOOKUP = new Map(Object.entries(STATUS_WORDING).map(([id, wording]) => [id, new Map(
  ACTION_ON.flatMap((action) => wording[action].map((status) => [wordingKey(status), action] as const)),
)]));

/** Who a status waits on, and whether its wording is on the authority's list or counted as AEC's because it isn't. */
export interface StatusAction {
  action: ActionOn;
  listed: boolean;
}

/**
 * Who the authority's status wording leaves the next step to. Wording a county or city hasn't been seen to use
 * counts as AEC's, so a new status gets looked at. Water management districts aren't classified yet.
 */
export function statusAction(jurisdictionId: JurisdictionId, status: string | null): StatusAction | null {
  const wording = LOOKUP.get(jurisdictionId);

  if (!status || !wording) return null;
  const action = wording.get(wordingKey(status));

  return action ? { action, listed: true } : { action: "applicant", listed: false };
}

export function actionOn(jurisdictionId: JurisdictionId, status: string | null): ActionOn | null {
  return statusAction(jurisdictionId, status)?.action ?? null;
}
