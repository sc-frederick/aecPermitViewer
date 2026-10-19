import { permitAction } from "../shared/action.js";
import type { AppSnapshot, BridgeResult } from "../shared/bridge.js";
import { dailyHistory } from "../shared/history.js";
import { getJurisdiction, isManualJurisdiction } from "../shared/jurisdictions.js";
import { outcomeHelp, outcomeText } from "../shared/outcomes.js";
import type { PermitHistory, PermitRow } from "../shared/permit.js";
import { projectProblem } from "../shared/project-number.js";
import { describeReview, latestReviews, outstandingReviews, reviewRequestKey } from "../shared/reviews.js";
import { effectiveRunTime } from "../shared/schedule.js";
import { busy, element, eventButton, icon, make, setInlineError } from "./dom.js";
import { dateOnly, relativeTime, stamp, timeNode } from "./format.js";
import { closeSheet, confirmAction, notice, onSheetClose } from "./overlays.js";
import { actionBadge, matchesFilter, outcomeKind } from "./permit-table.js";
import { checkTimes } from "./schedule-settings.js";
import { api, NO_ANSWER, ui } from "./state.js";

const detailsSheet = element("details-sheet", HTMLDialogElement);

const detailsTitle = element("details-title");

const detailsJurisdiction = element("details-jurisdiction");

const detailsStatus = element("details-status");

const detailsAction = element("details-action");

const detailsReviews = element("details-reviews");

const detailsReviewList = element("details-review-list");

const detailsReviewEmpty = element("details-review-empty");

const detailsObserved = element("details-observed");

const detailsFailure = element("details-failure");

const detailsCheck = element("details-check", HTMLButtonElement);

const detailsOpen = element("details-open", HTMLButtonElement);

const detailsDaily = element("details-daily", HTMLInputElement);

const detailsDailyOption = element("details-daily-option");

const detailsDailyHelp = element("details-daily-help");

const detailsRemove = element("details-remove", HTMLButtonElement);

const detailsProject = element("details-project", HTMLInputElement);

const detailsProjectError = element("details-project-error");

const historyList = element("history-list", HTMLOListElement);

let historyGeneration = 0;

let loadedHistory: PermitHistory | null = null;

let historyShown: string | null = null;

let historyLoading: string | null = null;

let historyFailed: string | null = null;

function renderDetailsSummary(permit: PermitRow): void {
  detailsTitle.textContent = permit.permitNumber;
  detailsJurisdiction.textContent = getJurisdiction(permit.jurisdictionId)?.label ?? permit.jurisdictionId;
  detailsStatus.textContent = permit.lastStatus ?? "No status yet";
  detailsStatus.classList.toggle("muted", !permit.lastStatus);
  const action = permitAction(permit);
  detailsAction.hidden = !action;
  detailsAction.replaceChildren(...(action ? [make("span", "field-label", "Action"), actionBadge(action)] : []));
  detailsReviews.hidden = permit.reviews === null;
  const requests = new Set(outstandingReviews(permit.reviews ?? []).map(reviewRequestKey));

  const reviews = latestReviews(permit.reviews ?? []).sort((left, right) => {
    const leftRequired = requests.has(reviewRequestKey(left));
    const rightRequired = requests.has(reviewRequestKey(right));

    if (leftRequired !== rightRequired) return leftRequired ? -1 : 1;

    return leftRequired ? (right.date ?? "").localeCompare(left.date ?? "") : 0;
  });

  detailsReviewList.replaceChildren(
    ...reviews.map((review) => {
      const item = make("li");
      const required = requests.has(reviewRequestKey(review));
      item.append(make("strong", "", review.process));
      item.append(make("span", "", review.status ?? "Pending"));

      if (review.date) item.append(make("span", "detail-meta", `Updated ${review.date}`));
      else if (review.dueDate) item.append(make("span", "detail-meta", `Due ${review.dueDate}`));

      if (required) item.append(make("span", "review-request", "AEC response required"));
      else if (outstandingReviews([review]).length > 0)
        item.append(make("span", "detail-meta", "Superseded by a later submission"));

      return item;
    }),
  );
  detailsReviewEmpty.hidden = reviews.length > 0;
  const manual = isManualJurisdiction(permit.jurisdictionId);
  detailsObserved.textContent = permit.lastObservedAt
    ? `${manual ? "Entered" : "Verified"} ${stamp(permit.lastObservedAt)}`
    : "";
  const failed = matchesFilter(permit, "failed", null);
  detailsFailure.hidden = !failed;
  detailsFailure.textContent = failed && permit.latestOutcome ? `Last check: ${outcomeText[permit.latestOutcome]}` : "";

  detailsCheck.textContent = permit.checking ? "Cancel" : "Check now";
  detailsCheck.dataset.action = permit.checking ? "cancel" : "check";
  detailsOpen.disabled = !permit.lastRecordUrl;
  detailsDaily.checked = permit.monitoringEnabled;
  detailsDailyOption.hidden = manual;

  const next =
    ui.currentSnapshot?.monitoring === "scheduled" && permit.monitoringEnabled && !permit.checking
      ? relativeTime(
          effectiveRunTime(new Date(permit.nextDueAt ?? Date.now()), new Date(), checkTimes(ui.currentSnapshot)),
        )
      : null;

  detailsDailyHelp.textContent = next ? `Next: ${next}` : "";
  detailsRemove.disabled = permit.checking;
  detailsProject.readOnly = ui.currentSnapshot?.share.mode === "following";

  if (document.activeElement !== detailsProject && detailsProject.getAttribute("aria-invalid") !== "true")
    detailsProject.value = permit.projectNumber ?? "";
}

function renderHistory(history: PermitHistory): void {
  const items = dailyHistory(history).map(({ run, observation }) => {
    const item = make("li");
    const kind = run.outcome ? outcomeKind(run.outcome) : "checking";
    item.dataset.kind = kind;
    item.append(make("span", "dot"));
    const body = make("div");

    if (observation) {
      body.append(make("strong", "", observation.statusValue));

      for (const review of outstandingReviews(observation.reviews ?? [])) {
        body.append(make("span", "cell-sub", describeReview(review)));
      }

      body.append(timeNode(observation.observedAt, undefined, dateOnly));
      const link = make("button", "link-button", "Open record");
      link.type = "button";
      link.dataset.observationId = observation.id;
      link.append(icon("external"));
      body.append(link);
    } else {
      body.append(make("strong", "", run.outcome ? outcomeText[run.outcome] : "Checking…"));
      body.append(timeNode(run.finishedAt ?? run.startedAt, undefined, dateOnly));
      const help = run.outcome ? outcomeHelp[run.outcome] : undefined;

      if (help) body.append(make("p", "", help));
    }

    item.append(body);

    return item;
  });

  if (items.length === 0) historyList.replaceChildren(make("li", "timeline-empty", "No checks yet."));
  else historyList.replaceChildren(...items);

  if (history.nextBefore) {
    const item = make("li");
    const more = make("button", "link-button", "Load older history");
    more.type = "button";
    more.dataset.historyMore = history.nextBefore;
    item.append(more);
    historyList.append(item);
  }
}

function renderHistoryFailure(message: string): void {
  const item = make("li", "timeline-error");
  const body = make("div");
  const retry = make("button", "link-button", "Try again");
  retry.type = "button";
  retry.dataset.historyRetry = "";
  body.append(make("strong", "", "History didn't load."), make("p", "", message), retry);
  item.append(body);
  historyList.replaceChildren(item);
}

function historyKey(permit: PermitRow): string {
  return JSON.stringify([permit.id, permit.latestAttemptAt, permit.latestOutcome, permit.lastObservedAt]);
}

async function loadHistory(permit: PermitRow, before?: string): Promise<void> {
  const key = historyKey(permit);

  if (key === historyLoading) return;
  const generation = ++historyGeneration;
  historyLoading = key;

  const result = await api
    .history(permit.id, before)
    .catch((): BridgeResult<PermitHistory> => ({ ok: false, error: NO_ANSWER }));

  if (generation !== historyGeneration) return;
  historyLoading = null;

  if (ui.detailsPermitId !== permit.id) return;

  if (result.ok) {
    loadedHistory =
      before && loadedHistory
        ? {
            runs: [...loadedHistory.runs, ...result.value.runs],
            observations: [...loadedHistory.observations, ...result.value.observations],
            nextBefore: result.value.nextBefore ?? null,
          }
        : result.value;
    renderHistory(loadedHistory);
    historyShown = key;
    historyFailed = null;
  } else if (before) {
    notice(result.error);
  } else {
    loadedHistory = null;
    renderHistoryFailure(result.error);
    historyShown = null;
    historyFailed = key;
  }
}

/** Opens the details sheet on a permit in the current snapshot; does nothing for a permit it doesn't hold. */
export function openDetails(permitId: string): void {
  const permit = ui.currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (!permit) return;
  const switching = ui.detailsPermitId !== permitId;
  ui.detailsPermitId = permitId;

  if (switching) setInlineError(detailsProject, detailsProjectError, null);
  renderDetailsSummary(permit);

  if (!detailsSheet.open) detailsSheet.showModal();

  if (switching || historyKey(permit) !== historyShown) {
    historyList.replaceChildren();
    historyShown = null;
    historyFailed = null;
    void loadHistory(permit);
  }
}

/** Redraws the open details sheet from `snapshot`, or closes the sheet when `snapshot` doesn't list its permit. */
export function renderDetails(snapshot: AppSnapshot): void {
  if (ui.detailsPermitId) {
    const permit = snapshot.permits.find((entry) => entry.id === ui.detailsPermitId);

    if (permit) renderDetailsSummary(permit);
    else closeSheet(detailsSheet);
  }
}

/**
 * Reloads the open permit's history when `snapshot` changed it. A read that failed for the same history stays on
 * screen with its retry.
 */
export function refreshHistory(snapshot: AppSnapshot): void {
  const permit = ui.detailsPermitId ? snapshot.permits.find((entry) => entry.id === ui.detailsPermitId) : undefined;

  if (permit && historyKey(permit) !== historyShown && historyKey(permit) !== historyFailed) void loadHistory(permit);
}

function resetDetails(): void {
  ui.detailsPermitId = null;
  historyGeneration += 1;
  historyShown = null;
  historyLoading = null;
  historyFailed = null;
}

async function openObservationRecord(observationId: string): Promise<void> {
  const result = await api.openObservationRecord(observationId);

  if (!result.ok) notice(result.error);
}

/** Wires the details sheet's project number, schedule option, removal, and history list. */
export function initPermitDetails(): void {
  onSheetClose(detailsSheet, resetDetails);

  detailsProject.addEventListener("input", () => setInlineError(detailsProject, detailsProjectError, null));

  detailsProject.addEventListener("keydown", (event) => {
    if (event.key === "Enter") detailsProject.blur();
  });

  detailsProject.addEventListener("change", async () => {
    const permitId = ui.detailsPermitId;
    const permit = ui.currentSnapshot?.permits.find((entry) => entry.id === permitId);

    if (!permitId || !permit) return;
    const value = detailsProject.value.trim();
    detailsProject.value = value;

    if (value === (permit.projectNumber ?? "")) return;
    const problem = projectProblem(value);

    if (problem) {
      setInlineError(detailsProject, detailsProjectError, problem);

      return;
    }

    const result = await api.setProjectNumber(permitId, value);

    if (!result.ok) {
      setInlineError(detailsProject, detailsProjectError, result.error);

      return;
    }

    notice(value ? "Project number saved." : "Project number cleared.", "info");
  });

  detailsDaily.addEventListener("change", async () => {
    if (!ui.detailsPermitId) return;
    const result = await api.setPermitMonitoring(ui.detailsPermitId, detailsDaily.checked);

    if (!result.ok) notice(result.error);
  });

  detailsRemove.addEventListener("click", async () => {
    const permitId = ui.detailsPermitId;
    const permit = ui.currentSnapshot?.permits.find((entry) => entry.id === permitId);

    if (!permit || !permitId) return;

    if (
      !(await confirmAction(
        `Remove ${permit.permitNumber}?`,
        "Its history on this computer will be deleted.",
        "Remove",
      ))
    )
      return;
    const result = await api.removePermit(permitId);

    if (!result.ok) {
      notice(result.error);

      return;
    }

    closeSheet(detailsSheet);
    notice(`${permit.permitNumber} removed.`, "info");
  });

  historyList.addEventListener("click", (event) => {
    const retry = eventButton(event, "button[data-history-retry]");
    const permit = ui.currentSnapshot?.permits.find((entry) => entry.id === ui.detailsPermitId);
    const more = eventButton(event, "button[data-history-more]");
    const record = eventButton(event, "button[data-observation-id]");

    if (retry && permit) void busy(retry, () => loadHistory(permit));
    else if (more?.dataset.historyMore && permit) void busy(more, () => loadHistory(permit, more.dataset.historyMore));
    else if (record?.dataset.observationId) void openObservationRecord(record.dataset.observationId);
  });
}
