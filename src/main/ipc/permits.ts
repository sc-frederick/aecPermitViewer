import { app, clipboard, ipcMain, shell } from "electron";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { keyStateProblem, snapshot, storedKeyState } from "../app-state.js";
import { addAndCheck } from "../permit-commands.js";
import { createHandle, safeSender } from "./handle.js";
import type { BridgeResult } from "../../shared/bridge.js";
import { getJurisdiction, isManualJurisdiction } from "../../shared/jurisdictions.js";
import {
  addPermitSchema,
  manualStatusSchema,
  parsePortalUrl,
  permitIdSchema,
  permitNumberProblem,
  resolveJurisdiction,
  setProjectNumberSchema,
} from "../../shared/permit.js";
import { PROJECT_NUMBER_MAX } from "../../shared/project-number.js";

const FOLLOWING: BridgeResult<never> = {
  ok: false,
  error: "You're viewing a shared list. Stop following it in Settings to change permits.",
};

/** Registers the window's requests to read the app state and to add, check, change, remove, and open permits. */
export function registerPermitHandlers(context: AppContext): void {
  const handle = createHandle(context);

  ipcMain.handle("permit:snapshot", async (event) => {
    if (!safeSender(context, event)) return null;

    return snapshot(context).catch((cause: unknown) => {
      context.diagnostics.record("permit:snapshot", null, cause);
      throw cause;
    });
  });
  handle("permit:add-and-check", addPermitSchema, "Enter a permit number.", (input) => {
    if (context.sharing.following) return FOLLOWING;
    const jurisdictionId = resolveJurisdiction(input.jurisdiction);

    if (!jurisdictionId) {
      return { ok: false, error: "Choose a supported jurisdiction." };
    }

    const problem = permitNumberProblem(jurisdictionId, input.permitNumber);

    if (problem) return { ok: false, error: problem };

    const added = addAndCheck(
      context.store,
      context.checks,
      () => {
        void context.broadcast();
      },
      input.permitNumber,
      jurisdictionId,
    );

    if (added._tag === "err") return { ok: false, error: "That permit is already in the list." };

    return { ok: true, value: added.value };
  });
  handle("permit:check", permitIdSchema, "Permit not found.", async (id) => {
    if (context.sharing.following) return FOLLOWING;
    const permit = context.store.getPermit(id);

    if (!permit) return { ok: false, error: "Permit not found." };

    if (isManualJurisdiction(permit.jurisdictionId)) return { ok: false, error: "This permit is checked by hand." };
    const problem = keyStateProblem(await storedKeyState(context, "permit:check"));

    if (problem) return { ok: false, error: problem };

    context.checks.enqueue(permit.id, "manual");

    return { ok: true, value: null };
  });
  handle("permit:open-portal", permitIdSchema, "Permit not found.", async (id) => {
    if (context.sharing.following) return FOLLOWING;
    const permit = context.store.getPermit(id);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;

    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    clipboard.writeText(permit.permitNumber);
    await shell.openExternal(profile.startUrl);

    return { ok: true, value: null };
  });
  handle("permit:record-manual-status", manualStatusSchema, "Enter the status shown on the portal.", async (input) => {
    if (context.sharing.following) return FOLLOWING;
    const permit = context.store.getPermit(input.permitId);
    const profile = permit ? getJurisdiction(permit.jurisdictionId) : null;

    if (!permit || !profile || profile.portalFamily !== "manual") return { ok: false, error: "Permit not found." };
    const recordUrl = input.recordUrl || profile.startUrl;

    if (!parsePortalUrl(recordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: `Use a link from ${profile.label}'s portal, or leave it blank.` };
    }

    context.store.recordManualStatus({
      permitId: permit.id,
      status: input.status,
      recordUrl,
      appVersion: app.getVersion(),
    });
    await context.broadcast();

    return { ok: true, value: null };
  });
  handle("permit:cancel", permitIdSchema, "Permit not found.", (id) => {
    context.checks.cancel(id);
    void context.broadcast();

    return { ok: true, value: null };
  });
  handle(
    "permit:history",
    z.object({ permitId: permitIdSchema, before: z.iso.datetime().nullable() }),
    "Permit not found.",
    ({ permitId: id, before }) => {
      if (context.sharing.following) {
        const history = context.sharing.history(id);

        return history ? { ok: true, value: history } : { ok: false, error: "Permit not found." };
      }

      if (!context.store.getPermit(id)) return { ok: false, error: "Permit not found." };

      return { ok: true, value: context.store.dailyHistory(id, 120, before) };
    },
  );
  handle("permit:open-record", permitIdSchema, "No record link yet.", async (id) => {
    const permit = context.sharing.following ? context.sharing.permit(id) : context.store.getPermit(id);

    if (!permit?.lastRecordUrl || !parsePortalUrl(permit.lastRecordUrl, "detail", permit.jurisdictionId)) {
      return { ok: false, error: "No record link yet." };
    }

    await shell.openExternal(permit.lastRecordUrl);

    return { ok: true, value: null };
  });
  handle("permit:open-observation-record", permitIdSchema, "No record link for this entry.", async (id) => {
    const followed = context.sharing.following ? context.sharing.observation(id) : null;
    const observation = context.sharing.following ? followed?.observation : context.store.getObservation(id);

    const jurisdictionId = context.sharing.following
      ? followed?.permit.jurisdictionId
      : context.store.getObservationJurisdictionId(id);

    if (!observation || !jurisdictionId || !parsePortalUrl(observation.recordUrl, "detail", jurisdictionId)) {
      return { ok: false, error: "No record link for this entry." };
    }

    await shell.openExternal(observation.recordUrl);

    return { ok: true, value: null };
  });
  handle("permit:remove", permitIdSchema, "Permit not found.", (id) => {
    if (context.sharing.following) return FOLLOWING;

    if (!context.store.getPermit(id)) return { ok: false, error: "Permit not found." };

    if (!context.checks.remove(id)) return { ok: false, error: "Cancel the running check first." };

    context.store.removePermit(id);
    void context.broadcast();

    return { ok: true, value: null };
  });
  handle(
    "permit:set-permit-monitoring",
    z.object({ permitId: permitIdSchema, enabled: z.boolean() }),
    "Permit not found.",
    (input) => {
      if (context.sharing.following) return FOLLOWING;

      if (!context.store.getPermit(input.permitId)) return { ok: false, error: "Permit not found." };
      context.store.setPermitMonitoring(input.permitId, input.enabled);
      context.scheduler.settingsChanged();

      return { ok: true, value: null };
    },
  );
  handle(
    "permit:set-project-number",
    setProjectNumberSchema.extend({ permitId: z.string() }),
    `Use letters, numbers, spaces, and - . _ / only (${PROJECT_NUMBER_MAX} at most).`,
    (input) => {
      if (context.sharing.following) return FOLLOWING;

      if (!context.store.setProjectNumber(input.permitId, input.projectNumber))
        return { ok: false, error: "Permit not found." };
      void context.broadcast();

      return { ok: true, value: null };
    },
  );
}
