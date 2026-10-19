import type { AppSnapshot } from "../shared/bridge.js";
import {
  DEFAULT_CHECK_TIMES,
  describeCheckTimes,
  formatCheckTime,
  MAX_CHECK_TIMES,
  normalizeCheckTimes,
  parseCheckTime,
  wallClockDate,
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
    remove.setAttribute("aria-label", time ? `Remove ${clockFormat.format(wallClockDate(time))}` : "Remove time");
    remove.append(icon("close"));
    row.append(input, remove);

    return row;
  });

  checkTimeList.replaceChildren(...rows);
  syncCheckTimeRows();
  markIncompleteCheckTime(null);
}

function syncCheckTimeRows(): void {
  const rows = [...checkTimeList.querySelectorAll("li")];

  for (const [index, row] of rows.entries()) {
    row.querySelector("input")?.setAttribute("aria-label", `Check time ${index + 1}`);
    const remove = row.querySelector("button");

    if (remove) remove.disabled = rows.length === 1;
  }

  addCheckTime.disabled = rows.length >= MAX_CHECK_TIMES;
}

function markIncompleteCheckTime(input: HTMLInputElement | null): void {
  for (const row of checkTimeList.querySelectorAll("input")) {
    if (row === input) row.setAttribute("aria-invalid", "true");
    else row.removeAttribute("aria-invalid");
  }

  checkTimeError.hidden = !input;
}

function editedCheckTimes(): string[] {
  return [...checkTimeList.querySelectorAll("input")].map((input) => input.value);
}

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
    const kept = [...checkTimeList.querySelectorAll("input")].filter((input) => !row.contains(input));
    const incomplete = kept.find((input) => !input.value);

    if (incomplete) {
      incomplete.focus();
      row.remove();
      syncCheckTimeRows();
      markIncompleteCheckTime(incomplete);

      return;
    }

    const times = kept.map((input) => input.value);
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
