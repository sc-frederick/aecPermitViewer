import type { BridgeResult } from "../shared/bridge.js";
import { isManualJurisdiction } from "../shared/jurisdictions.js";
import { startManualCheck } from "./add-permit.js";
import { element, eventButton } from "./dom.js";
import { notice } from "./overlays.js";
import { openDetails } from "./permit-details.js";
import { permitActionValue, type PermitAction } from "./permit-table.js";
import { api, ui } from "./state.js";

const permitTable = element("permit-table", HTMLTableElement);

const detailsCheck = element("details-check", HTMLButtonElement);

const detailsOpen = element("details-open", HTMLButtonElement);

async function runPermitAction(action: PermitAction, permitId: string): Promise<void> {
  if (action === "details") {
    openDetails(permitId);

    return;
  }

  const permit = ui.currentSnapshot?.permits.find((entry) => entry.id === permitId);

  if (action === "check" && permit && isManualJurisdiction(permit.jurisdictionId)) {
    await startManualCheck(permit);

    return;
  }

  const result = await requestPermitAction(action, permitId);

  if (!result.ok) notice(result.error);
}

function requestPermitAction(action: Exclude<PermitAction, "details">, permitId: string): Promise<BridgeResult<null>> {
  switch (action) {
    case "check":
      return api.checkNow(permitId);
    case "cancel":
      return api.cancel(permitId);
    case "open":
      return api.openRecord(permitId);
  }
}

/** Wires the table rows' buttons and the details sheet's Check now and Open record buttons. */
export function initPermitActions(): void {
  permitTable.addEventListener("click", (event) => {
    const target = eventButton(event, "button[data-action]");
    const action = permitActionValue(target?.dataset.action);

    if (!target?.dataset.permitId || !action) return;
    void runPermitAction(action, target.dataset.permitId);
  });

  detailsCheck.addEventListener("click", () => {
    const action = permitActionValue(detailsCheck.dataset.action);

    if (ui.detailsPermitId && action) void runPermitAction(action, ui.detailsPermitId);
  });

  detailsOpen.addEventListener("click", () => {
    if (ui.detailsPermitId) void runPermitAction("open", ui.detailsPermitId);
  });
}
