import { permitAction } from "../shared/action.js";
import type { AppSnapshot } from "../shared/permit.js";
import { effectiveRunTime } from "../shared/schedule.js";
import { element } from "./dom.js";
import { relativeTime, stamp } from "./format.js";
import { notice } from "./overlays.js";
import { renderDetails } from "./permit-details.js";
import { matchesFilter, renderTable } from "./permit-table.js";
import { checkTimes, renderSchedule } from "./schedule-settings.js";
import { renderKey, renderPreferences } from "./settings.js";
import { renderShare } from "./share-settings.js";
import { api, filterValue, NO_ANSWER, ui, type Filter } from "./state.js";

const nextCheck = element("next-check");

const version = element("version");

const permitFilter = element("permit-filter", HTMLSelectElement);

const emptyState = element("empty-state");

function nextCheckSummary(snapshot: AppSnapshot): string {
  // A followed list is checked by the app that shares it; the header says how current this copy is instead.
  if (snapshot.share.mode === "following") {
    if (snapshot.share.problem) return "Shared list · couldn't update";

    return snapshot.share.publishedAt ? `Shared list · updated ${stamp(snapshot.share.publishedAt)}` : "Shared list";
  }

  if (snapshot.monitoring !== "scheduled") return "";

  // Without a working key no scheduled check will start, so no time is promised; the key banner says why.
  if (snapshot.keyState !== "configured") return "Scheduled checks paused";
  const now = new Date();
  const schedule = checkTimes(snapshot);

  const times = snapshot.permits
    .filter((permit) => permit.monitoringEnabled && !permit.checking)
    .map((permit) => effectiveRunTime(new Date(permit.nextDueAt ?? now.toISOString()), now, schedule).getTime());

  if (times.length === 0) return "";
  const next = relativeTime(new Date(Math.min(...times)), now);

  return next === "now" ? "Next check now" : `Next check ${next}`;
}

function render(snapshot: AppSnapshot): void {
  ui.currentSnapshot = snapshot;
  const following = snapshot.share.mode === "following";
  document.body.toggleAttribute("data-following", following);
  renderShare(snapshot.share);
  renderKey(snapshot.keyState);
  renderPreferences(snapshot.preferences, snapshot.platform);
  renderSchedule(snapshot);
  nextCheck.textContent = nextCheckSummary(snapshot);
  version.textContent = `Version ${snapshot.appVersion}`;

  const total = snapshot.permits.length;
  // Classify each permit once per render; the badge, the AEC count, and the filter all share the result.
  const classified = new Map(snapshot.permits.map((permit) => [permit.id, permitAction(permit)]));
  const failed = snapshot.permits.filter((permit) => matchesFilter(permit, "failed", null)).length;
  const unverified = snapshot.permits.filter((permit) => matchesFilter(permit, "unverified", null)).length;

  const applicant = snapshot.permits.filter((permit) =>
    matchesFilter(permit, "applicant", classified.get(permit.id) ?? null),
  ).length;

  const counts: Record<Filter, number> = { all: total, applicant, failed, unverified };

  for (const option of permitFilter.options) {
    const key = filterValue(option.value);
    const count = key ? counts[key] : 0;
    option.textContent = count > 0 ? `${option.dataset.label} (${count})` : (option.dataset.label ?? "");
  }

  const visible = snapshot.permits.filter((permit) =>
    matchesFilter(permit, ui.filter, classified.get(permit.id) ?? null),
  );

  // "Not scheduled" is about this app's own schedule, which a followed list isn't on.
  renderTable(visible, classified, following ? "manual" : snapshot.monitoring);
  emptyState.hidden = visible.length > 0;
  // A filter that matches nothing says only that; it never reads as an all-clear.
  emptyState.textContent =
    total > 0 ? "No matches." : following ? "The shared list has no permits." : "No permits yet.";

  ui.knownPermitIds = new Set(snapshot.permits.map((permit) => permit.id));
  ui.firstRender = false;
  renderDetails(snapshot);
}

/**
 * Renders a snapshot from main unless one with the same or a higher revision is already shown, since pushed snapshots
 * and direct replies can arrive out of order. Returns whether it rendered.
 */
export function applySnapshot(snapshot: AppSnapshot): boolean {
  if (ui.currentSnapshot && snapshot.revision <= ui.currentSnapshot.revision) return false;
  render(snapshot);

  return true;
}

/**
 * Asks main for its snapshot and applies it. Returns false, after a notice, when the call rejects: as with a history
 * read, a rejection means main never answered.
 */
export async function fetchSnapshot(): Promise<boolean> {
  const snapshot = await api.snapshot().catch(() => null);

  if (!snapshot) {
    notice(NO_ANSWER);

    return false;
  }

  applySnapshot(snapshot);

  return true;
}

/** Switches the table filter and the filter menu to `next` and redraws the current snapshot. */
export function setFilter(next: Filter): void {
  ui.filter = next;
  permitFilter.value = next;

  if (ui.currentSnapshot) render(ui.currentSnapshot);
}

/** Wires the filter menu above the table. */
export function initPermitFilter(): void {
  permitFilter.addEventListener("change", () => {
    const next = filterValue(permitFilter.value);

    if (next) setFilter(next);
  });
}

/** Keeps the header's "Next check" time current between snapshots. */
export function startNextCheckClock(): void {
  setInterval(() => {
    if (ui.currentSnapshot) nextCheck.textContent = nextCheckSummary(ui.currentSnapshot);
  }, 60_000);
}
