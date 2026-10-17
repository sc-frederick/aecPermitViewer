import type { PermitBridge } from "../shared/bridge.js";
import type { AppSnapshot } from "../shared/permit.js";

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

/** Window state that more than one section reads or writes. */
interface WindowState {
  /** The snapshot on screen; null until main sends the first one. */
  currentSnapshot: AppSnapshot | null;
  filter: Filter;
  /** The permit the details sheet shows; null while the sheet is closed. */
  detailsPermitId: string | null;
  /** Permit ids in the last rendered snapshot; a row for any other id animates in as new. */
  knownPermitIds: ReadonlySet<string>;
  /** True until the first snapshot renders; rows drawn by that render don't animate in. */
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
