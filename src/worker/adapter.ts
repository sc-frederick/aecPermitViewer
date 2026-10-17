import type { Candidate, PageObservation } from "../shared/worker-protocol.js";
import type { ReviewEntry } from "../shared/reviews.js";

/** What a record showed: its identity, record-level status and label, and the record page link to save. */
export interface DisplayedRecord {
  displayedNumber: string | null;
  statusLabel: string | null;
  statusValue: string | null;
  recordUrl: string | null;
  /** Populated by adapters that read individual review processes. */
  reviews?: ReviewEntry[] | null;
}

export const NOTHING_DISPLAYED: DisplayedRecord = {
  displayedNumber: null,
  statusLabel: null,
  statusValue: null,
  recordUrl: null,
};

/** A search page's state and the next steps it allows. */
export interface SearchObservation {
  phase: PageObservation["phase"];
  inputValue: string;
  formLabels: string[];
  visibleControls: string[];
  resultNumbers: string[];
  candidates: Candidate[];
}

/** Drives one portal family's search, results, and record pages for a single requested number. */
export interface PortalAdapter {
  observe(): Promise<SearchObservation>;
  /** True once the search for the requested number has finished without it. */
  foundNothing(): Promise<boolean>;
  openSearch?(): Promise<void>;
  fill(): Promise<void>;
  submit(): Promise<void>;
  openResult(): Promise<void>;
  read(): Promise<DisplayedRecord>;
}
