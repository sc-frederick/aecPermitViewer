import { HILLSBOROUGH_ID, type PermitRow } from "../../src/shared/permit.js";

/**
 * Build a permit list row: a monitored Hillsborough permit that has never been checked, with `overrides` applied.
 *
 * @param overrides - The fields the test cares about.
 * @returns A complete row.
 */
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
