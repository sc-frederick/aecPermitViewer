import { PREFERENCE_KEYS, type PermitBridge } from "../shared/bridge.js";
import { keyProblem } from "../shared/key-format.js";
import { outcomeHelp, outcomeText } from "../shared/outcomes.js";
import { DEFAULT_CHECK_TIMES, describeCheckTimes, effectiveRunTime, formatCheckTime, MAX_CHECK_TIMES, normalizeCheckTimes, parseCheckTime, type CheckTimes } from "../shared/schedule.js";
import type { AppPreferences, AppSnapshot, PreferenceKey, PermitHistory, PermitRow, RunOutcome } from "../shared/permit.js";
import { dailyHistory } from "../shared/history.js";
import { groupByProject, recentProjects, type ProjectGroup } from "../shared/projects.js";
import { getJurisdiction, isManualJurisdiction, JURISDICTION_GROUPS, JURISDICTIONS, numberExample } from "../shared/jurisdictions.js";
import { actionOn, actionText, statusAction, type StatusAction } from "../shared/action.js";

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

/** What the permit table was last built from; an unchanged table is left alone. */
let tableSource = "";

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

/** Who the verified status waits on, as a small badge; an unclassified status shows a dash. */
function actionBadge(classified: StatusAction | null): HTMLElement {
  if (!classified) return make("span", "muted", "—");
  const badge = make("span", "action");
  badge.dataset.actionOn = classified.action;

  if (!classified.listed) badge.title = "This wording isn't on the jurisdiction's list, so it's marked AEC to be safe.";

  if (classified.action !== "none") badge.append(make("span", "dot"));
  badge.append(make("span", "", actionText[classified.action]));

  return badge;
}

function actionButton(label: string, action: string, permit: PermitRow, className: string): HTMLButtonElement {
  const node = make("button", className, label);
  node.type = "button";
  node.dataset.action = action;
  node.dataset.permitId = permit.id;

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
  const now = new Date();
  const schedule = checkTimes(snapshot);

  const times = snapshot.permits.filter((permit) => permit.monitoringEnabled && !permit.checking)
    .map((permit) => effectiveRunTime(new Date(permit.nextDueAt ?? now.toISOString()), now, schedule).getTime());

  if (times.length === 0) return "";
  const next = relativeTime(new Date(Math.min(...times)), now);

  return next === "now" ? "Next check now" : `Next check ${next}`;
}

function renderPermit(permit: PermitRow, monitoring: AppSnapshot["monitoring"]): HTMLTableRowElement {
  const row = make("tr");

  if (!firstRender && !knownPermitIds.has(permit.id)) row.className = "row-enter";

  const identity = make("td");
  const open = actionButton(permit.permitNumber, "details", permit, "permit-link");
  const jurisdiction = getJurisdiction(permit.jurisdictionId);
  open.setAttribute("aria-label", [permit.permitNumber, jurisdiction?.label ?? permit.jurisdictionId,
    permit.projectNumber ? `project ${permit.projectNumber}` : null, "details"].filter(Boolean).join(", "));
  identity.append(open);
  identity.append(make("span", "cell-sub", jurisdiction?.label ?? permit.jurisdictionId));

  if (monitoring === "scheduled" && !permit.monitoringEnabled && !isManualJurisdiction(permit.jurisdictionId)) {
    const tag = make("span", "tag", "Not scheduled");
    identity.append(tag);
  }

  const status = make("td");

  if (permit.lastStatus) {
    status.append(make("span", "status-value", permit.lastStatus));
  } else {
    status.append(make("span", "muted", "—"));
  }

  const action = statusAction(permit.jurisdictionId, permit.lastStatus);
  const waiting = make("td");
  waiting.append(actionBadge(action));

  if (action) row.dataset.actionOn = action.action;
  else if (permit.lastStatus) waiting.title = "Water management district statuses aren't classified yet.";

  const observed = make("td", "timestamp");
  observed.append(timeNode(permit.lastObservedAt));

  const attempt = make("td");
  attempt.append(outcomeCell(permit));

  const controls = make("td");
  const actions = make("div", "row-actions");
  actions.append(permit.checking
    ? actionButton("Cancel", "cancel", permit, "btn btn-secondary")
    : actionButton("Check now", "check", permit, "btn btn-secondary"));
  const record = actionButton("", "open", permit, "icon-button");
  record.append(icon("external"));
  record.disabled = !permit.lastRecordUrl;
  record.setAttribute("aria-label", `Open record for ${permit.permitNumber}`);
  record.title = "Open record";
  actions.append(record);
  controls.append(actions);

  row.append(identity, status, waiting, observed, attempt, controls);

  return row;
}

const permitCount = (count: number) => `${count} ${count === 1 ? "permit" : "permits"}`;

/** One tbody per project, headed by the project number, so the groups read as sections of one table. */
function renderGroup(group: ProjectGroup | null, permits: PermitRow[], monitoring: AppSnapshot["monitoring"]): HTMLTableSectionElement {
  const body = make("tbody", "permit-group");

  if (group) {
    const head = make("tr", "group-row");
    const cell = make("th");
    cell.scope = "rowgroup";
    cell.colSpan = 6;
    const wrap = make("div", "group-head");

    if (group.projectNumber) {
      wrap.append(make("span", "group-label", "Project"), make("span", "group-number", group.projectNumber));
    } else {
      wrap.append(make("span", "group-label", "No project"));
    }

    wrap.append(make("span", "group-count", permitCount(permits.length)));
    cell.append(wrap);
    head.append(cell);
    body.append(head);
  }

  body.append(...permits.map((permit) => renderPermit(permit, monitoring)));

  return body;
}

function matchesFilter(permit: PermitRow): boolean {
  if (filter === "applicant") return actionOn(permit.jurisdictionId, permit.lastStatus) === "applicant";

  if (filter === "failed") return !permit.checking && outcomeKind(permit.latestOutcome) === "failed";

  if (filter === "unverified") return !permit.lastStatus;

  return true;
}

function renderKey(state: AppSnapshot["keyState"]): void {
  element("key-banner").hidden = state === "configured";
  element("key-banner-title").textContent = state === "missing"
    ? "Add your TypeSafe key to run checks." : "Key storage isn't available on this computer.";
  element("banner-add-key", HTMLButtonElement).hidden = state === "unavailable";
  const unavailable = element("settings-key-state");
  unavailable.hidden = state !== "unavailable";
  unavailable.textContent = "Key storage isn't available on this computer.";
  element("key-form", HTMLFormElement).hidden = state === "unavailable";
  element("key-input", HTMLInputElement).placeholder = state === "configured" ? "Saved. Paste a new key to replace it." : "Paste your API key";
  const save = element("key-save", HTMLButtonElement);
  save.textContent = state === "configured" ? "Replace" : "Save";
  save.className = `btn btn-sm ${state === "configured" ? "btn-secondary" : "btn-primary"}`;
  element("key-remove", HTMLButtonElement).hidden = state !== "configured";
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

const timeLabelFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function renderCheckTimeRows(times: readonly string[]): void {
  const rows = times.map((value, index) => {
    const row = document.createElement("li");
    const input = document.createElement("input");
    input.type = "time";
    input.required = true;
    input.value = value;
    input.setAttribute("aria-label", `Check time ${index + 1}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.dataset.removeTime = String(index);
    remove.disabled = times.length === 1;
    const time = parseCheckTime(value);
    remove.setAttribute("aria-label", time ? `Remove ${timeLabelFormat.format(new Date(2026, 0, 5, time.hour, time.minute))}` : "Remove time");
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
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

function render(snapshot: AppSnapshot): void {
  currentSnapshot = snapshot;
  renderKey(snapshot.keyState);
  renderPreferences(snapshot.preferences);
  element("monitoring-mode", HTMLSelectElement).value = snapshot.monitoring;
  renderSchedule(snapshot);
  element("next-check").textContent = nextCheckSummary(snapshot);
  element("version").textContent = `Version ${snapshot.appVersion}`;

  const total = snapshot.permits.length;
  const failed = snapshot.permits.filter((permit) => !permit.checking && outcomeKind(permit.latestOutcome) === "failed").length;
  const unverified = snapshot.permits.filter((permit) => !permit.lastStatus).length;
  const applicant = snapshot.permits.filter((permit) => actionOn(permit.jurisdictionId, permit.lastStatus) === "applicant").length;
  const counts: Record<Filter, number> = { all: total, applicant, failed, unverified };

  for (const option of element("permit-filter", HTMLSelectElement).options) {
    const key = filterValue(option.value);
    const count = key ? counts[key] : 0;
    option.textContent = count > 0 ? `${option.dataset.label} (${count})` : option.dataset.label ?? "";
  }

  const visible = snapshot.permits.filter(matchesFilter);
  const table = element("permit-table", HTMLTableElement);
  // The year is part of it because timestamps only show a year when it isn't the current one.
  const source = JSON.stringify([snapshot.monitoring, new Date().getFullYear(), visible]);

  if (source !== tableSource) {
    tableSource = source;

    // Snapshot the live collection first; removing while iterating it would skip bodies.
    for (const body of Array.from(table.tBodies)) body.remove();

    // Group only once a project number is in use; until then the table stays one plain list.
    if (visible.some((permit) => permit.projectNumber)) {
      table.append(...groupByProject(visible).map((group) => renderGroup(group, group.permits, snapshot.monitoring)));
    } else if (visible.length > 0) {
      table.append(renderGroup(null, visible, snapshot.monitoring));
    }
  }

  table.hidden = visible.length === 0;
  element("empty-state").hidden = visible.length > 0;
  element("empty-state").textContent = total === 0 ? "No permits yet."
    : filter === "applicant" ? "Nothing is waiting on AEC."
      : filter === "failed" ? "No failed checks." : "Every permit has a status.";

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
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    optgroup.append(...JURISDICTIONS.filter(group.includes).map((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label;

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

async function loadHistory(permitId: string): Promise<void> {
  const generation = ++historyGeneration;
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);
  const key = permit ? historyKey(permit) : null;
  const result = await api.history(permitId);

  if (generation !== historyGeneration || detailsPermitId !== permitId) return;

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
  element("history-list", HTMLOListElement).replaceChildren();
  historyShown = null;
  const sheet = element("details-sheet", HTMLDialogElement);

  if (!sheet.open) sheet.showModal();
  void loadHistory(permitId);
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

function setManualError(message: string | null): void {
  const error = element("manual-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  const input = element("manual-status", HTMLInputElement);

  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

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
  setManualError(null);

  if (!manualDialog.open) manualDialog.showModal();
  status.focus();
  status.select();
}

function closeManual(): void {
  manualPermitId = null;

  if (manualDialog.open) manualDialog.close();
}

element("manual-status", HTMLInputElement).addEventListener("input", () => setManualError(null));

element("manual-cancel", HTMLButtonElement).addEventListener("click", closeManual);

manualDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeManual(); });

element("manual-reopen", HTMLButtonElement).addEventListener("click", async () => {
  if (!manualPermitId) return;
  const result = await api.openPortal(manualPermitId);

  if (!result.ok) setManualError(result.error);
});

element("manual-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const permitId = manualPermitId;

  if (!permitId) return;
  const status = element("manual-status", HTMLInputElement).value.trim();

  if (!status) {
    setManualError("Enter the status shown on the portal.");
    element("manual-status", HTMLInputElement).focus();

    return;
  }

  const recordUrl = element("manual-link", HTMLInputElement).value.trim();
  const result = await busy(element("manual-save", HTMLButtonElement), () => api.recordManualStatus({ permitId, status, recordUrl }));

  if (!result.ok) {
    setManualError(result.error);

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

const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;

function projectProblem(value: string): string | null {
  if (!value) return null;

  if (value.length > 40) return "Use 40 characters or fewer.";

  return PROJECT_PATTERN.test(value) ? null : "Use letters, numbers, spaces, and - . _ / only.";
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

function setFieldError(message: string | null): void {
  const input = element("permit-number", HTMLInputElement);
  const error = element("permit-number-error");
  error.hidden = !message;
  error.textContent = message ?? "";

  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

// Add form
element("permit-number", HTMLInputElement).addEventListener("input", () => setFieldError(null));

element("add-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element("permit-number", HTMLInputElement);
  const number = input.value.trim();

  if (!number) {
    setFieldError("Enter a permit number.");
    input.focus();

    return;
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(number) || number.length < 3) {
    setFieldError("Use letters, numbers, hyphens, and dots only.");
    input.focus();

    return;
  }

  const jurisdiction = element("jurisdiction", HTMLSelectElement).value;
  const result = await busy(element("add-button", HTMLButtonElement), () => api.addAndCheck({ jurisdiction, permitNumber: number }));

  if (!result.ok) {
    setFieldError(result.error);
    input.focus();

    return;
  }

  input.value = "";
  setFieldError(null);

  if (filter !== "all") setFilter("all");
  render(await api.snapshot());
  const added = currentSnapshot?.permits.find((entry) => entry.id === result.value);
  const project = added ? await askProjectNumber(added) : null;
  notice(project ? `${number} added to project ${project}.` : `${number} added.`, "info");

  if (added && isManualJurisdiction(added.jurisdictionId)) await startManualCheck(added);
});

// Key
function setKeyError(message: string | null): void {
  const error = element("key-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  const input = element("key-input", HTMLInputElement);

  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

function openKeySettings(): void {
  const sheet = element("settings-sheet", HTMLDialogElement);

  if (!sheet.open) sheet.showModal();
  element("key-input", HTMLInputElement).focus();
}

element("banner-add-key", HTMLButtonElement).addEventListener("click", openKeySettings);

element("key-input", HTMLInputElement).addEventListener("input", () => setKeyError(null));

element("key-form", HTMLFormElement).addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element("key-input", HTMLInputElement);
  const problem = keyProblem(input.value.trim());

  if (problem) {
    setKeyError(problem);
    input.focus();

    return;
  }

  // Clear the field before sending so the key does not linger in the window.
  const key = input.value.trim();
  input.value = "";
  const result = await busy(element("key-save", HTMLButtonElement), () => api.saveKey(key));

  if (!result.ok) {
    setKeyError(result.error);
    input.focus();

    return;
  }

  setKeyError(null);
  notice("Key saved.", "info");
  render(await api.snapshot());
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
  render(await api.snapshot());
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

  if (dialog === detailsSheet) { detailsPermitId = null; historyGeneration += 1; historyShown = null; }
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
  render(snapshot);
  const permit = detailsPermitId ? snapshot.permits.find((entry) => entry.id === detailsPermitId) : undefined;

  if (permit && historyKey(permit) !== historyShown) void loadHistory(permit.id);
});

api.onLocalError((message) => notice(message));

api.onOpenDetails((permitId) => {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet:not(#details-sheet)")) closeSheet(dialog);
  finishConfirm(false);
  finishProject(null);

  if (currentSnapshot?.permits.some((permit) => permit.id === permitId)) openDetails(permitId);
  else void api.snapshot().then((snapshot) => { render(snapshot); openDetails(permitId); });
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

void api.snapshot().then(render);
