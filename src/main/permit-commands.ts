import type { JurisdictionId } from "../shared/jurisdictions.js";
import type { CheckQueue } from "./check-queue.js";
import type { AddPermitResult, PermitStore } from "./store.js";

/**
 * Saves a permit, queues its first check, and calls `changed`. `changed` runs even for hand-checked permits, which the
 * queue skips.
 */
export function addAndCheck(
  store: Pick<PermitStore, "addPermit">,
  queue: Pick<CheckQueue, "enqueue">,
  changed: () => void,
  permitNumber: string,
  jurisdictionId: JurisdictionId,
): AddPermitResult {
  const added = store.addPermit(permitNumber, jurisdictionId);

  if (added._tag === "err") return added;
  queue.enqueue(added.value, "manual");
  changed();

  return added;
}
