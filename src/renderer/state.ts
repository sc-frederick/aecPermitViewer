import type { AppSnapshot, PermitBridge } from "../shared/bridge.js";

declare global {
  interface Window {
    permitMonitor: PermitBridge;
  }
}

export const api = window.permitMonitor;

export const NO_ANSWER = "The app didn't answer.";

const FILTERS = ["all", "applicant", "failed", "unverified"] as const;

export type Filter = (typeof FILTERS)[number];

export function filterValue(value: string): Filter | null {
  return FILTERS.find((entry) => entry === value) ?? null;
}

interface WindowState {
  currentSnapshot: AppSnapshot | null;
  filter: Filter;
  detailsPermitId: string | null;
  knownPermitIds: ReadonlySet<string>;
  firstRender: boolean;
}

export const ui: WindowState = {
  currentSnapshot: null,
  filter: "all",
  detailsPermitId: null,
  knownPermitIds: new Set(),
  firstRender: true,
};
