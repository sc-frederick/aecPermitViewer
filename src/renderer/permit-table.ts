import { actionLabel, actionReason, type StatusAction } from "../shared/action.js";
import { getJurisdiction, isManualJurisdiction } from "../shared/jurisdictions.js";
import { outcomeText } from "../shared/outcomes.js";
import type { AppSnapshot } from "../shared/bridge.js";
import type { PermitRow, RunOutcome } from "../shared/permit.js";
import { groupByProject, projectKey, type ProjectGroup } from "../shared/projects.js";
import { element, icon, make } from "./dom.js";
import { permitCount, timeNode } from "./format.js";
import { ui, type Filter } from "./state.js";

const permitTable = element("permit-table", HTMLTableElement);

type OutcomeKind = "ok" | "failed" | "checking" | "none";

export function outcomeKind(outcome: RunOutcome | null, checking = false): OutcomeKind {
  if (checking) return "checking";

  if (!outcome) return "none";

  if (outcome === "success") return "ok";

  return outcome === "cancelled" ? "none" : "failed";
}

const PERMIT_ACTIONS = ["details", "check", "cancel", "open"] as const;

export type PermitAction = (typeof PERMIT_ACTIONS)[number];

export function permitActionValue(value: string | undefined): PermitAction | null {
  return PERMIT_ACTIONS.find((action) => action === value) ?? null;
}

function outcomeCell(permit: PermitRow): HTMLElement {
  const kind = outcomeKind(permit.latestOutcome, permit.checking);
  const wrap = make("div", "outcome");
  wrap.dataset.kind = kind;
  const text = make("div", "outcome-text");

  if (permit.checking) {
    text.append(make("span", "outcome-label", "Checking…"));
  } else if (permit.latestOutcome) {
    const label =
      permit.latestOutcome === "success" && isManualJurisdiction(permit.jurisdictionId)
        ? "Checked by hand"
        : outcomeText[permit.latestOutcome];

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

export function actionBadge(classified: StatusAction | null): HTMLElement {
  if (!classified) return make("span", "muted", "—");
  const badge = make("span", "action");
  badge.dataset.actionOn = classified.action;
  const reason = actionReason(classified);

  if (classified.basis === "cautious" || classified.basis === "unlisted") badge.dataset.tentative = "";

  if (reason) badge.title = reason;

  if (classified.action !== "none") badge.append(make("span", "dot"));
  badge.append(make("span", "", actionLabel(classified)));

  return badge;
}

function actionButton(label: string, action: PermitAction, permitId: string, className: string): HTMLButtonElement {
  const node = make("button", className, label);
  node.type = "button";
  node.dataset.action = action;
  node.dataset.permitId = permitId;

  return node;
}

interface PermitRowView {
  row: HTMLTableRowElement;
  open: HTMLButtonElement;
  jurisdiction: HTMLSpanElement;
  unscheduled: HTMLSpanElement;
  status: HTMLTableCellElement;
  action: HTMLTableCellElement;
  observed: HTMLTableCellElement;
  attempt: HTMLTableCellElement;
  check: HTMLButtonElement;
  record: HTMLButtonElement;
  source: string;
}

const rowViews = new Map<string, PermitRowView>();

const groupBodies = new Map<string, HTMLTableSectionElement>();

function setCell(cell: HTMLElement, source: string, build: () => Node[]): void {
  if (cell.dataset.source === source) return;
  cell.dataset.source = source;
  cell.replaceChildren(...build());
}

function createRow(permit: PermitRow): PermitRowView {
  const row = make("tr");
  row.dataset.permitId = permit.id;

  if (!ui.firstRender && !ui.knownPermitIds.has(permit.id)) row.className = "row-enter";
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

  return { row, open, jurisdiction, unscheduled, status, action, observed, attempt, check, record, source: "" };
}

function updateRow(
  view: PermitRowView,
  permit: PermitRow,
  classified: StatusAction | null,
  monitoring: AppSnapshot["monitoring"],
): void {
  const year = new Date().getFullYear();
  const source = JSON.stringify([permit, monitoring, year]);

  if (view.source === source) return;
  view.source = source;
  const label = getJurisdiction(permit.jurisdictionId)?.label ?? permit.jurisdictionId;
  view.open.textContent = permit.permitNumber;
  view.open.setAttribute(
    "aria-label",
    [permit.permitNumber, label, permit.projectNumber ? `project ${permit.projectNumber}` : null, "details"]
      .filter(Boolean)
      .join(", "),
  );
  view.jurisdiction.textContent = label;
  view.unscheduled.hidden = !(
    monitoring === "scheduled" &&
    !permit.monitoringEnabled &&
    !isManualJurisdiction(permit.jurisdictionId)
  );

  setCell(view.status, JSON.stringify([permit.lastStatus, classified]), () => {
    const nodes = [permit.lastStatus ? make("span", "status-value", permit.lastStatus) : make("span", "muted", "—")];

    if (classified?.basis === "review") nodes.push(make("span", "cell-sub", "Review response required"));

    return nodes;
  });

  setCell(view.action, JSON.stringify([classified]), () => [actionBadge(classified)]);

  if (classified) view.row.dataset.actionOn = classified.action;
  else delete view.row.dataset.actionOn;
  view.action.title =
    !classified && permit.lastStatus ? "Water management district statuses aren't classified yet." : "";

  setCell(view.observed, JSON.stringify([permit.lastObservedAt, year]), () => [timeNode(permit.lastObservedAt)]);
  setCell(
    view.attempt,
    JSON.stringify([permit.checking, permit.latestOutcome, permit.latestAttemptAt, permit.jurisdictionId, year]),
    () => [outcomeCell(permit)],
  );

  const control = permit.checking ? "cancel" : "check";

  if (view.check.dataset.action !== control) {
    view.check.dataset.action = control;
    view.check.textContent = permit.checking ? "Cancel" : "Check now";
  }

  view.record.disabled = !permit.lastRecordUrl;
  view.record.setAttribute("aria-label", `Open record for ${permit.permitNumber}`);
}

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

export function renderTable(
  visible: readonly PermitRow[],
  classified: ReadonlyMap<string, StatusAction | null>,
  monitoring: AppSnapshot["monitoring"],
): void {
  const shown = new Set(visible.map((permit) => permit.id));

  for (const [id, view] of rowViews) {
    if (!shown.has(id)) {
      view.row.remove();
      rowViews.delete(id);
    }
  }

  const groups: Array<{ key: string; group: ProjectGroup | null; permits: readonly PermitRow[] }> = visible.some(
    (permit) => permit.projectNumber,
  )
    ? groupByProject(visible).map((group) => ({
        key: group.projectNumber ? `project:${projectKey(group.projectNumber)}` : "unassigned",
        group,
        permits: group.permits,
      }))
    : visible.length > 0
      ? [{ key: "list", group: null, permits: visible }]
      : [];

  const keys = new Set(groups.map((entry) => entry.key));

  for (const [key, body] of groupBodies) {
    if (!keys.has(key)) {
      body.remove();
      groupBodies.delete(key);
    }
  }

  let previous: Element | null = permitTable.tHead;

  for (const entry of groups) {
    const body = groupBodies.get(entry.key) ?? make("tbody", "permit-group");
    groupBodies.set(entry.key, body);

    if (previous?.nextElementSibling !== body) permitTable.insertBefore(body, previous?.nextElementSibling ?? null);
    previous = body;
    syncGroupHead(body, entry.group, entry.permits.length);
    let cursor = entry.group ? (body.rows[0]?.nextElementSibling ?? null) : body.firstElementChild;

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

  permitTable.hidden = visible.length === 0;
}

export function matchesFilter(permit: PermitRow, which: Filter, classified: StatusAction | null): boolean {
  if (which === "applicant") return classified?.action === "applicant";

  if (which === "failed") return !permit.checking && outcomeKind(permit.latestOutcome) === "failed";

  if (which === "unverified") return !permit.lastStatus;

  return true;
}
