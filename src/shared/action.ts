import type { JurisdictionId } from "./jurisdictions.js";
import type { PermitRow } from "./permit.js";
import { describeReview, outstandingReviews, type ReviewEntry } from "./reviews.js";
import { wordingKey } from "./wording-key.js";

/** Who a verified status waits on: the applicant (AEC), the issuing authority (the AHJ), or no one. */
export type ActionOn = "applicant" | "authority" | "none";

const actionText: Record<ActionOn, string> = { applicant: "AEC", authority: "AHJ", none: "None" };

/**
 * How a classification was reached: `listed` wording the survey saw the authority use with that meaning, `cautious`
 * wording counted as AEC's to be safe (the record stopped short or the wording couldn't be pinned down), or `unlisted`
 * wording not on the authority's list.
 */
export type ActionBasis = "listed" | "cautious" | "unlisted";

/** The survey's wording groups for one authority. `cautious` is the survey's "AEC, to be safe" column. */
type StatusWording = Readonly<Record<ActionOn | "cautious", readonly string[]>>;

/**
 * Each county and city portal's status wording, as its records displayed it in September 2026 (see
 * docs/PERMIT_STATUSES.md). When in doubt a status counts as AEC's: holds, wording the survey couldn't pin down,
 * and records that stopped short (expired, denied, revoked, abandoned, closed by staff) all need someone at AEC to
 * look. They are listed apart from explicit requests so the badge can mark them. AHJ is only for wording the survey saw
 * the authority working under, and None only for records that were issued, finished, or deliberately ended.
 */
export const STATUS_WORDING: Partial<Record<JurisdictionId, StatusWording>> = {
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
  // Hand-checked portals: the wording their own guides and published data use, since the user types what they see.
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

/** Who a status waits on, and how the wording led there. */
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

/**
 * Who the authority's status wording leaves the next step to. Wording the authority hasn't been seen to use counts as
 * AEC's (`unlisted`), so a new status gets looked at. Null for an empty status or a jurisdiction without a wording
 * list, such as the water management districts.
 */
export function statusAction(jurisdictionId: JurisdictionId, status: string | null): StatusAction | null {
  const wording = LOOKUP.get(jurisdictionId);

  if (!status || !wording) return null;

  return wording.get(wordingKey(status)) ?? UNLISTED;
}

/** Current review requests take precedence over the record status, which can lag even on issued revision records. */
export function permitAction(
  permit: Pick<PermitRow, "jurisdictionId" | "lastStatus" | "reviews">,
): StatusAction | null {
  const reviews = outstandingReviews(permit.reviews ?? []);

  return reviews.length > 0
    ? { action: "applicant", basis: "review", reviews }
    : statusAction(permit.jurisdictionId, permit.lastStatus);
}

/** The badge text: "AEC?" marks a cautious or unlisted AEC so it reads apart from an explicit request. */
export function actionLabel(classified: StatusAction): string {
  return classified.action === "applicant" && (classified.basis === "cautious" || classified.basis === "unlisted")
    ? `${actionText.applicant}?`
    : actionText[classified.action];
}

/** Why a badge reads as it does, for its tooltip; null when the label says enough. */
export function actionReason(classified: StatusAction): string | null {
  if (classified.basis === "review") return classified.reviews.map(describeReview).join("; ");

  if (classified.basis === "unlisted")
    return "This wording isn't on the jurisdiction's list, so it's marked AEC to be safe.";

  if (classified.basis === "cautious")
    return "Marked AEC to be safe: the record stopped short or the wording is unclear.";

  return null;
}
