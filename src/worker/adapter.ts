import type { Candidate, PageObservation } from "../shared/worker-protocol.js";
import type { ReviewEntry } from "../shared/reviews.js";
import type { JurisdictionId } from "../shared/jurisdictions.js";
import { sameJurisdictionPermitNumber } from "../shared/permit.js";

export interface DisplayedRecord {
  displayedNumber: string | null;
  statusLabel: string | null;
  statusValue: string | null;
  recordUrl: string | null;
  reviews?: ReviewEntry[] | null;
}

export const NOTHING_DISPLAYED: DisplayedRecord = {
  displayedNumber: null,
  statusLabel: null,
  statusValue: null,
  recordUrl: null,
};

export function exactLinks<T extends { text: string; href: string }>(
  links: readonly T[],
  requested: string,
  jurisdictionId: JurisdictionId,
): T[] {
  const matching = links.filter((link) => sameJurisdictionPermitNumber(requested, link.text, jurisdictionId));

  return matching.filter((link, index) => matching.findIndex((candidate) => candidate.href === link.href) === index);
}

export interface SearchObservation {
  phase: PageObservation["phase"];
  inputValue: string;
  formLabels: string[];
  visibleControls: string[];
  resultNumbers: string[];
  candidates: Candidate[];
}

export interface PortalAdapter {
  observe(): Promise<SearchObservation>;
  foundNothing(): Promise<boolean>;
  openSearch?(): Promise<void>;
  fill(): Promise<void>;
  submit(): Promise<void>;
  openResult(): Promise<void>;
  read(): Promise<DisplayedRecord>;
}
