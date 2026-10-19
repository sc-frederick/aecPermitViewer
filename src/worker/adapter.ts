import type { Candidate, PageObservation } from "../shared/worker-protocol.js";
import type { ReviewEntry } from "../shared/reviews.js";
import type { JurisdictionId } from "../shared/jurisdictions.js";
import { sameJurisdictionPermitNumber } from "../shared/permit.js";

/** What a record showed: its identity, record-level status and label, and the record page link to save. */
export interface DisplayedRecord {
  displayedNumber: string | null;
  statusLabel: string | null;
  statusValue: string | null;
  recordUrl: string | null;
  reviews?: ReviewEntry[] | null;
}

/** A read that found no record: no number, status, label, or link. */
export const NOTHING_DISPLAYED: DisplayedRecord = {
  displayedNumber: null,
  statusLabel: null,
  statusValue: null,
  recordUrl: null,
};

/**
 * The result links whose text is the requested permit number, keeping the first link to each address. Several links to
 * one record count as one result.
 */
export function exactLinks<T extends { text: string; href: string }>(
  links: readonly T[],
  requested: string,
  jurisdictionId: JurisdictionId,
): T[] {
  const matching = links.filter((link) => sameJurisdictionPermitNumber(requested, link.text, jurisdictionId));

  return matching.filter((link, index) => matching.findIndex((candidate) => candidate.href === link.href) === index);
}

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
  foundNothing(): Promise<boolean>;
  openSearch?(): Promise<void>;
  fill(): Promise<void>;
  submit(): Promise<void>;
  openResult(): Promise<void>;
  read(): Promise<DisplayedRecord>;
}
