import { HILLSBOROUGH_ID, type PermitRow } from "../../src/shared/permit.js";

export function permitRow(overrides: Partial<PermitRow> = {}): PermitRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    jurisdictionId: HILLSBOROUGH_ID,
    permitNumber: "HC-BLD-26-0087599",
    projectNumber: null,
    reviews: null,
    monitoringEnabled: true,
    lastStatus: null,
    lastObservedAt: null,
    lastRecordUrl: null,
    latestAttemptAt: null,
    latestOutcome: null,
    nextDueAt: null,
    checking: false,
    ...overrides,
  };
}
