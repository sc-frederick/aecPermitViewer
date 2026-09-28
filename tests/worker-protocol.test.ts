import { describe, expect, it } from "vitest";
import { workerToMainSchema } from "../src/shared/worker-protocol.js";

const RUN_ID = "run-1";

describe("worker messages", () => {
  it("accepts a failed run with a failure outcome", () => {
    expect(workerToMainSchema.safeParse({ kind: "failed", runId: RUN_ID, outcome: "not_found_in_supported_search" }).success).toBe(true);
  });

  it("rejects a failed run that claims success, since only a verified record can be one", () => {
    expect(workerToMainSchema.safeParse({ kind: "failed", runId: RUN_ID, outcome: "success" }).success).toBe(false);
  });

  it("accepts action counts only as nonnegative whole numbers", () => {
    const count = (value: number) => workerToMainSchema.safeParse({ kind: "action_count", runId: RUN_ID, count: value }).success;

    expect([0, 1, 19].map(count)).toEqual([true, true, true]);
    expect([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(count)).toEqual([false, false, false, false]);
  });
});
