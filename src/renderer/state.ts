import type { AppSnapshot, PermitBridge } from "../shared/bridge.js";

declare global {
  interface Window {
    permitMonitor: PermitBridge;
  }
}

/** The preload bridge to main. */
export const api = window.permitMonitor;

/** What the window says when a bridge call rejects: main never answered it. */
export const NO_ANSWER = "The app didn't answer.";

const FILTERS = ["all", "applicant", "failed", "unverified"] as const;

/** A table filter, named as in the filter menu's option values. */
export type Filter = (typeof FILTERS)[number];

/** Reads a filter menu value; null for anything that isn't a filter. */
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

/** The window's shared state, kept here so the sections that read and write it don't import each other. */
export const ui: WindowState = {
  currentSnapshot: null,
  filter: "all",
  detailsPermitId: null,
  knownPermitIds: new Set(),
  firstRender: true,
};
