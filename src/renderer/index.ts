import { PREFERENCE_KEYS, type KeyState, type PermitBridge } from "../shared/bridge.js";
import { keyProblem } from "../shared/key-format.js";
import { outcomeHelp, outcomeText } from "../shared/outcomes.js";
import { DEFAULT_CHECK_TIMES, describeCheckTimes, effectiveRunTime, formatCheckTime, MAX_CHECK_TIMES, normalizeCheckTimes, parseCheckTime, type CheckTimes } from "../shared/schedule.js";
import type { AppPreferences, AppSnapshot, PreferenceKey, PermitHistory, PermitRow, RunOutcome } from "../shared/permit.js";
import { dailyHistory } from "../shared/history.js";
import { groupByProject, PROJECT_NUMBER_MAX, PROJECT_NUMBER_PATTERN, projectKey, recentProjects, type ProjectGroup } from "../shared/projects.js";
import { getJurisdiction, isManualJurisdiction, JURISDICTION_GROUPS, JURISDICTIONS, numberExample } from "../shared/jurisdictions.js";
import { actionLabel, actionReason, statusAction, type StatusAction } from "../shared/action.js";

declare global { interface Window { permitMonitor: PermitBridge } }

const FILTERS = ["all", "applicant", "failed", "unverified"] as const;

type Filter = typeof FILTERS[number];

type OutcomeKind = "ok" | "failed" | "checking" | "none";

const api = window.permitMonitor;

let currentSnapshot: AppSnapshot | null = null;

let detailsPermitId: string | null = null;

let historyGeneration = 0;

/** The check state the displayed history reflects, so snapshots about other permits don't refetch it. */
let historyShown: string | null = null;

/** The check state a history request is under way for, so snapshots that arrive meanwhile don't request it again. */
let historyLoading: string | null = null;

let noticeTimer: number | null = null;

let filter: Filter = "all";

const knownPermitIds = new Set<string>();

let firstRender = true;

/** The page element with this id, checked to be the kind the code expects. */
function element(id: string): HTMLElement;

function element<T extends Element>(id: string, type: new () => T): T;

function element(id: string, type: new () => Element = HTMLElement): Element {
  const node = document.getElementById(id);

  if (!(node instanceof type)) throw new Error(`Missing interface element: ${id} (${type.name})`);

  return node;
}

/** The button matching `selector` that an event started in, if any. */
function eventButton(event: Event, selector: string): HTMLButtonElement | null {
  const button = event.target instanceof Element ? event.target.closest(selector) : null;

  return button instanceof HTMLButtonElement ? button : null;
}

function filterValue(value: string): Filter | null {
  return FILTERS.find((entry) => entry === value) ?? null;
}

function preferenceKey(value: string | undefined): PreferenceKey | null {
  return PREFERENCE_KEYS.find((key) => key === value) ?? null;
}

const stampFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const stampFormatWithYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const dateFormatWithYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** "Sep 24, 12:17 PM", adding the year only for earlier years. */
function stamp(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? stampFormat : stampFormatWithYear).format(date);
}

/** "Sep 24", adding the year only for earlier years. */
function dateOnly(value: string): string {
  const date = new Date(value);

  return (date.getFullYear() === new Date().getFullYear() ? dateFormat : dateFormatWithYear).format(date);
}

function timeNode(value: string | null, fallback = "—", format: (value: string) => string = stamp): HTMLElement {
  if (!value) return make("span", "muted", fallback);
  const node = make("time", "", format(value));
  node.dateTime = value;
  node.title = fullFormat.format(new Date(value));

  return node;
}

function outcomeKind(outcome: RunOutcome | null, checking = false): OutcomeKind {
  if (checking) return "checking";

  if (!outcome) return "none";

  if (outcome === "success") return "ok";

  return outcome === "cancelled" ? "none" : "failed";
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (className) node.className = className;

  if (text !== undefined) node.textContent = text;

  return node;
}

function icon(name: string, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);

  return svg;
}

function notice(message: string, kind: "info" | "error" = "error"): void {
  const node = element("notice", HTMLDivElement);
  element("notice-text").textContent = message;
  node.dataset.kind = kind;
  element("notice-icon", SVGUseElement).setAttribute("href", kind === "error" ? "#i-alert" : "#i-check");
  node.hidden = false;

  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { node.hidden = true; }, kind === "error" ? 9000 : 5000);
}

let settleConfirm: ((accepted: boolean) => void) | null = null;

function confirmAction(title: string, body: string, accept: string): Promise<boolean> {
  const dialog = element("confirm-dialog", HTMLDialogElement);
  element("confirm-title").textContent = title;
  element("confirm-body").textContent = body;
  element("confirm-accept", HTMLButtonElement).textContent = accept;
  settleConfirm?.(false);
  dialog.showModal();

  return new Promise((resolve) => { settleConfirm = resolve; });
}

function finishConfirm(accepted: boolean): void {
  const dialog = element("confirm-dialog", HTMLDialogElement);

  if (dialog.open) dialog.close();
  const settle = settleConfirm;
  settleConfirm = null;
  settle?.(accepted);
}

async function busy<T>(control: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  control.disabled = true;
  control.setAttribute("aria-busy", "true");

  try {
    return await work();
  } finally {
    control.disabled = false;
    control.removeAttribute("aria-busy");
  }
}

function outcomeCell(permit: PermitRow): HTMLElement {
  const kind = outcomeKind(permit.latestOutcome, permit.checking);
  const wrap = make("div", "outcome");
  wrap.dataset.kind = kind;
  const text = make("div", "outcome-text");

  if (permit.checking) {
    text.append(make("span", "outcome-label", "Checking…"));
  } else if (permit.latestOutcome) {
    const label = permit.latestOutcome === "success" && isManualJurisdiction(permit.jurisdictionId)
      ? "Checked by hand" : outcomeText[permit.latestOutcome];

    text.append(make("span", "outcome-label", label));
    const when = timeNode(permit.latestAttemptAt);
    when.classList.add("cell-sub");
    text.append(when);
  } else {
    text.append(make("span", "muted", "—"));
  }

  if (kind !== "none" || permit.checking) wrap.append(make("span", "dot"));
  wrap.append(text);

  return wrap;
}

/** Who the verified status waits on, as a small badge; an unclassified status shows a dash. AEC? marks a guess. */
function actionBadge(classified: StatusAction | null): HTMLElement {
  if (!classified) return make("span", "muted", "—");
  const badge = make("span", "action");
  badge.dataset.actionOn = classified.action;
  const reason = actionReason(classified);

  if (classified.action === "applicant" && classified.basis !== "listed") badge.dataset.tentative = "";

  if (reason) badge.title = reason;

  if (classified.action !== "none") badge.append(make("span", "dot"));
  badge.append(make("span", "", actionLabel(classified)));

  return badge;
}

function actionButton(label: string, action: string, permitId: string, className: string): HTMLButtonElement {
  const node = make("button", className, label);
  node.type = "button";
  node.dataset.action = action;
  node.dataset.permitId = permitId;

  return node;
}

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/** "now", "today at 12:30 PM", "tomorrow at 8:30 AM", or "Monday at 8:30 AM". */
function relativeTime(when: Date, now = new Date()): string {
  if (when.getTime() - now.getTime() < 60_000) return "now";
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(when) - startOf(now)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : dayFormat.format(when);

  return `${day} at ${clockFormat.format(when)}`;
}

function checkTimes(snapshot: AppSnapshot | null): CheckTimes {
  return (snapshot && normalizeCheckTimes(snapshot.checkTimes)) ?? DEFAULT_CHECK_TIMES;
}

function nextCheckSummary(snapshot: AppSnapshot): string {
  if (snapshot.monitoring !== "scheduled") return "";

  // Without a working key no scheduled check will start, so no time is promised; the key banner says why.
  if (snapshot.keyState !== "configured") return "Scheduled checks paused";
  const now = new Date();
  const schedule = checkTimes(snapshot);

  const times = snapshot.permits.filter((permit) => permit.monitoringEnabled && !permit.checking)
    .map((permit) => effectiveRunTime(new Date(permit.nextDueAt ?? now.toISOString()), now, schedule).getTime());

  if (times.length === 0) return "";
  const next = relativeTime(new Date(Math.min(...times)), now);

  return next === "now" ? "Next check now" : `Next check ${next}`;
}

/** One permit's row and the controls kept across updates, so a change elsewhere leaves focus where it was. */
interface PermitRowView {
  row: HTMLTableRowElement;
  identity: HTMLTableCellElement;
  open: HTMLButtonElement;
  jurisdiction: HTMLSpanElement;
  unscheduled: HTMLSpanElement;
  status: HTMLTableCellElement;
  action: HTMLTableCellElement;
  observed: HTMLTableCellElement;
  attempt: HTMLTableCellElement;
  check: HTMLButtonElement;
  record: HTMLButtonElement;
  /** What the row was last drawn from; an unchanged permit is skipped. */
  source: string;
}

const rowViews = new Map<string, PermitRowView>();

/** One tbody per project group (or one for the ungrouped list), kept like the rows. */
const groupBodies = new Map<string, HTMLTableSectionElement>();

/** Replaces a cell's content only when what it shows has changed. */
function setCell(cell: HTMLElement, source: string, build: () => Node[]): void {
  if (cell.dataset.source === source) return;
  cell.dataset.source = source;
  cell.replaceChildren(...build());
}

function createRow(permit: PermitRow): PermitRowView {
  const row = make("tr");

  if (!firstRender && !knownPermitIds.has(permit.id)) row.className = "row-enter";
  const identity = make("td");
  const open = actionButton(permit.permitNumber, "details", permit.id, "permit-link");
  const jurisdiction = make("span", "cell-sub");
  const unscheduled = make("span", "tag", "Not scheduled");
  identity.append(open, jurisdiction, unscheduled);
  const status = make("td");
  const action = make("td");
  const observed = make("td", "timestamp");
  const attempt = make("td");
  const controls = make("td");
  const actions = make("div", "row-actions");
  const check = actionButton("Check now", "check", permit.id, "btn btn-secondary");
  const record = actionButton("", "open", permit.id, "icon-button");
  record.append(icon("external"));
  record.title = "Open record";
  actions.append(check, record);
  controls.append(actions);
  row.append(identity, status, action, observed, attempt, controls);

  return { row, identity, open, jurisdiction, unscheduled, status, action, observed, attempt, check, record, source: "" };
}

/** Brings a row up to date, touching only the cells and controls whose content changed. */
function updateRow(view: PermitRowView, permit: PermitRow, classified: StatusAction | null, monitoring: AppSnapshot["monitoring"]): void {
  // The year matters because timestamps only show a year when it isn't the current one.
  const year = new Date().getFullYear();
  const source = JSON.stringify([permit, monitoring, year]);

  if (view.source === source) return;
  view.source = source;
  const label = getJurisdiction(permit.jurisdictionId)?.label ?? permit.jurisdictionId;
  view.open.textContent = permit.permitNumber;
  view.open.setAttribute("aria-label", [permit.permitNumber, label,
    permit.projectNumber ? `project ${permit.projectNumber}` : null, "details"].filter(Boolean).join(", "));
  view.jurisdiction.textContent = label;
  view.unscheduled.hidden = !(monitoring === "scheduled" && !permit.monitoringEnabled && !isManualJurisdiction(permit.jurisdictionId));

  setCell(view.status, JSON.stringify([permit.lastStatus]), () =>
    [permit.lastStatus ? make("span", "status-value", permit.lastStatus) : make("span", "muted", "—")]);

  setCell(view.action, JSON.stringify([classified]), () => [actionBadge(classified)]);

  if (classified) view.row.dataset.actionOn = classified.action;
  else delete view.row.dataset.actionOn;
  view.action.title = !classified && permit.lastStatus ? "Water management district statuses aren't classified yet." : "";

  setCell(view.observed, JSON.stringify([permit.lastObservedAt, year]), () => [timeNode(permit.lastObservedAt)]);
  setCell(view.attempt, JSON.stringify([permit.checking, permit.latestOutcome, permit.latestAttemptAt, permit.jurisdictionId, year]),
    () => [outcomeCell(permit)]);

  const control = permit.checking ? "cancel" : "check";

  if (view.check.dataset.action !== control) {
    view.check.dataset.action = control;
    view.check.textContent = permit.checking ? "Cancel" : "Check now";
  }

  view.record.disabled = !permit.lastRecordUrl;
  view.record.setAttribute("aria-label", `Open record for ${permit.permitNumber}`);
}

const permitCount = (count: number) => `${count} ${count === 1 ? "permit" : "permits"}`;

/** Keeps a project group's heading row first in its tbody, or removes it from the plain list. */
function syncGroupHead(body: HTMLTableSectionElement, group: ProjectGroup | null, count: number): void {
  const existing = body.rows[0]?.classList.contains("group-row") ? body.rows[0] : null;

  if (!group) {
    existing?.remove();

    return;
  }

  const head = existing ?? make("tr", "group-row");
  const source = JSON.stringify([group.projectNumber, count]);

  if (head.dataset.source !== source) {
    head.dataset.source = source;
    const cell = make("th");
    cell.scope = "rowgroup";
    cell.colSpan = 6;
    const wrap = make("div", "group-head");

    if (group.projectNumber) {
      wrap.append(make("span", "group-label", "Project"), make("span", "group-number", group.projectNumber));
    } else {
      wrap.append(make("span", "group-label", "No project"));
    }

    wrap.append(make("span", "group-count", permitCount(count)));
    cell.append(wrap);
    head.replaceChildren(cell);
  }

  if (!existing) body.prepend(head);
}

/**
 * Brings the table to `visible` without rebuilding it: rows are kept by permit id and moved only when the order or
 * grouping changes, so a focused link or button in an unchanged row keeps its focus.
 */
function renderTable(visible: readonly PermitRow[], classified: ReadonlyMap<string, StatusAction | null>, monitoring: AppSnapshot["monitoring"]): void {
  const table = element("permit-table", HTMLTableElement);
  const shown = new Set(visible.map((permit) => permit.id));

  // Rows leave first, so they never sit between rows that stay and force those to move.
  for (const [id, view] of rowViews) {
    if (!shown.has(id)) {
      view.row.remove();
      rowViews.delete(id);
    }
  }

  // Group only once a project number is in use; until then the table stays one plain list.
  const groups: Array<{ key: string; group: ProjectGroup | null; permits: readonly PermitRow[] }> = visible.some((permit) => permit.projectNumber)
    ? groupByProject(visible).map((group) => ({ key: group.projectNumber ? `project:${projectKey(group.projectNumber)}` : "unassigned", group, permits: group.permits }))
    : visible.length > 0 ? [{ key: "list", group: null, permits: visible }] : [];

  const keys = new Set(groups.map((entry) => entry.key));

  for (const [key, body] of groupBodies) {
    if (!keys.has(key)) {
      body.remove();
      groupBodies.delete(key);
    }
  }

  let previous: Element | null = table.tHead;

  for (const entry of groups) {
    const body = groupBodies.get(entry.key) ?? make("tbody", "permit-group");
    groupBodies.set(entry.key, body);

    if (previous?.nextElementSibling !== body) table.insertBefore(body, previous?.nextElementSibling ?? null);
    previous = body;
    syncGroupHead(body, entry.group, entry.permits.length);
    let cursor = entry.group ? body.rows[0]?.nextElementSibling ?? null : body.firstElementChild;

    for (const permit of entry.permits) {
      let view = rowViews.get(permit.id);

      if (!view) {
        view = createRow(permit);
        rowViews.set(permit.id, view);
      }

      updateRow(view, permit, classified.get(permit.id) ?? null, monitoring);

      if (view.row === cursor) cursor = cursor.nextElementSibling;
      else body.insertBefore(view.row, cursor);
    }
  }
}

/** AEC action includes the cautious AEC? badges, so nothing marked to be safe drops out of it. */
function matchesFilter(permit: PermitRow, which: Filter, classified: StatusAction | null): boolean {
  if (which === "applicant") return classified?.action === "applicant";

  if (which === "failed") return !permit.checking && outcomeKind(permit.latestOutcome) === "failed";

  if (which === "unverified") return !permit.lastStatus;

  return true;
}

/** What the window says about a key state that holds checks back. */
interface KeyStateCopy {
  banner: string;
  /** The banner button's label, which opens the key settings; null when saving a key can't help. */
  action: string | null;
  /** The note above the key field in Settings, if any. */
  settings: string | null;
}

function keyStateCopy(state: Exclude<KeyState, "configured">): KeyStateCopy {
  switch (state) {
    case "missing": return { banner: "Add your TypeSafe key to run checks.", action: "Add key", settings: null };
    case "unavailable": return { banner: "Key storage isn't available on this computer.", action: null, settings: "Key storage isn't available on this computer." };
    case "unreadable": return { banner: "Your saved TypeSafe key can't be read. Checks are paused.", action: "Save key again",
      settings: "The saved key can't be read. Paste it again to keep checking." };
    case "rejected": return { banner: "TypeSafe turned down your key. Scheduled checks are paused.", action: "Replace key",
      settings: "TypeSafe turned down the saved key. Paste a working key to resume scheduled checks." };
  }
}

/** The key banner stays up for as long as checks are held back for want of a key, whatever the notification settings. */
function renderKey(state: KeyState): void {
  const copy = state === "configured" ? null : keyStateCopy(state);
  element("key-banner").hidden = copy === null;
  element("key-banner-title").textContent = copy?.banner ?? "";
  const action = element("banner-add-key", HTMLButtonElement);
  action.hidden = !copy?.action;
  action.textContent = copy?.action ?? "";
  const note = element("settings-key-state");
  note.hidden = !copy?.settings;
  note.textContent = copy?.settings ?? "";
  element("key-form", HTMLFormElement).hidden = state === "unavailable";
  // A saved key that doesn't work is still saved: it can be replaced or removed.
  const saved = state === "configured" || state === "unreadable" || state === "rejected";
  element("key-input", HTMLInputElement).placeholder = state === "configured" ? "Saved. Paste a new key to replace it." : "Paste your API key";
  const save = element("key-save", HTMLButtonElement);
  save.textContent = saved ? "Replace" : "Save";
  save.className = `btn btn-sm ${state === "configured" ? "btn-secondary" : "btn-primary"}`;
  element("key-remove", HTMLButtonElement).hidden = !saved;
}

function renderPreferences(preferences: AppPreferences): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-pref]")) {
    const key = preferenceKey(input.dataset.pref);

    if (!key) continue;
    input.checked = preferences[key];

    if (key === "runInBackground") input.disabled = !preferences.backgroundAvailable;

    if (key === "openAtLogin") input.disabled = !preferences.openAtLoginAvailable;
  }

  const hint = (pref: string, available: boolean, text: string) => {
    const label = document.querySelector<HTMLElement>(`input[data-pref='${pref}']`)?.closest("label");

    if (label) label.title = available ? "" : text;
  };

  hint("runInBackground", preferences.backgroundAvailable, "Available on Windows.");
  hint("openAtLogin", preferences.openAtLoginAvailable, "Available in the installed app.");
}

function renderCheckTimeRows(times: readonly string[]): void {
  const rows = times.map((value, index) => {
    const row = make("li");
    const input = make("input");
    input.type = "time";
    input.required = true;
    input.value = value;
    input.setAttribute("aria-label", `Check time ${index + 1}`);
    const remove = make("button", "icon-button");
    remove.type = "button";
    remove.dataset.removeTime = String(index);
    remove.disabled = times.length === 1;
    const time = parseCheckTime(value);
    remove.setAttribute("aria-label", time ? `Remove ${clockFormat.format(new Date(2026, 0, 5, time.hour, time.minute))}` : "Remove time");
    remove.append(icon("close"));
    row.append(input, remove);

    return row;
  });

  element("check-time-list", HTMLUListElement).replaceChildren(...rows);
  element("add-check-time", HTMLButtonElement).disabled = times.length >= MAX_CHECK_TIMES;
}

function editedCheckTimes(): string[] {
  return [...element("check-time-list", HTMLUListElement).querySelectorAll("input")].flatMap((input) => (input.value ? [input.value] : []));
}

function renderSchedule(snapshot: AppSnapshot): void {
  const scheduled = snapshot.monitoring === "scheduled";
  element("schedule-help").textContent = scheduled
    ? `Checks run at ${describeCheckTimes(checkTimes(snapshot))} each day.`
    : "Checks only run when you click Check now.";
  element("check-times").hidden = !scheduled;
  // Leave the rows alone while someone is editing them; they re-sort when focus leaves.
  const list = element("check-time-list", HTMLUListElement);

  if (list.contains(document.activeElement)) return;
  const saved = checkTimes(snapshot).map(formatCheckTime);

  if (saved.join() !== editedCheckTimes().join() || list.children.length !== saved.length) renderCheckTimeRows(saved);
}

async function saveCheckTimes(times: string[]): Promise<void> {
  const result = await api.setCheckTimes(times);

  if (!result.ok) {
    notice(result.error);

    if (currentSnapshot) renderCheckTimeRows(checkTimes(currentSnapshot).map(formatCheckTime));
  }
}

/**
 * Shows a snapshot from main unless one with a higher revision is already shown, since pushed snapshots and direct
 * replies can arrive out of order. Returns whether it was shown.
 */
function applySnapshot(snapshot: AppSnapshot): boolean {
  if (currentSnapshot && snapshot.revision <= currentSnapshot.revision) return false;
  render(snapshot);

  return true;
}

function render(snapshot: AppSnapshot): void {
  currentSnapshot = snapshot;
  renderKey(snapshot.keyState);
  renderPreferences(snapshot.preferences);
  element("monitoring-mode", HTMLSelectElement).value = snapshot.monitoring;
  renderSchedule(snapshot);
  element("next-check").textContent = nextCheckSummary(snapshot);
  element("version").textContent = `Version ${snapshot.appVersion}`;

  const total = snapshot.permits.length;
  // Each permit is classified once per render, for its badge, the AEC count, and the filter.
  const classified = new Map(snapshot.permits.map((permit) => [permit.id, statusAction(permit.jurisdictionId, permit.lastStatus)]));
  const failed = snapshot.permits.filter((permit) => matchesFilter(permit, "failed", null)).length;
  const unverified = snapshot.permits.filter((permit) => matchesFilter(permit, "unverified", null)).length;
  const applicant = snapshot.permits.filter((permit) => matchesFilter(permit, "applicant", classified.get(permit.id) ?? null)).length;
  const counts: Record<Filter, number> = { all: total, applicant, failed, unverified };

  for (const option of element("permit-filter", HTMLSelectElement).options) {
    const key = filterValue(option.value);
    const count = key ? counts[key] : 0;
    option.textContent = count > 0 ? `${option.dataset.label} (${count})` : option.dataset.label ?? "";
  }

  const visible = snapshot.permits.filter((permit) => matchesFilter(permit, filter, classified.get(permit.id) ?? null));
  renderTable(visible, classified, snapshot.monitoring);

  element("permit-table", HTMLTableElement).hidden = visible.length === 0;
  const empty = element("empty-state");
  empty.hidden = visible.length > 0;
  // A filter that matches nothing says only that; it never reads as an all-clear.
  empty.textContent = total === 0 ? "No permits yet." : "No matches.";

  for (const permit of snapshot.permits) knownPermitIds.add(permit.id);
  firstRender = false;

  if (detailsPermitId) {
    const permit = snapshot.permits.find((entry) => entry.id === detailsPermitId);

    if (permit) renderDetailsSummary(permit); else closeSheet(element("details-sheet", HTMLDialogElement));
  }
}

function renderDetailsSummary(permit: PermitRow): void {
  element("details-title").textContent = permit.permitNumber;
  const jurisdictionLabel = element("details-jurisdiction");
  jurisdictionLabel.textContent = getJurisdiction(permit.jurisdictionId)?.label ?? permit.jurisdictionId;
  const status = element("details-status");
  status.textContent = permit.lastStatus ?? "No status yet";
  status.classList.toggle("muted", !permit.lastStatus);
  const action = statusAction(permit.jurisdictionId, permit.lastStatus);
  const actionSlot = element("details-action");
  actionSlot.hidden = !action;
  actionSlot.replaceChildren(...(action ? [make("span", "field-label", "Action"), actionBadge(action)] : []));
  const manual = isManualJurisdiction(permit.jurisdictionId);
  element("details-observed").textContent = permit.lastObservedAt
    ? `${manual ? "Entered" : "Verified"} ${stamp(permit.lastObservedAt)}` : "";
  const failure = element("details-failure");
  const failed = !permit.checking && permit.latestOutcome !== null && outcomeKind(permit.latestOutcome) === "failed";
  failure.hidden = !failed;
  failure.textContent = failed && permit.latestOutcome ? `Last check: ${outcomeText[permit.latestOutcome]}` : "";

  const check = element("details-check", HTMLButtonElement);
  check.textContent = permit.checking ? "Cancel" : "Check now";
  check.dataset.action = permit.checking ? "cancel" : "check";
  element("details-open", HTMLButtonElement).disabled = !permit.lastRecordUrl;
  const daily = element("details-daily", HTMLInputElement);
  daily.checked = permit.monitoringEnabled;
  // Scheduled checks can't read a hand-checked portal, so the option isn't offered.
  daily.closest<HTMLElement>("label")!.hidden = manual;

  const next = currentSnapshot?.monitoring === "scheduled" && permit.monitoringEnabled && !permit.checking
    ? relativeTime(effectiveRunTime(new Date(permit.nextDueAt ?? Date.now()), new Date(), checkTimes(currentSnapshot))) : null;

  element("details-daily-help").textContent = next ? `Next: ${next}` : "";
  element("details-remove", HTMLButtonElement).disabled = permit.checking;
  // Don't overwrite what someone is typing, or a value that failed to save.
  const project = element("details-project", HTMLInputElement);

  if (document.activeElement !== project && project.getAttribute("aria-invalid") !== "true") project.value = permit.projectNumber ?? "";
}

function renderJurisdictionOptions(): void {
  const select = element("jurisdiction", HTMLSelectElement);
  select.replaceChildren(...JURISDICTION_GROUPS.map((group) => {
    const optgroup = make("optgroup");
    optgroup.label = group.label;
    optgroup.append(...JURISDICTIONS.filter(group.includes).map((profile) => {
      const option = make("option", "", profile.label);
      option.value = profile.id;

      return option;
    }));

    return optgroup;
  }));
  renderJurisdictionHelp();
}

function renderJurisdictionHelp(): void {
  const profile = getJurisdiction(element("jurisdiction", HTMLSelectElement).value);
  element("jurisdiction-help").textContent = profile?.coverageNote ?? "";
  element("permit-number", HTMLInputElement).placeholder = (profile && numberExample(profile)) ?? "Full permit number";
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

  const list = element("history-list", HTMLOListElement);

  if (items.length === 0) list.replaceChildren(make("li", "timeline-empty", "No checks yet."));
  else list.replaceChildren(...items);
}

/** A permit's history only changes when its latest attempt or verified status does. */
function historyKey(permit: PermitRow): string {
  return JSON.stringify([permit.id, permit.latestAttemptAt, permit.latestOutcome, permit.lastObservedAt]);
}

/**
 * Fetches and shows a permit's history unless a request for the same check state is already under way. A newer
 * request, a different permit, or a closed sheet makes an older answer stale, and it is dropped.
 */
async function loadHistory(permit: PermitRow): Promise<void> {
  const key = historyKey(permit);

  if (key === historyLoading) return;
  const generation = ++historyGeneration;
  historyLoading = key;
  let result: Awaited<ReturnType<PermitBridge["history"]>>;

  try {
    result = await api.history(permit.id);
  } finally {
    if (generation === historyGeneration) historyLoading = null;
  }

  if (generation !== historyGeneration || detailsPermitId !== permit.id) return;

  if (result.ok) {
    renderHistory(result.value);
    historyShown = key;
  } else {
    notice(result.error);
  }
}

function openDetails(permitId: string): void {
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (!permit) return;
  const switching = detailsPermitId !== permitId;
  detailsPermitId = permitId;

  if (switching) setInlineError("details-project", "details-project-error", null);
  renderDetailsSummary(permit);
  const sheet = element("details-sheet", HTMLDialogElement);

  if (!sheet.open) sheet.showModal();

  // Reopening the permit already shown keeps its history, or the request already on its way.
  if (switching || historyKey(permit) !== historyShown) {
    element("history-list", HTMLOListElement).replaceChildren();
    historyShown = null;
    void loadHistory(permit);
  }
}

async function runPermitAction(action: string, permitId: string): Promise<void> {
  if (action === "details") {
    openDetails(permitId);

    return;
  }

  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (action === "check" && permit && isManualJurisdiction(permit.jurisdictionId)) {
    await startManualCheck(permit);

    return;
  }

  const result = action === "check" ? await api.checkNow(permitId)
    : action === "cancel" ? await api.cancel(permitId)
      : action === "open" ? await api.openRecord(permitId) : null;

  if (result && !result.ok) notice(result.error);
}

// Hand-checked permits: open the portal, then record what the user reads there.
let manualPermitId: string | null = null;

const manualDialog = element("manual-dialog", HTMLDialogElement);

async function startManualCheck(permit: PermitRow): Promise<void> {
  const result = await api.openPortal(permit.id);

  if (!result.ok) {
    notice(result.error);

    return;
  }

  const profile = getJurisdiction(permit.jurisdictionId);
  manualPermitId = permit.id;
  element("manual-jurisdiction").textContent = profile?.label ?? "";
  element("manual-title").textContent = permit.permitNumber;
  const status = element("manual-status", HTMLInputElement);
  status.value = permit.lastStatus ?? "";
  element("manual-link", HTMLInputElement).value = permit.lastRecordUrl && permit.lastRecordUrl !== profile?.startUrl
    ? permit.lastRecordUrl : "";
  setInlineError("manual-status", "manual-error", null);

  if (!manualDialog.open) manualDialog.showModal();
  status.focus();
  status.select();
}

function closeManual(): void {
  manualPermitId = null;

  if (manualDialog.open) manualDialog.close();
}

element("manual-status", HTMLInputElement).addEventListener("input", () => setInlineError("manual-status", "manual-error", null));

element("manual-cancel", HTMLButtonElement).addEventListener("click", closeManual);

manualDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeManual(); });

element("manual-reopen", HTMLButtonElement).addEventListener("click", async () => {
  if (!manualPermitId) return;
  const result = await api.openPortal(manualPermitId);

  if (!result.ok) setInlineError("manual-status", "manual-error", result.error);
});

element("manual-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const permitId = manualPermitId;

  if (!permitId) return;
  const status = element("manual-status", HTMLInputElement).value.trim();

  if (!status) {
    setInlineError("manual-status", "manual-error", "Enter the status shown on the portal.");
    element("manual-status", HTMLInputElement).focus();

    return;
  }

  const recordUrl = element("manual-link", HTMLInputElement).value.trim();
  const result = await busy(element("manual-save", HTMLButtonElement), () => api.recordManualStatus({ permitId, status, recordUrl }));

  if (!result.ok) {
    setInlineError("manual-status", "manual-error", result.error);

    return;
  }

  closeManual();
  notice("Status saved.", "info");
});

function setInlineError(inputId: string, errorId: string, message: string | null): void {
  const error = element(errorId);
  error.hidden = !message;
  error.textContent = message ?? "";
  const input = element(inputId, HTMLInputElement);

  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

function projectProblem(value: string): string | null {
  if (value.length > PROJECT_NUMBER_MAX) return `Use ${PROJECT_NUMBER_MAX} characters or fewer.`;

  return PROJECT_NUMBER_PATTERN.test(value) ? null : "Use letters, numbers, spaces, and - . _ / only.";
}

// Project number: asked once after a permit is added, editable later from its details.
const projectDialog = element("project-dialog", HTMLDialogElement);

let projectPermitId: string | null = null;

let settleProject: ((saved: string | null) => void) | null = null;

function askProjectNumber(permit: PermitRow): Promise<string | null> {
  settleProject?.(null);
  projectPermitId = permit.id;
  element("project-permit").textContent = permit.permitNumber;
  const others = currentSnapshot?.permits.filter((entry) => entry.id !== permit.id) ?? [];
  const recent = recentProjects(others, 5);
  const input = element("project-input", HTMLInputElement);
  // Permits tend to arrive a project at a time, so offer the last one used, selected so typing replaces it.
  input.value = recent[0] ?? "";
  element("project-recent").hidden = recent.length < 2;
  element("project-recent-list", HTMLUListElement).replaceChildren(...recent.map((number) => {
    const item = make("li");
    const chip = make("button", "project-chip", number);
    chip.type = "button";
    chip.dataset.project = number;
    item.append(chip);

    return item;
  }));
  setInlineError("project-input", "project-error", null);
  projectDialog.showModal();
  input.focus();
  input.select();

  return new Promise((resolve) => { settleProject = resolve; });
}

function finishProject(saved: string | null): void {
  projectPermitId = null;

  if (projectDialog.open) projectDialog.close();
  const settle = settleProject;
  settleProject = null;
  settle?.(saved);
}

element("project-input", HTMLInputElement).addEventListener("input", () => setInlineError("project-input", "project-error", null));

element("project-recent-list", HTMLUListElement).addEventListener("click", (event) => {
  const chip = eventButton(event, "button[data-project]");

  if (!chip?.dataset.project) return;
  const input = element("project-input", HTMLInputElement);
  input.value = chip.dataset.project;
  setInlineError("project-input", "project-error", null);
  input.focus();
});

element("project-skip", HTMLButtonElement).addEventListener("click", () => finishProject(null));

projectDialog.addEventListener("cancel", (event) => { event.preventDefault(); finishProject(null); });

projectDialog.addEventListener("click", (event) => { if (event.target === projectDialog) finishProject(null); });

element("project-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const permitId = projectPermitId;

  if (!permitId) return;
  const input = element("project-input", HTMLInputElement);
  const value = input.value.trim();

  if (!value) {
    finishProject(null);

    return;
  }

  const problem = projectProblem(value);

  if (problem) {
    setInlineError("project-input", "project-error", problem);
    input.focus();

    return;
  }

  const result = await busy(element("project-save", HTMLButtonElement), () => api.setProjectNumber(permitId, value));

  if (!result.ok) {
    setInlineError("project-input", "project-error", result.error);
    input.focus();

    return;
  }

  finishProject(value);
});

// Add form
element("permit-number", HTMLInputElement).addEventListener("input", () => setInlineError("permit-number", "permit-number-error", null));

element("add-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element("permit-number", HTMLInputElement);
  const number = input.value.trim();

  if (!number) {
    setInlineError("permit-number", "permit-number-error", "Enter a permit number.");
    input.focus();

    return;
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(number) || number.length < 3) {
    setInlineError("permit-number", "permit-number-error", "Use letters, numbers, hyphens, and dots only.");
    input.focus();

    return;
  }

  const jurisdiction = element("jurisdiction", HTMLSelectElement).value;
  const result = await busy(element("add-button", HTMLButtonElement), () => api.addAndCheck({ jurisdiction, permitNumber: number }));

  if (!result.ok) {
    setInlineError("permit-number", "permit-number-error", result.error);
    input.focus();

    return;
  }

  input.value = "";
  setInlineError("permit-number", "permit-number-error", null);

  if (filter !== "all") setFilter("all");
  applySnapshot(await api.snapshot());
  const added = currentSnapshot?.permits.find((entry) => entry.id === result.value);
  const project = added ? await askProjectNumber(added) : null;
  notice(project ? `${number} added to project ${project}.` : `${number} added.`, "info");

  if (added && isManualJurisdiction(added.jurisdictionId)) await startManualCheck(added);
});

// Key
function openKeySettings(): void {
  const sheet = element("settings-sheet", HTMLDialogElement);

  if (!sheet.open) sheet.showModal();
  element("key-input", HTMLInputElement).focus();
}

element("banner-add-key", HTMLButtonElement).addEventListener("click", openKeySettings);

element("key-input", HTMLInputElement).addEventListener("input", () => setInlineError("key-input", "key-error", null));

element("key-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element("key-input", HTMLInputElement);
  const problem = keyProblem(input.value.trim());

  if (problem) {
    setInlineError("key-input", "key-error", problem);
    input.focus();

    return;
  }

  // Clear the field before sending so the key does not linger in the window.
  const key = input.value.trim();
  input.value = "";
  const result = await busy(element("key-save", HTMLButtonElement), () => api.saveKey(key));

  if (!result.ok) {
    setInlineError("key-input", "key-error", result.error);
    input.focus();

    return;
  }

  setInlineError("key-input", "key-error", null);
  // Main sends the updated snapshot before it answers, so the banner is already current.
  notice("Key saved.", "info");
});

renderJurisdictionOptions();

element("jurisdiction", HTMLSelectElement).addEventListener("change", renderJurisdictionHelp);

element("key-remove", HTMLButtonElement).addEventListener("click", async () => {
  if (!(await confirmAction("Remove your TypeSafe key?", "Checks stop until you add a key.", "Remove"))) return;
  const result = await api.removeKey();

  if (!result.ok) {
    notice(result.error);

    return;
  }

  notice("Key removed.", "info");
});

// Schedule
const checkTimeList = element("check-time-list", HTMLUListElement);

checkTimeList.addEventListener("change", () => {
  // A half-cleared field reads as empty; wait until every row holds a full time.
  if ([...checkTimeList.querySelectorAll("input")].some((input) => !input.value)) return;
  void saveCheckTimes(editedCheckTimes());
});

checkTimeList.addEventListener("focusout", (event) => {
  if (event.relatedTarget instanceof Node && checkTimeList.contains(event.relatedTarget)) return;

  if (currentSnapshot) renderCheckTimeRows(checkTimes(currentSnapshot).map(formatCheckTime));
});

checkTimeList.addEventListener("click", (event) => {
  const target = eventButton(event, "button[data-remove-time]");

  if (!target) return;
  const times = editedCheckTimes();
  times.splice(Number(target.dataset.removeTime), 1);

  if (times.length === 0) return;
  // Focus leaves the row being removed so the refreshed list can replace it.
  element("add-check-time", HTMLButtonElement).focus();
  void saveCheckTimes(times);
});

element("add-check-time", HTMLButtonElement).addEventListener("click", () => {
  const times = editedCheckTimes();
  const taken = new Set(times);
  const last = parseCheckTime(times[times.length - 1] ?? "") ?? { hour: 8, minute: 0 };

  // Suggest an hour after the latest time, wrapping to the first free hour of the day.
  for (let step = 1; step <= 24; step += 1) {
    const candidate = formatCheckTime({ hour: (last.hour + step) % 24, minute: last.minute });

    if (!taken.has(candidate)) {
      void saveCheckTimes([...times, candidate]);

      return;
    }
  }
});

// Monitoring and filters
const monitoringMode = element("monitoring-mode", HTMLSelectElement);

monitoringMode.addEventListener("change", async () => {
  const mode = monitoringMode.value;

  if (mode !== "manual" && mode !== "scheduled") return;
  const result = await api.setMonitoring(mode);

  if (!result.ok) notice(result.error);
});

function setFilter(next: Filter): void {
  filter = next;
  element("permit-filter", HTMLSelectElement).value = next;

  if (currentSnapshot) render(currentSnapshot);
}

const permitFilter = element("permit-filter", HTMLSelectElement);

permitFilter.addEventListener("change", () => {
  const next = filterValue(permitFilter.value);

  if (next) setFilter(next);
});

// Table actions
element("permit-table", HTMLTableElement).addEventListener("click", (event) => {
  const target = eventButton(event, "button[data-action]");

  if (!target?.dataset.permitId || !target.dataset.action) return;
  void runPermitAction(target.dataset.action, target.dataset.permitId);
});

// Details sheet
const detailsSheet = element("details-sheet", HTMLDialogElement);

function closeSheet(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();

  if (dialog === detailsSheet) {
    detailsPermitId = null;
    historyGeneration += 1;
    historyShown = null;
    historyLoading = null;
  }
}

const detailsCheck = element("details-check", HTMLButtonElement);

detailsCheck.addEventListener("click", () => {
  const action = detailsCheck.dataset.action;

  if (detailsPermitId && action) void runPermitAction(action, detailsPermitId);
});

element("details-open", HTMLButtonElement).addEventListener("click", () => {
  if (detailsPermitId) void runPermitAction("open", detailsPermitId);
});

const detailsProject = element("details-project", HTMLInputElement);

detailsProject.addEventListener("input", () => setInlineError("details-project", "details-project-error", null));

detailsProject.addEventListener("keydown", (event) => {
  if (event.key === "Enter") detailsProject.blur();
});

// Saves when the field is committed (Enter or leaving it), like the other details settings.
detailsProject.addEventListener("change", async () => {
  const permitId = detailsPermitId;
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (!permitId || !permit) return;
  const value = detailsProject.value.trim();
  detailsProject.value = value;

  if (value === (permit.projectNumber ?? "")) return;
  const problem = projectProblem(value);

  if (problem) {
    setInlineError("details-project", "details-project-error", problem);

    return;
  }

  const result = await api.setProjectNumber(permitId, value);

  if (!result.ok) {
    setInlineError("details-project", "details-project-error", result.error);

    return;
  }

  notice(value ? "Project number saved." : "Project number cleared.", "info");
});

const detailsDaily = element("details-daily", HTMLInputElement);

detailsDaily.addEventListener("change", async () => {
  if (!detailsPermitId) return;
  const result = await api.setPermitMonitoring(detailsPermitId, detailsDaily.checked);

  if (!result.ok) notice(result.error);
});

element("details-remove", HTMLButtonElement).addEventListener("click", async () => {
  const permitId = detailsPermitId;
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (!permit || !permitId) return;

  if (!(await confirmAction(`Remove ${permit.permitNumber}?`, "Its history on this computer will be deleted.", "Remove"))) return;
  const result = await api.removePermit(permitId);

  if (!result.ok) {
    notice(result.error);

    return;
  }

  closeSheet(detailsSheet);
  notice(`${permit.permitNumber} removed.`, "info");
});

element("history-list", HTMLOListElement).addEventListener("click", async (event) => {
  const target = eventButton(event, "button[data-observation-id]");

  if (!target?.dataset.observationId) return;
  const result = await api.openObservationRecord(target.dataset.observationId);

  if (!result.ok) notice(result.error);
});

// Dialogs close on Escape, backdrop click, and their own buttons. State is reset here rather
// than in a "close" listener so it never depends on that event being delivered.
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet")) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeSheet(dialog); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeSheet(dialog); });
  dialog.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", () => closeSheet(dialog));
}

const confirmDialog = element("confirm-dialog", HTMLDialogElement);

confirmDialog.addEventListener("cancel", (event) => { event.preventDefault(); finishConfirm(false); });

confirmDialog.addEventListener("click", (event) => {
  if (event.target === confirmDialog) {
    finishConfirm(false);

    return;
  }

  const choice = eventButton(event, "button[value]")?.value;

  if (choice) { event.preventDefault(); finishConfirm(choice === "accept"); }
});

element("open-settings", HTMLButtonElement).addEventListener("click", () => element("settings-sheet", HTMLDialogElement).showModal());

// Updates
const checkUpdate = element("check-update", HTMLButtonElement);

checkUpdate.addEventListener("click", async () => {
  const status = element("update-status");
  status.hidden = false;
  element("download-update", HTMLButtonElement).hidden = true;
  element("install-update", HTMLButtonElement).hidden = true;
  const result = await busy(checkUpdate, () => api.checkForUpdate());

  if (!result.ok) {
    status.textContent = result.error;

    return;
  }

  if (result.value.state === "unavailable") status.textContent = "No update feed in this build.";
  else if (result.value.state === "current") status.textContent = "You're up to date.";
  else {
    status.textContent = `Version ${result.value.version} available (${Math.ceil(result.value.size / 1_000_000)} MB).`;
    element("download-update", HTMLButtonElement).hidden = false;
  }
});

element("download-update", HTMLButtonElement).addEventListener("click", async () => {
  const control = element("download-update", HTMLButtonElement);
  element("update-status").textContent = "Downloading… This can take a few minutes.";
  const result = await busy(control, () => api.downloadUpdate());

  if (!result.ok) {
    element("update-status").textContent = result.error;

    return;
  }

  control.hidden = true;
  element("update-status").textContent = `Version ${result.value} is ready to install.`;
  element("install-update", HTMLButtonElement).hidden = false;
});

element("install-update", HTMLButtonElement).addEventListener("click", async () => {
  if (!(await confirmAction("Install the update?", "Permit Monitor will close to install it.", "Install"))) return;
  const result = await api.installUpdate();

  if (!result.ok) notice(result.error);
});

element("delete-local-data", HTMLButtonElement).addEventListener("click", async () => {
  if (!(await confirmAction("Delete all data?", "Permits, history, and your key will be deleted and the app will close. This can't be undone.", "Delete"))) return;
  const result = await api.deleteLocalData("DELETE LOCAL DATA");

  if (!result.ok) notice(result.error);
});

api.onSnapshot((snapshot) => {
  if (!applySnapshot(snapshot)) return;
  const permit = detailsPermitId ? snapshot.permits.find((entry) => entry.id === detailsPermitId) : undefined;

  if (permit && historyKey(permit) !== historyShown) void loadHistory(permit);
});

api.onLocalError((message) => notice(message));

api.onOpenDetails((permitId) => {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet:not(#details-sheet)")) closeSheet(dialog);
  finishConfirm(false);
  finishProject(null);

  if (currentSnapshot?.permits.some((permit) => permit.id === permitId)) openDetails(permitId);
  else void api.snapshot().then((snapshot) => { applySnapshot(snapshot); openDetails(permitId); });
});

api.onAppEvent((event) => notice(`${event.title}: ${event.body}`, event.tone));

for (const input of document.querySelectorAll<HTMLInputElement>("input[data-pref]")) {
  const key = preferenceKey(input.dataset.pref);

  if (!key) continue;
  input.addEventListener("change", async () => {
    const result = await api.setPreference(key, input.checked);

    if (!result.ok) { input.checked = !input.checked; notice(result.error); }
  });
}

// Keeps the "Next check" time current between snapshots.
setInterval(() => { if (currentSnapshot) element("next-check").textContent = nextCheckSummary(currentSnapshot); }, 60_000);

void api.snapshot().then(applySnapshot);
