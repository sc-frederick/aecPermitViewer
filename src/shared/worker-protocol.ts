import { z } from "zod";
import { reviewsSchema } from "./reviews.js";
import { runOutcomeSchema } from "./permit.js";
import type { JurisdictionId } from "./jurisdictions.js";

const candidateSchema = z.object({
  id: z.string(),
  description: z.string(),
  /**
   * True when the worker's own checks establish this step: the field is visible and enabled, the result's number is an
   * exact match, or the link leads to the portal's own search. Main takes an established lone step without asking Jev.
   */
  established: z.boolean(),
});

/** A next step the worker offers main for the current page, chosen by id. */
export type Candidate = z.infer<typeof candidateSchema>;

const pageObservationSchema = z.object({
  phase: z.enum(["search", "results", "detail", "challenge", "unknown"]),
  location: z.enum(["permit-search", "permit-detail", "other"]),
  fingerprint: z.string(),
  headings: z.array(z.string()),
  formLabels: z.array(z.string()),
  visibleControls: z.array(z.string()),
  resultNumbers: z.array(z.string()),
  recentActions: z.array(z.string()),
  candidates: z.array(candidateSchema),
});

/** What the worker saw on the current page, and the steps it can take from there. */
export type PageObservation = z.infer<typeof pageObservationSchema>;

/**
 * Messages from main to the browser worker. `start` begins a run. `choose` names the page by fingerprint; when the page
 * has changed since, the worker sends a fresh observation instead of applying the choice.
 */
export type MainToWorker =
  | { kind: "start"; runId: string; jurisdictionId: JurisdictionId; permitNumber: string; previousRecordUrl: string | null; browserPath: string }
  | { kind: "choose"; runId: string; fingerprint: string; candidateId: string }
  | { kind: "reobserve"; runId: string }
  | { kind: "cancel"; runId: string };

/** Outcomes a worker may end a run with. Success is only ever reached through a `verified` message that main checks. */
const workerFailureSchema = runOutcomeSchema.exclude(["success"]);

/** How the worker reports a run it couldn't verify. */
export type WorkerFailure = z.infer<typeof workerFailureSchema>;

/** Messages from the browser worker, parsed in main because the worker process drives untrusted pages. */
export const workerToMainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observation"), runId: z.string(), observation: pageObservationSchema }),
  z.object({
    kind: z.literal("verified"), runId: z.string(), displayedNumber: z.string(), statusLabel: z.string(), statusValue: z.string(),
    observedAt: z.string(), recordUrl: z.string(), browserVersion: z.string(),
    reviews: reviewsSchema.default(null),
  }),
  z.object({ kind: z.literal("failed"), runId: z.string(), outcome: workerFailureSchema }),
  // The number of page actions the worker has taken so far in this run.
  z.object({ kind: z.literal("action_count"), runId: z.string(), count: z.number().int().nonnegative() }),
]);

/** A parsed message from the browser worker. */
export type WorkerToMain = z.infer<typeof workerToMainSchema>;
