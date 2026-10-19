import type { JurisdictionId, JurisdictionProfile } from "./jurisdictions.js";
import type { PermitRow } from "./permit.js";
import { describeReview, outstandingReviews, type ReviewEntry } from "./reviews.js";
import { wordingKey } from "./wording-key.js";

export type ActionOn = "applicant" | "authority" | "none";

const actionText: Record<ActionOn, string> = { applicant: "AEC", authority: "AHJ", none: "None" };

export type ActionBasis = "listed" | "cautious" | "unlisted";

type StatusWording = Readonly<Record<ActionOn | "cautious", readonly string[]>>;

type LocalJurisdictionId = Extract<JurisdictionProfile, { authorityType: "county-government" | "municipality" }>["id"];

export const STATUS_WORDING: Record<LocalJurisdictionId, StatusWording> = {
  "hillsborough-county-building": {
    applicant: ["Awaiting Client Reply"],
    cautious: ["Expired"],
    authority: ["In Process"],
    none: ["Issued", "Complete", "Withdrawn", "Canceled", "Cancel"],
  },
  "pasco-county-building": {
    applicant: [
      "Awaiting Plans",
      "Awaiting Revisions",
      "Denied - More Info Required",
      "Fees Pending",
      "Pending Client Input",
    ],
    cautious: ["Pending Permit Issuance", "Expired Permit"],
    authority: ["Plans Received", "Plan Review In Process", "Pending Additional Review"],
    none: ["Permit Issued", "Approved", "Approved with Conditions", "Final Inspection Complete", "Closed", "Withdrawn"],
  },
  "tampa-building": {
    applicant: ["Awaiting Client Reply"],
    cautious: ["Revision", "Open", "Expired", "Administrative Close"],
    authority: ["In Process"],
    none: ["Issued", "Complete", "Withdrawn"],
  },
  "pinellas-county-building": {
    applicant: ["Awaiting Applicant Action", "Awaiting Plans", "Awaiting Payment", "Incomplete Submittal"],
    cautious: ["Closed - Expired Renewal: Deferred Payment"],
    authority: ["Plans Received", "In Review"],
    none: [
      "Issued",
      "Closed - Finaled",
      "Closed - CO Issued",
      "Closed - COC Issued",
      "Closed - Supp-Rev Approved",
      "Closed - Withdrawn",
    ],
  },
  "polk-county-building": {
    applicant: ["Additional Info Required", "Waiting for Revisions", "Fees Due"],
    cautious: ["Closure Verification", "Closed-Denied", "Expired"],
    authority: ["Application Received", "In Review", "Staff Researching", "Pending Issuance", "Certificate Pending"],
    // Polk's issued permits read "Inspections" until they close.
    none: ["Inspections", "Closed-CO Issued", "Closed-CC Issued", "Closed-Complete", "Closed-Withdrawn"],
  },
  "st-petersburg-building": {
    applicant: [
      "EPLAN MISSING INFO",
      "HOLD FOR NOTICE OF COMM",
      "CHANGE OF CONTRACTOR HOLD",
      "BAD CHECK HOLD",
      "APPLICATION HOLD",
    ],
    cautious: [
      "INSPECT HOLD PENDING REVI",
      "PENDING VERIFICATION",
      "ADMINISTRATIVELY CLOSED",
      "EXPIRED",
      "ABANDONED",
      "REVOKED",
    ],
    authority: ["IN PROCESS"],
    // "APPROVED FOR PERMIT" is how Click2Gov shows an application whose permits have been printed.
    none: [
      "APPROVED FOR PERMIT",
      "C/O ISSUED",
      "TEMP CO ISSUED",
      "CERTIFICATE OF COMPLETION",
      "COMPLETED",
      "CLOSED",
      "BUSINESS CO",
      "BUSINESS CO WAIVER",
      "VOID",
    ],
  },
  "hernando-county-building": {
    applicant: [
      "Incomplete",
      "Pending/Documents Needed",
      "Requires Resubmittal",
      "Fees Due",
      "Approved / Pending Documents",
      "On Hold",
      "Health Department Hold",
      "Stop Work Order",
    ],
    cautious: ["Inactive", "Denied", "Expired", "Plan Approval Expired"],
    authority: [
      "Submitted",
      "Submitted - Online",
      "In Review",
      "In Review v2",
      "Awaiting Other Agency Reviews",
      "Fees Paid",
    ],
    none: ["Issued", "Issued - PPR INSP", "Final", "Complete", "Void", "Void*"],
  },
  "orange-county-building": {
    applicant: ["Internet Incomplete", "Deficient", "Deficiencies", "Not Approved", "Ready to Issue", "Stop Work"],
    cautious: ["Address Pending", "Pending W/Comments", "Expired", "Application Expired"],
    authority: [
      "Internet Pending",
      "New",
      "Review",
      "Final Plan Prep",
      "Final Issuance",
      "Final Plan Prep/Final Issuance",
    ],
    none: ["Issued", "CO", "Complete", "Closed", "Replaced", "Void"],
  },
  // iMS calls the status a milestone. Palm Bay's own videos confirm Submitted, that an Approved permit waits on its
  // fee balance, and the plan room's Open, Reopened, and Answered comment states; the rest is the vendor's wording.
  "palm-bay-building": {
    applicant: ["Pending", "Disapproved", "Approved", "Open", "Reopened"],
    cautious: ["Answered", "Expired"],
    authority: ["Submitted", "Under Review"],
    none: ["Issued", "Finaled", "Completed", "Closed"],
  },
  // A sample of 194 records showed only ACTIVE, COMPLT, and VOID. ACTIVE covers review, inspections, and lapsed
  // permits alike (a lapsed one keeps ACTIVE under a "This permit expired on" banner), so it can't settle who's up.
  "baker-county-building": {
    applicant: [],
    cautious: ["ACTIVE", "Expired"],
    authority: [],
    none: ["COMPLT", "VOID"],
  },
};

export type StatusAction =
  | {
      action: ActionOn;
      basis: ActionBasis;
    }
  | { action: "applicant"; basis: "review"; reviews: ReviewEntry[] };

const GROUPS: ReadonlyArray<readonly [keyof StatusWording, StatusAction]> = [
  ["applicant", { action: "applicant", basis: "listed" }],
  ["cautious", { action: "applicant", basis: "cautious" }],
  ["authority", { action: "authority", basis: "listed" }],
  ["none", { action: "none", basis: "listed" }],
];

const UNLISTED: StatusAction = { action: "applicant", basis: "unlisted" };

const LOOKUP = new Map(
  Object.entries(STATUS_WORDING).map(([id, wording]) => [
    id,
    new Map(
      GROUPS.flatMap(([group, classified]) =>
        wording[group].map((status) => [wordingKey(status), classified] as const),
      ),
    ),
  ]),
);

export function statusAction(jurisdictionId: JurisdictionId, status: string | null): StatusAction | null {
  const wording = LOOKUP.get(jurisdictionId);

  if (!status || !wording) return null;

  return wording.get(wordingKey(status)) ?? UNLISTED;
}

export function permitAction(
  permit: Pick<PermitRow, "jurisdictionId" | "lastStatus" | "reviews">,
): StatusAction | null {
  const reviews = outstandingReviews(permit.reviews ?? []);

  return reviews.length > 0
    ? { action: "applicant", basis: "review", reviews }
    : statusAction(permit.jurisdictionId, permit.lastStatus);
}

export function actionLabel(classified: StatusAction): string {
  return classified.action === "applicant" && (classified.basis === "cautious" || classified.basis === "unlisted")
    ? `${actionText.applicant}?`
    : actionText[classified.action];
}

export function actionReason(classified: StatusAction): string | null {
  if (classified.basis === "review") return classified.reviews.map(describeReview).join("; ");

  if (classified.basis === "unlisted")
    return "This wording isn't on the jurisdiction's list, so it's marked AEC to be safe.";

  if (classified.basis === "cautious")
    return "Marked AEC to be safe: the record stopped short or the wording is unclear.";

  return null;
}
