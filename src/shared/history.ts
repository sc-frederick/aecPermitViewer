import type { CheckRunRow, ObservationRow, PermitHistory } from "./permit.js";

export interface HistoryDay {
  run: CheckRunRow;
  observation: ObservationRow | undefined;
}

function localDay(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * One entry per calendar day, newest first. Each day shows its latest status the portal
 * returned; a day with no successful read shows its latest check instead.
 */
export function dailyHistory(history: PermitHistory, dayOf: (value: string) => string = localDay): HistoryDay[] {
  const days = new Map<string, HistoryDay>();
  for (const run of history.runs) {
    const day = dayOf(run.startedAt);
    const observation = history.observations.find((entry) => entry.runId === run.id);
    const current = days.get(day);
    if (!current || (!current.observation && observation)) days.set(day, { run, observation });
  }
  return [...days.values()];
}
