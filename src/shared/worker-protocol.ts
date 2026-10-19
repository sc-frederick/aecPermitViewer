import { z } from "zod";
import { reviewsSchema } from "./review-schema.js";
import { runOutcomeSchema } from "./permit.js";
import type { JurisdictionId } from "./jurisdictions.js";

const candidateSchema = z.object({
  id: z.string(),
  description: z.string(),
  established: z.boolean(),
});

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

export type PageObservation = z.infer<typeof pageObservationSchema>;

export type MainToWorker =
  | {
      kind: "start";
      runId: string;
      jurisdictionId: JurisdictionId;
      permitNumber: string;
      previousRecordUrl: string | null;
      browserPath: string;
    }
  | { kind: "choose"; runId: string; fingerprint: string; candidateId: string }
  | { kind: "reobserve"; runId: string }
  | { kind: "cancel"; runId: string };

const workerFailureSchema = runOutcomeSchema.exclude(["success"]);

export type WorkerFailure = z.infer<typeof workerFailureSchema>;

export const workerToMainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observation"), runId: z.string(), observation: pageObservationSchema }),
  z.object({
    kind: z.literal("verified"),
    runId: z.string(),
    displayedNumber: z.string(),
    statusLabel: z.string(),
    statusValue: z.string(),
    observedAt: z.string(),
    recordUrl: z.string(),
    browserVersion: z.string(),
    reviews: reviewsSchema.default(null),
  }),
  z.object({ kind: z.literal("failed"), runId: z.string(), outcome: workerFailureSchema }),
  z.object({ kind: z.literal("action_count"), runId: z.string(), count: z.number().int().nonnegative() }),
]);

export type WorkerToMain = z.infer<typeof workerToMainSchema>;
