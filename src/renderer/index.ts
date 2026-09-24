import type { PermitBridge } from "../shared/bridge.js";
import { keyProblem } from "../shared/key-format.js";
import { outcomeHelp, outcomeText } from "../shared/outcomes.js";
import { describeCheckTimes, effectiveRunTime } from "../shared/schedule.js";
import type { AppPreferences, AppSnapshot, PreferenceKey, CheckRunRow, ObservationRow, PermitHistory, PermitRow, RunOutcome } from "../shared/permit.js";

declare global { interface Window { permitMonitor: PermitBridge } }

type Filter = "all" | "failed" | "unverified";
type OutcomeKind = "ok" | "failed" | "checking" | "none";

const api = window.permitMonitor;
let currentSnapshot: AppSnapshot | null = null;
let detailsPermitId: string | null = null;
let historyGeneration = 0;
let noticeTimer: number | null = null;
let filter: Filter = "all";
const knownPermitIds = new Set<string>();
let firstRender = true;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}

const stampFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const stampFormatWithYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

/** "Sep 24, 12:17 PM", adding the year only for earlier years. */
function stamp(value: string): string {
  const date = new Date(value);
  return (date.getFullYear() === new Date().getFullYear() ? stampFormat : stampFormatWithYear).format(date);
}

function timeNode(value: string | null, fallback = "—"): HTMLElement {
  if (!value) return make("span", "muted", fallback);
  const node = make("time", "", stamp(value));
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
  const node = element<HTMLDivElement>("notice");
  element<HTMLElement>("notice-text").textContent = message;
  node.dataset.kind = kind;
  element("notice-icon").setAttribute("href", kind === "error" ? "#i-alert" : "#i-check");
  node.hidden = false;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { node.hidden = true; }, kind === "error" ? 9000 : 5000);
}

let settleConfirm: ((accepted: boolean) => void) | null = null;

function confirmAction(title: string, body: string, accept: string): Promise<boolean> {
  const dialog = element<HTMLDialogElement>("confirm-dialog");
  element<HTMLElement>("confirm-title").textContent = title;
  element<HTMLElement>("confirm-body").textContent = body;
  element<HTMLButtonElement>("confirm-accept").textContent = accept;
  settleConfirm?.(false);
  dialog.showModal();
  return new Promise((resolve) => { settleConfirm = resolve; });
}

function finishConfirm(accepted: boolean): void {
  const dialog = element<HTMLDialogElement>("confirm-dialog");
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
    text.append(make("span", "outcome-label", outcomeText[permit.latestOutcome]));
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

function nextCheckSummary(snapshot: AppSnapshot): string {
  if (snapshot.monitoring !== "scheduled") return "";
  const now = new Date();
  const times = snapshot.permits.filter((permit) => permit.monitoringEnabled && !permit.checking)
    .map((permit) => effectiveRunTime(new Date(permit.nextDueAt ?? now.toISOString()), now).getTime());
  if (times.length === 0) return "";
  const next = relativeTime(new Date(Math.min(...times)), now);
  return next === "now" ? "Next check now" : `Next check ${next}`;
}

function renderPermit(permit: PermitRow, monitoring: AppSnapshot["monitoring"]): HTMLTableRowElement {
  const row = make("tr");
  if (!firstRender && !knownPermitIds.has(permit.id)) row.className = "row-enter";

  const identity = make("td");
  const open = actionButton(permit.permitNumber, "details", permit, "permit-link");
  open.setAttribute("aria-label", `${permit.permitNumber}, details`);
  identity.append(open);
  if (monitoring === "scheduled" && !permit.monitoringEnabled) {
    const tag = make("span", "tag", "Not scheduled");
    identity.append(tag);
  }

  const status = make("td");
  if (permit.lastStatus) {
    status.append(make("span", "status-value", permit.lastStatus));
  } else {
    status.append(make("span", "muted", "—"));
  }

  const observed = make("td", "timestamp");
  observed.append(timeNode(permit.lastObservedAt));

  const attempt = make("td");
  attempt.append(outcomeCell(permit));

  const controls = make("td");
  const actions = make("div", "row-actions");
  actions.append(permit.checking
    ? actionButton("Cancel", "cancel", permit, "button button-secondary")
    : actionButton("Check now", "check", permit, "button button-secondary"));
  const record = actionButton("", "open", permit, "icon-button");
  record.append(icon("external"));
  record.disabled = !permit.lastRecordUrl;
  record.setAttribute("aria-label", `Open record for ${permit.permitNumber}`);
  record.title = "Open record";
  actions.append(record);
  controls.append(actions);

  row.append(identity, status, observed, attempt, controls);
  return row;
}

function matchesFilter(permit: PermitRow): boolean {
  if (filter === "failed") return !permit.checking && outcomeKind(permit.latestOutcome) === "failed";
  if (filter === "unverified") return !permit.lastStatus;
  return true;
}

function renderKey(state: AppSnapshot["keyState"]): void {
  element<HTMLElement>("key-banner").hidden = state === "configured";
  element<HTMLElement>("key-banner-title").textContent = state === "missing"
    ? "Add your TypeSafe key to run checks." : "Key storage isn't available on this computer.";
  element<HTMLButtonElement>("banner-add-key").hidden = state === "unavailable";
  const unavailable = element<HTMLElement>("settings-key-state");
  unavailable.hidden = state !== "unavailable";
  unavailable.textContent = "Key storage isn't available on this computer.";
  element<HTMLFormElement>("key-form").hidden = state === "unavailable";
  element<HTMLInputElement>("key-input").placeholder = state === "configured" ? "Saved. Paste a new key to replace it." : "Paste your API key";
  const save = element<HTMLButtonElement>("key-save");
  save.textContent = state === "configured" ? "Replace" : "Save";
  save.className = `button ${state === "configured" ? "button-secondary" : "button-primary"}`;
  element<HTMLButtonElement>("key-remove").hidden = state !== "configured";
}

function renderPreferences(preferences: AppPreferences): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-pref]")) {
    const key = input.dataset.pref as keyof AppPreferences;
    input.checked = Boolean(preferences[key]);
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

function render(snapshot: AppSnapshot): void {
  currentSnapshot = snapshot;
  renderKey(snapshot.keyState);
  renderPreferences(snapshot.preferences);
  element<HTMLSelectElement>("monitoring-mode").value = snapshot.monitoring;
  element<HTMLElement>("next-check").textContent = nextCheckSummary(snapshot);
  element<HTMLElement>("version").textContent = `Version ${snapshot.appVersion}`;

  const total = snapshot.permits.length;
  const failed = snapshot.permits.filter((permit) => !permit.checking && outcomeKind(permit.latestOutcome) === "failed").length;
  const unverified = snapshot.permits.filter((permit) => !permit.lastStatus).length;
  for (const node of document.querySelectorAll<HTMLElement>("[data-count]")) {
    const count = node.dataset.count === "all" ? total : node.dataset.count === "failed" ? failed : unverified;
    node.textContent = count > 0 ? String(count) : "";
  }

  const visible = snapshot.permits.filter(matchesFilter);
  element<HTMLTableSectionElement>("permit-list").replaceChildren(...visible.map((permit) => renderPermit(permit, snapshot.monitoring)));
  element<HTMLElement>("permit-table").hidden = visible.length === 0;
  element<HTMLElement>("empty-state").hidden = visible.length > 0;
  element<HTMLElement>("empty-state").textContent = total === 0 ? "No permits yet."
    : filter === "failed" ? "No failed checks." : "Every permit has a status.";
  for (const permit of snapshot.permits) knownPermitIds.add(permit.id);
  firstRender = false;

  if (detailsPermitId) {
    const permit = snapshot.permits.find((entry) => entry.id === detailsPermitId);
    if (permit) renderDetailsSummary(permit); else closeSheet(element<HTMLDialogElement>("details-sheet"));
  }
}

function renderDetailsSummary(permit: PermitRow): void {
  element<HTMLElement>("details-title").textContent = permit.permitNumber;
  const status = element<HTMLElement>("details-status");
  status.textContent = permit.lastStatus ?? "No status yet";
  status.classList.toggle("muted", !permit.lastStatus);
  element<HTMLElement>("details-observed").textContent = permit.lastObservedAt ? `Verified ${stamp(permit.lastObservedAt)}` : "";
  const failure = element<HTMLElement>("details-failure");
  const failed = !permit.checking && permit.latestOutcome !== null && outcomeKind(permit.latestOutcome) === "failed";
  failure.hidden = !failed;
  failure.textContent = failed && permit.latestOutcome ? `Last check: ${outcomeText[permit.latestOutcome]}` : "";

  const check = element<HTMLButtonElement>("details-check");
  check.textContent = permit.checking ? "Cancel" : "Check now";
  check.dataset.action = permit.checking ? "cancel" : "check";
  element<HTMLButtonElement>("details-open").disabled = !permit.lastRecordUrl;
  element<HTMLInputElement>("details-daily").checked = permit.monitoringEnabled;
  const next = currentSnapshot?.monitoring === "scheduled" && permit.monitoringEnabled && !permit.checking
    ? relativeTime(effectiveRunTime(new Date(permit.nextDueAt ?? Date.now()), new Date())) : null;
  element<HTMLElement>("details-daily-help").textContent = next ? `Next: ${next}` : "";
  element<HTMLButtonElement>("details-remove").disabled = permit.checking;
}

function renderHistory(history: PermitHistory): void {
  const items = history.runs.map((run: CheckRunRow) => {
    const observation: ObservationRow | undefined = history.observations.find((entry) => entry.runId === run.id);
    const item = make("li");
    const kind = run.outcome ? outcomeKind(run.outcome) : "checking";
    item.dataset.kind = kind;
    item.append(make("span", "dot"));
    const body = make("div");
    if (observation) {
      body.append(make("strong", "", observation.statusValue));
      body.append(timeNode(observation.observedAt));
      const link = make("button", "link-button", "Open record");
      link.type = "button";
      link.dataset.observationId = observation.id;
      link.append(icon("external"));
      body.append(link);
    } else {
      body.append(make("strong", "", run.outcome ? outcomeText[run.outcome] : "Checking…"));
      body.append(timeNode(run.finishedAt ?? run.startedAt));
      const help = run.outcome ? outcomeHelp[run.outcome] : undefined;
      if (help) body.append(make("p", "", help));
    }
    item.append(body);
    return item;
  });
  const list = element<HTMLOListElement>("history-list");
  if (items.length === 0) list.replaceChildren(make("li", "timeline-empty", "No checks yet."));
  else list.replaceChildren(...items);
}

async function loadHistory(permitId: string): Promise<void> {
  const generation = ++historyGeneration;
  const result = await api.history(permitId);
  if (generation !== historyGeneration || detailsPermitId !== permitId) return;
  if (result.ok) renderHistory(result.value); else notice(result.error);
}

function openDetails(permitId: string): void {
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);
  if (!permit) return;
  detailsPermitId = permitId;
  renderDetailsSummary(permit);
  element<HTMLOListElement>("history-list").replaceChildren();
  const sheet = element<HTMLDialogElement>("details-sheet");
  if (!sheet.open) sheet.showModal();
  void loadHistory(permitId);
}

async function runPermitAction(action: string, permitId: string): Promise<void> {
  if (action === "details") { openDetails(permitId); return; }
  const result = action === "check" ? await api.checkNow(permitId)
    : action === "cancel" ? await api.cancel(permitId)
      : action === "open" ? await api.openRecord(permitId) : null;
  if (result && !result.ok) notice(result.error);
}

function setFieldError(message: string | null): void {
  const input = element<HTMLInputElement>("permit-number");
  const error = element<HTMLElement>("permit-number-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

// Add form
element<HTMLInputElement>("permit-number").addEventListener("input", () => setFieldError(null));
element<HTMLFormElement>("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>("permit-number");
  const number = input.value.trim();
  if (!number) { setFieldError("Enter a permit number."); input.focus(); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(number) || number.length < 3) {
    setFieldError("Use letters, numbers, and hyphens only.");
    input.focus();
    return;
  }
  const jurisdiction = element<HTMLSelectElement>("jurisdiction").value;
  const result = await busy(element<HTMLButtonElement>("add-button"), () => api.addAndCheck({ jurisdiction, permitNumber: number }));
  if (!result.ok) { setFieldError(result.error); input.focus(); return; }
  input.value = "";
  setFieldError(null);
  if (filter !== "all") setFilter("all");
  notice(`${number} added.`, "info");
  render(await api.snapshot());
});

// Key
function setKeyError(message: string | null): void {
  const error = element<HTMLElement>("key-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  const input = element<HTMLInputElement>("key-input");
  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}

function openKeySettings(): void {
  const sheet = element<HTMLDialogElement>("settings-sheet");
  if (!sheet.open) sheet.showModal();
  element<HTMLInputElement>("key-input").focus();
}

element<HTMLButtonElement>("banner-add-key").addEventListener("click", openKeySettings);
element<HTMLInputElement>("key-input").addEventListener("input", () => setKeyError(null));
element<HTMLFormElement>("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = element<HTMLInputElement>("key-input");
  const problem = keyProblem(input.value.trim());
  if (problem) { setKeyError(problem); input.focus(); return; }
  // Clear the field before sending so the key does not linger in the window.
  const key = input.value.trim();
  input.value = "";
  const result = await busy(element<HTMLButtonElement>("key-save"), () => api.saveKey(key));
  if (!result.ok) { setKeyError(result.error); input.focus(); return; }
  setKeyError(null);
  notice("Key saved.", "info");
  render(await api.snapshot());
});
element<HTMLButtonElement>("key-remove").addEventListener("click", async () => {
  if (!(await confirmAction("Remove your TypeSafe key?", "Checks stop until you add a key.", "Remove"))) return;
  const result = await api.removeKey();
  if (!result.ok) { notice(result.error); return; }
  notice("Key removed.", "info");
  render(await api.snapshot());
});

// Monitoring and filters
element<HTMLSelectElement>("monitoring-mode").addEventListener("change", async (event) => {
  const mode = (event.currentTarget as HTMLSelectElement).value;
  if (mode !== "manual" && mode !== "scheduled") return;
  const result = await api.setMonitoring(mode);
  if (!result.ok) notice(result.error);
});

function setFilter(next: Filter): void {
  filter = next;
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    node.setAttribute("aria-pressed", String(node.dataset.filter === next));
  }
  if (currentSnapshot) render(currentSnapshot);
}
for (const node of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
  node.addEventListener("click", () => setFilter(node.dataset.filter as Filter));
}

// Table actions
element<HTMLElement>("permit-list").addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!target?.dataset.permitId || !target.dataset.action) return;
  void runPermitAction(target.dataset.action, target.dataset.permitId);
});

// Details sheet
const detailsSheet = element<HTMLDialogElement>("details-sheet");

function closeSheet(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  if (dialog === detailsSheet) { detailsPermitId = null; historyGeneration += 1; }
}
element<HTMLButtonElement>("details-check").addEventListener("click", (event) => {
  const action = (event.currentTarget as HTMLButtonElement).dataset.action;
  if (detailsPermitId && action) void runPermitAction(action, detailsPermitId);
});
element<HTMLButtonElement>("details-open").addEventListener("click", () => {
  if (detailsPermitId) void runPermitAction("open", detailsPermitId);
});
element<HTMLInputElement>("details-daily").addEventListener("change", async (event) => {
  if (!detailsPermitId) return;
  const result = await api.setPermitMonitoring(detailsPermitId, (event.currentTarget as HTMLInputElement).checked);
  if (!result.ok) notice(result.error);
});
element<HTMLButtonElement>("details-remove").addEventListener("click", async () => {
  const permitId = detailsPermitId;
  const permit = currentSnapshot?.permits.find((entry) => entry.id === permitId);
  if (!permit || !permitId) return;
  if (!(await confirmAction(`Remove ${permit.permitNumber}?`, "Its history on this computer will be deleted.", "Remove"))) return;
  const result = await api.removePermit(permitId);
  if (!result.ok) { notice(result.error); return; }
  closeSheet(detailsSheet);
  notice(`${permit.permitNumber} removed.`, "info");
});
element<HTMLOListElement>("history-list").addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-observation-id]");
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
const confirmDialog = element<HTMLDialogElement>("confirm-dialog");
confirmDialog.addEventListener("cancel", (event) => { event.preventDefault(); finishConfirm(false); });
confirmDialog.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target === confirmDialog) { finishConfirm(false); return; }
  const choice = target.closest<HTMLButtonElement>("button[value]")?.value;
  if (choice) { event.preventDefault(); finishConfirm(choice === "accept"); }
});
element<HTMLButtonElement>("open-settings").addEventListener("click", () => element<HTMLDialogElement>("settings-sheet").showModal());

// Updates
element<HTMLButtonElement>("check-update").addEventListener("click", async (event) => {
  const status = element<HTMLElement>("update-status");
  status.hidden = false;
  element<HTMLButtonElement>("download-update").hidden = true;
  element<HTMLButtonElement>("install-update").hidden = true;
  const result = await busy(event.currentTarget as HTMLButtonElement, () => api.checkForUpdate());
  if (!result.ok) { status.textContent = result.error; return; }
  if (result.value.state === "unavailable") status.textContent = "No update feed in this build.";
  else if (result.value.state === "current") status.textContent = "You're up to date.";
  else {
    status.textContent = `Version ${result.value.version} available (${Math.ceil(result.value.size / 1_000_000)} MB).`;
    element<HTMLButtonElement>("download-update").hidden = false;
  }
});

element<HTMLButtonElement>("download-update").addEventListener("click", async () => {
  const control = element<HTMLButtonElement>("download-update");
  element<HTMLElement>("update-status").textContent = "Downloading…";
  const result = await busy(control, () => api.downloadUpdate());
  if (!result.ok) { element<HTMLElement>("update-status").textContent = result.error; return; }
  control.hidden = true;
  element<HTMLElement>("update-status").textContent = `Version ${result.value} is ready to install.`;
  element<HTMLButtonElement>("install-update").hidden = false;
});

element<HTMLButtonElement>("install-update").addEventListener("click", async () => {
  if (!(await confirmAction("Install the update?", "Permit Monitor will close to install it.", "Install"))) return;
  const result = await api.installUpdate();
  if (!result.ok) notice(result.error);
});

element<HTMLButtonElement>("delete-local-data").addEventListener("click", async () => {
  if (!(await confirmAction("Delete all data?", "Permits, history, and your key will be deleted and the app will close. This can't be undone.", "Delete"))) return;
  const result = await api.deleteLocalData("DELETE LOCAL DATA");
  if (!result.ok) notice(result.error);
});

api.onSnapshot((snapshot) => {
  render(snapshot);
  if (detailsPermitId) void loadHistory(detailsPermitId);
});
api.onLocalError((message) => notice(message));
api.onOpenDetails((permitId) => {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet:not(#details-sheet)")) closeSheet(dialog);
  finishConfirm(false);
  if (currentSnapshot?.permits.some((permit) => permit.id === permitId)) openDetails(permitId);
  else void api.snapshot().then((snapshot) => { render(snapshot); openDetails(permitId); });
});
api.onAppEvent((event) => notice(`${event.title}: ${event.body}`, event.tone));

for (const input of document.querySelectorAll<HTMLInputElement>("input[data-pref]")) {
  input.addEventListener("change", async () => {
    const result = await api.setPreference(input.dataset.pref as PreferenceKey, input.checked);
    if (!result.ok) { input.checked = !input.checked; notice(result.error); }
  });
}
element<HTMLSelectElement>("monitoring-mode").title = `${describeCheckTimes()}, business hours only`;
// Keeps the "Next check" time current between snapshots.
setInterval(() => { if (currentSnapshot) element<HTMLElement>("next-check").textContent = nextCheckSummary(currentSnapshot); }, 60_000);
void api.snapshot().then(render);
