import { app } from "electron";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { DELETE_LOCAL_DATA_CONFIRMATION } from "../../shared/bridge.js";
import type { AppContext } from "../app-context.js";
import { setOpenAtLogin } from "../background.js";
import { dataRoot } from "../paths.js";
import { reopenAfterFailedShutdown, resumeAfterFailedShutdown, stopChecks } from "../shutdown.js";
import { createHandle } from "./handle.js";

const confirmationSchema = z.literal(DELETE_LOCAL_DATA_CONFIRMATION);

export function registerDataHandlers(context: AppContext): void {
  const handle = createHandle(context);

  handle("permit:delete-local-data", confirmationSchema, "Deletion was not confirmed.", async () => {
    if (!(await stopChecks(context))) {
      resumeAfterFailedShutdown(context);

      return { ok: false, error: "A check is still running. Try again." };
    }

    await context.updates.cancel();
    const unshared = await context.sharing.stopSharing();

    if (!unshared.ok) {
      resumeAfterFailedShutdown(context);

      return { ok: false, error: "Couldn't remove the shared copy, so nothing was deleted. Try again." };
    }

    await context.sharing.stop();
    context.store.close();
    context.diagnostics.stop();

    try {
      setOpenAtLogin(false);
    } catch {}

    try {
      await rm(dataRoot(), { recursive: true, force: true });
    } catch (cause) {
      context.diagnostics.restart();
      context.diagnostics.record("permit:delete-local-data", null, cause);
      await reopenAfterFailedShutdown(context);

      return { ok: false, error: "Some local data couldn't be deleted. Try again." };
    }

    context.lifecycle.quitAllowed = true;
    app.quit();

    return { ok: true, value: null };
  });
}
