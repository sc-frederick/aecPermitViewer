import type { RunOutcome } from "./permit.js";

export interface Candidate {
  id: string;
  description: string;
}

export interface PageObservation {
  phase: "search" | "results" | "detail" | "challenge" | "unknown";
  location: "hillsborough-building-search" | "hillsborough-building-detail" | "other";
  fingerprint: string;
  headings: string[];
  formLabels: string[];
  visibleControls: string[];
  resultNumbers: string[];
  recentActions: string[];
  candidates: Candidate[];
}

export type MainToWorker =
  | { kind: "start"; runId: string; permitNumber: string; previousRecordUrl: string | null; browserPath: string }
  | { kind: "choose"; runId: string; fingerprint: string; candidateId: string }
  | { kind: "reobserve"; runId: string }
  | { kind: "cancel"; runId: string };

export type WorkerToMain =
  | { kind: "observation"; runId: string; observation: PageObservation }
  | { kind: "verified"; runId: string; displayedNumber: string; statusLabel: string; statusValue: string; observedAt: string; recordUrl: string; browserVersion: string }
  | { kind: "failed"; runId: string; outcome: RunOutcome }
  | { kind: "action_count"; runId: string; count: number };
