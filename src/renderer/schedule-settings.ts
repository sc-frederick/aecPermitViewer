import type { AppSnapshot } from "../shared/permit.js";
import {
  DEFAULT_CHECK_TIMES,
  describeCheckTimes,
  formatCheckTime,
  MAX_CHECK_TIMES,
  normalizeCheckTimes,
  parseCheckTime,
  type CheckTimes,
} from "../shared/schedule.js";
import { element, eventButton, icon, make } from "./dom.js";
import { clockFormat } from "./format.js";
import { notice } from "./overlays.js";
import { api, ui } from "./state.js";

const monitoringMode = element("monitoring-mode", HTMLSelectElement);

const scheduleHelp = element("schedule-help");

const checkTimesSection = element("check-times");

const checkTimeList = element("check-time-list", HTMLUListElement);

const checkTimeError = element("check-time-error");

const addCheckTime = element("add-check-time", HTMLButtonElement);

/** The snapshot's daily check times, or the defaults when there is no snapshot or its times don't parse. */
export function checkTimes(snapshot: AppSnapshot | null): CheckTimes {
  return (snapshot && normalizeCheckTimes(snapshot.checkTimes)) ?? DEFAULT_CHECK_TIMES;
}

function renderCheckTimeRows(times: readonly string[]): void {
  const rows = times.map((value) => {
    const row = make("li");
    const input = make("input");
    input.type = "time";
    input.required = true;
    input.value = value;
    input.setAttribute("aria-describedby", "check-time-error");
    const remove = make("button", "icon-button");
    remove.type = "button";
    remove.dataset.removeTime = "";
    const time = parseCheckTime(value);
    remove.setAttribute(
      "aria-label",
      time ? `Remove ${clockFormat.format(new Date(2026, 0, 5, time.hour, time.minute))}` : "Remove time",
    );
    remove.append(icon("close"));
    row.append(input, remove);

    return row;
  });

  checkTimeList.replaceChildren(...rows);
  syncCheckTimeRows();
  markIncompleteCheckTime(null);
}

/** Labels the rows by position, disables Remove on a lone row, and disables Add at `MAX_CHECK_TIMES`. */
function syncCheckTimeRows(): void {
  const rows = [...checkTimeList.querySelectorAll("li")];

  for (const [index, row] of rows.entries()) {
    row.querySelector("input")?.setAttribute("aria-label", `Check time ${index + 1}`);
    const remove = row.querySelector("button");

    if (remove) remove.disabled = rows.length === 1;
  }

  addCheckTime.disabled = rows.length >= MAX_CHECK_TIMES;
}

/** Flags `input` as the row that still needs a time, or clears the flag when given null. */
function markIncompleteCheckTime(input: HTMLInputElement | null): void {
  for (const row of checkTimeList.querySelectorAll("input")) {
    if (row === input) row.setAttribute("aria-invalid", "true");
    else row.removeAttribute("aria-invalid");
  }

  checkTimeError.hidden = !input;
}

/** The schedule editor's rows as typed, one per row in order; a cleared or half-typed field reads as "". */
function editedCheckTimes(): string[] {
  return [...checkTimeList.querySelectorAll("input")].map((input) => input.value);
}

/** The first row without a full time; it must be filled in or removed before the rows can be saved. */
function incompleteCheckTime(): HTMLInputElement | null {
  return [...checkTimeList.querySelectorAll("input")].find((input) => !input.value) ?? null;
}

/** Draws Settings' schedule section: the monitoring mode, its summary, and the check time rows. */
export function renderSchedule(snapshot: AppSnapshot): void {
  monitoringMode.value = snapshot.monitoring;
  const scheduled = snapshot.monitoring === "scheduled";
  scheduleHelp.textContent = scheduled
    ? `Checks run at ${describeCheckTimes(checkTimes(snapshot))} each day.`
    : "Checks only run when you click Check now.";
  checkTimesSection.hidden = !scheduled;

  // Leave the rows alone while someone is editing them; they re-sort when focus leaves.
  if (checkTimeList.contains(document.activeElement)) return;
  const saved = checkTimes(snapshot).map(formatCheckTime);

  if (saved.join() !== editedCheckTimes().join() || checkTimeList.children.length !== saved.length)
    renderCheckTimeRows(saved);
}

async function saveCheckTimes(times: string[]): Promise<void> {
  const result = await api.setCheckTimes(times);

  if (!result.ok) {
    notice(result.error);

    if (ui.currentSnapshot) renderCheckTimeRows(checkTimes(ui.currentSnapshot).map(formatCheckTime));
  }
}

/** Wires the monitoring mode menu and the check time editor. */
export function initScheduleSettings(): void {
  checkTimeList.addEventListener("change", () => {
    // A half-cleared field reads as empty; wait until every row holds a full time.
    if (incompleteCheckTime()) return;
    markIncompleteCheckTime(null);
    void saveCheckTimes(editedCheckTimes());
  });

  checkTimeList.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && checkTimeList.contains(event.relatedTarget)) return;

    if (ui.currentSnapshot) renderCheckTimeRows(checkTimes(ui.currentSnapshot).map(formatCheckTime));
  });

  checkTimeList.addEventListener("click", (event) => {
    const row = eventButton(event, "button[data-remove-time]")?.closest("li");

    if (!row || checkTimeList.children.length === 1) return;
    // Exclude the clicked row by identity, not by value, so a cleared row can't change which time is removed.
    const kept = [...checkTimeList.querySelectorAll("input")].filter((input) => !row.contains(input));
    const incomplete = kept.find((input) => !input.value);

    // Move focus before removing the row: removing the focused button counts as leaving the list, which restores the
    // saved times.
    if (incomplete) {
      // Nothing saves until the cleared row holds a time. Keeping focus in the list keeps the edit on screen.
      incomplete.focus();
      row.remove();
      syncCheckTimeRows();
      markIncompleteCheckTime(incomplete);

      return;
    }

    const times = kept.map((input) => input.value);
    // Move focus out of the list so the next snapshot can redraw it.
    addCheckTime.focus();
    void saveCheckTimes(times);
  });

  addCheckTime.addEventListener("click", () => {
    const incomplete = incompleteCheckTime();

    if (incomplete) {
      markIncompleteCheckTime(incomplete);
      incomplete.focus();

      return;
    }

    const times = editedCheckTimes();
    const taken = new Set(times);
    const last = parseCheckTime(times[times.length - 1] ?? "") ?? { hour: 8, minute: 0 };

    // Add the first free slot in whole-hour steps after the last row's time, wrapping past midnight.
    for (let step = 1; step <= 24; step += 1) {
      const candidate = formatCheckTime({ hour: (last.hour + step) % 24, minute: last.minute });

      if (!taken.has(candidate)) {
        void saveCheckTimes([...times, candidate]);

        return;
      }
    }
  });

  monitoringMode.addEventListener("change", async () => {
    const mode = monitoringMode.value;

    if (mode !== "manual" && mode !== "scheduled") return;
    const result = await api.setMonitoring(mode);

    if (!result.ok) notice(result.error);
  });
}
