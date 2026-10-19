import type { RunOutcome } from "./permit.js";

/** The short label shown for each check outcome. */
export const outcomeText: Record<RunOutcome, string> = {
  success: "Verified",
  not_found_in_supported_search: "Not found",
  ambiguous: "Multiple exact matches",
  identity_mismatch: "Permit number mismatch",
  status_unavailable: "Record status unavailable",
  record_link_unavailable: "Record link invalid",
  unsupported_page: "Portal page changed",
  blocked: "Portal blocked access",
  api_unavailable: "TypeSafe unavailable",
  authentication_error: "Key problem",
  browser_error: "Browser failed",
  timeout: "Check timed out",
  cancelled: "Cancelled",
};

/** Extra context only where the label alone doesn't say what happened or what to do. */
export const outcomeHelp: Partial<Record<RunOutcome, string>> = {
  not_found_in_supported_search: "No exact match in this jurisdiction's public search.",
  identity_mismatch: "The record showed a different permit number.",
  status_unavailable: "The record page had no verified permit status.",
  blocked: "The portal required login or human verification, or denied access.",
  api_unavailable: "Retrying within the hour.",
  authentication_error: "Check your key in Settings.",
  timeout: "Stopped after 3 minutes.",
};

/** Whether a check ended without a verified status for a reason other than being cancelled. */
export function isFailure(outcome: RunOutcome | null): boolean {
  return outcome !== null && outcome !== "success" && outcome !== "cancelled";
}
