# Permit status wording and who acts next

This survey of the counties and cities in the jurisdiction menu was taken on September 27, 2026. The water management districts are not classified, and their permits show a dash in the Action column.

The app classifies the record-level status it saves into the Action column. The lists below are in `src/shared/action.ts`.

- **AEC**: the applicant has to act before the record moves. Examples are corrections, missing documents, plans not yet uploaded, fees due, or a hold the applicant clears.
- **AHJ**: the authority having jurisdiction is working on it, through intake, review, other-agency review, or issuing after payment. AHJ is used only where the survey saw the authority working under that wording.
- **None**: the record was issued, finished, or deliberately ended, such as withdrawn, void, or canceled.

When in doubt, a status counts as AEC's, and its badge reads **AEC?** so it stands apart from an explicit request. Looking at a permit that turns out to need nothing costs less than missing one that does. The "AEC, to be safe" column below covers two groups:

- wording the survey couldn't pin down
- records that stopped short, such as expired, denied, revoked, abandoned, or closed by staff, where someone at AEC should decide whether to renew, resubmit, or let it go

Wording is matched per authority, ignoring case and runs of spaces. The same words can mean different things on different portals, so nothing carries over between authorities. Wording an authority hasn't been seen to use also counts as AEC?, and the badge's tooltip says the wording isn't on the list.

## Method

Every value for an automated portal was read in the app's bundled headless Chromium with the worker's launch options. Accela and Click2Gov values came from search result lists and were confirmed on record detail pages with the same field the app reads. Hernando's came from the portal's own status dropdown, then from searches and record pages. Counts are records seen in that sample, not portal totals, except Hernando's, which are the portal's result counts. Samples lean toward recent commercial records, so rare wording may be missing.

## Accela: Hillsborough, Pasco, Tampa, Pinellas, Polk

Field: `Record Status` on the record page. About 830 records across the five tenants.

| Authority                                    | AEC                                                                                                                      | AEC, to be safe                                                                                                         | AHJ                                                                                                           | None                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Hillsborough (Building and Land Development) | Awaiting Client Reply (53)                                                                                               | Expired                                                                                                                 | In Process (56)                                                                                               | Issued, Complete, Withdrawn, Canceled, Cancel                                                                     |
| Pasco (Building and Permits)                 | Awaiting Plans (19), Denied - More Info Required (9), Fees Pending (6), Awaiting Revisions (4), Pending Client Input (1) | Pending Permit Issuance (2, not opened), Expired Permit                                                                 | Plan Review In Process (26), Plans Received (2), Pending Additional Review (1)                                | Permit Issued, Closed, Approved, Approved with Conditions, Final Inspection Complete, Withdrawn                   |
| Tampa (Building)                             | Awaiting Client Reply (70)                                                                                               | Revision (an issued permit with a separate revision record), Open (utility applications), Administrative Close, Expired | In Process (39, including 4 as "in Process")                                                                  | Issued, Complete, Withdrawn                                                                                       |
| Pinellas (Building)                          | Awaiting Applicant Action (24), Incomplete Submittal (8), Awaiting Plans (7), Awaiting Payment (6)                       | Closed - Expired Renewal: Deferred Payment                                                                              | In Review (21), Plans Received (11)                                                                           | Issued, Closed - Finaled, Closed - COC Issued, Closed - CO Issued, Closed - Supp-Rev Approved, Closed - Withdrawn |
| Polk (Building)                              | Additional Info Required (20), Waiting for Revisions (6), Fees Due (4)                                                   | Closure Verification (certificate task active while the applicant owes closing documents), Closed-Denied, Expired       | In Review (4), Application Received (3), Pending Issuance (3), Certificate Pending (4), Staff Researching (1) | Inspections (Polk's issued state), Closed-CO Issued, Closed-CC Issued, Closed-Complete, Closed-Withdrawn          |

Published wording that supports these:

- Tampa's [status comments guide](https://www.tampa.gov/sites/default/files/document/2022/accela_guide_find_permit_status_comments.pdf) describes "Awaiting Client Reply" emails as "permit-specific comments about missing items and/or actions required before the process can continue to the next step."
- Hillsborough's [Building Official Determination workflow](https://assets.contentstack.io/v3/assets/blteea73b27b731f985/blt1f1cf548e2dce8b3/65493d9a86da6f040a437b36/Building_Official_Determination_Workflow.pdf) lists "Awaiting Client Reply" at application review, review, and issuance.
- Polk's [Accela user guide](https://www.polkfl.gov/wp-content/uploads/2023/07/building-accela-user-guide.pdf): "Permits ready for payment will be in Fees Due status," and a permit card can be printed once "the record status is inspections."

### Where Record Status misses the hand-off

Record Status usually changes when a request goes to the applicant, and every record page opened agreed with its list status. Exceptions seen:

- Hillsborough HC-BLD-25-0076688 reads "In Process" while its active Application Review task last shows "Awaiting Client Reply" (September 18, 2025) with no resubmittal after it.
- Hillsborough HC-BLD-25-0076884 reads "In Process" after it was issued, while a revision record is pending.
- Pasco COMALT-2026-000516 reads "Plan Review In Process" while six of seven reviews already show "Revisions Required". Pasco releases the requests once every review finishes.
- Tampa's guide shows "In Process" with a certification task marked "Awaiting Client Reply" for fees due before the CO.

To catch these, the app also reads the public workflow under **Record Info > Processing Status** (`#tab-processing_status`), opening the tab when a tenant loads the history on demand. Each observation keeps every process's status, decision date, and due date. The rules are in `src/shared/reviews.ts`:

- The latest dated entry per process decides whether a response is required. A new pending round uses its due date and replaces that discipline's older corrections. Same-day events follow the portal's row order, oldest first.
- Explicit requests such as "Corrections Required", "Revisions Required", and "Awaiting Client Reply" set AEC action even while Record Status says "In Process".
- A later "Plans Submitted", "Plans Received", "Resubmitted", "Revisions Received", "Resubmittal Received", "Routed for Review", or "Routed for Electronic Review" event on Application Submittal, Application Review, Plans Distribution, or Plans Coordination supersedes older requests.
- A resubmittal on one discipline does not clear another discipline's corrections.
- Same-day requests stay actionable, because the portal gives no times to show they came before the submission.
- A document upload or payment alone does not prove the applicant answered the corrections.

The app keeps the exact Record Status and shows the review evidence separately. Each newly seen discipline or correction date sends a notification under the status-change notification setting. Unchanged requests stay quiet.

On September 28, 2026, HC-SITECON-26-0000004 showed how this plays out. Its Record Status read "In Process". Natural Resources required corrections dated September 24 and Site Engineer dated September 22, while Stormwater had a new pending round due September 22. The older July corrections from Stormwater and Plans Coordination did not drive the action.

## Tyler Civic Access: Hernando

Field: `Status` on the permit page. The portal's Permit Status dropdown lists 23 values. Hernando publishes no definitions, so these follow the wording and what each record's Holds, Fees, and workflow showed.

- **AEC**: Incomplete (38), Pending/Documents Needed (12), Requires Resubmittal (249), Fees Due (290), Approved / Pending Documents (155), On Hold (182), Health Department Hold (29), Stop Work Order (5).
- **AEC, to be safe**: Inactive (one record, with a review still scheduled), Denied (25), Expired, Plan Approval Expired.
- **AHJ**: Submitted (12), Submitted - Online (56), In Review (160), In Review v2, Awaiting Other Agency Reviews (15), Fees Paid (1).
- **None**: Issued (7,093), Issued - PPR INSP (131, private-provider inspections), Final (1,967), Complete (263), Void (807; the record page shows "Void*").

"On Hold" and "Health Department Hold" count as AEC because the holds seen were the applicant's to clear (a revision fee, a septic release), but the reason varies; the record's Holds tab gives it. Fees can also be due under another status: one plan record read "In Review" with $238.00 unpaid.

Plan records, with numbers such as DEVP-, SUB-, CSC-, or REZ-, show their status in a different field, `#label-PlanDetail-Status`. The app reads a `#/plan/` record from its plan fields and a `#/permit/` record from its permit fields, never one from the other. Plan statuses seen on September 28, 2026 include Requires Resubmittal, Void, and Deficient. Deficient isn't on the list above, so it shows as AEC?.

## Click2Gov: St. Petersburg

Field: `Application Status` on Status Detail. 5,792 applications from 13 address and name searches; 26 record pages matched their list status.

- **AEC**: EPLAN MISSING INFO (25), HOLD FOR NOTICE OF COMM (23), CHANGE OF CONTRACTOR HOLD (6), BAD CHECK HOLD (1), APPLICATION HOLD (test records only).
- **AEC, to be safe**: INSPECT HOLD PENDING REVI (2; the city cuts the wording at 25 characters), PENDING VERIFICATION (a test record only), ADMINISTRATIVELY CLOSED, EXPIRED, ABANDONED, REVOKED.
- **AHJ**: IN PROCESS (482).
- **None**: APPROVED FOR PERMIT (578; its permits show "PERMIT PRINTED"), C/O ISSUED, TEMP CO ISSUED, CERTIFICATE OF COMPLETION, COMPLETED, CLOSED, BUSINESS CO, BUSINESS CO WAIVER, VOID.

"IN PROCESS" covers most active work, including applications with corrections due or permits waiting for pickup. The Plan Tracking Status page shows each trade review's latest step: RFC ("Ready for corrections") and WFP ("Waiting for permit pickup") put the next step with the applicant, while a blank step means the review hasn't happened. Older RFC rows stay listed after a resubmittal, so only the latest row per agency counts. The app does not read this page.

## Checked by hand: Orange County, Palm Bay, and Baker County

Orange County's search requires a CAPTCHA and Palm Bay's requires a login, so their lists come from the authorities' published material, not from records the app read. Baker County's search is public but turns away the app's browser, so its list comes from records read in a visible browser. For all three, the user types the status they see.

### Orange County (Fast Track)

The county's Fast Track guide has a permit status key: the [interactive user guide](https://rise.articulate.com/share/zkiBlN_B0Nllr0XHpSuIBFwGzOU52KyQ#/) linked from Fast Track's home page, and section 5 of the [Fast Track user guide PDF](https://fasttrack.ocfl.net/OnlineServices/helpdocs/_ElectronicPlanSubmittalUploadGuide.pdf). Counts are from the county's published 2018 structure permit data ([GMB133](https://www.arcgis.com/home/item.html?id=668faa86d90a49fd906a65bcca22547d), 96,622 permits issued in 2018), which leans heavily toward late statuses.

- **AEC**: Internet Incomplete ("submittal fee(s) not paid, uploads incomplete"; voided after 30 days), Deficient and Deficiencies (a review found deficiencies), Not Approved (utilities or impact fee review; "please contact the relevant phone number"), Ready to Issue ("If any applicable fees have been identified, they will need to be paid prior to issuance," and the contractor must accept it; 26 in the data), Stop Work (36).
- **AEC, to be safe**: Address Pending (Zoning's move if a site plan is uploaded, the applicant's if not), Pending W/Comments (10, undefined), Expired (3,710), Application Expired (47).
- **AHJ**: Internet Pending (submitted, "upload verification and plan review are pending"), New (verified and ready to route), Review, Final Plan Prep/Final Issuance (also matched as the two separate phrases).
- **None**: Issued (11,032), CO (119), Complete (81,285), Closed (7, all with final dates), Replaced (345), Void.

Each permit also lists per-review statuses (Open, Approved, Deficient, Not Approved) and holds under separate links. The review wording that asks something of the applicant is listed, because a user may type it.

### City of Palm Bay (iMS)

iMS, by Intuitive Municipal Solutions, calls the status a milestone. Low confidence: each iMS city names its own milestones, and palmbayfl.gov turned away both curl and the app's browser, so the city's Digital Plan Room PDFs were not read.

- **AEC**: Pending (the vendor manual's term for unsubmitted applications), Disapproved (the wording of the city's completeness and plan review emails), Approved (Palm Bay's own video: staff "release any remaining fee balance… once you pay that balance your permit's automatically issued"), Open and Reopened (plan room comments and packages waiting on the applicant).
- **AEC, to be safe**: Answered (a comment answered, but the resubmittal isn't finished), Expired.
- **AHJ**: Submitted (confirmed in the city's completeness check video), Under Review (from the city's map legend for planning projects).
- **None**: Issued, Finaled, Completed, Closed (the vendor's standard wording; Lakeland, another iMS city, documents "Issued").

The city's public permit layer ([BuildingPermits](https://gis.palmbayfl.gov/arcgis/rest/services/GrowthManagement/BuildingPermits/FeatureServer/0)) has a `PermitStatus` field but timed out on every query.

### Baker County (ADG CitizenLink)

Field: `Permit Status` on the Permit Search record. 194 records sampled on September 28, 2026, spread across record IDs from 2008 to 2026: ACTIVE (45), COMPLT (137), VOID (1), and 11 with no status.

- **AEC, to be safe**: ACTIVE, Expired. ACTIVE covers every open permit, from a new house awaiting its first inspection to one past its expiry date. Four of the 45 ACTIVE records carried a "This permit expired on" banner above the unchanged status, so the status alone can't say whose move it is. Expired is the banner's wording, in case it's typed instead.
- **None**: COMPLT, VOID.

No AHJ wording was seen. The record's Inspections Requested, Scheduled, and Completed tabs show progress in more detail.
