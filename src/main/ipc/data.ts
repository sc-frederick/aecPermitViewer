import { app } from "electron";
import { rm } from "node:fs/promises";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { setOpenAtLogin } from "../background.js";
import { dataRoot } from "../paths.js";
import { reopenAfterFailedShutdown, resumeAfterFailedShutdown, stopChecks } from "../shutdown.js";
import { createHandle } from "./handle.js";

/** Registers the window's request to delete all local data and quit. */
export function registerDataHandlers(context: AppContext): void {
  const handle = createHandle(context);

  handle("permit:delete-local-data", z.literal("DELETE LOCAL DATA"), "Deletion was not confirmed.", async () => {
    if (!(await stopChecks(context))) {
      resumeAfterFailedShutdown(context);

      return { ok: false, error: "A check is still running. Try again." };
    }

    // An update download writes inside the data folder, so it has to stop and let go of its files first.
    await context.updates.cancel();
    // The shared copy goes with the local data, so the code others hold stops working. The write key is the only way to
    // delete it, so local data stays until the deletion goes through.
    const unshared = await context.sharing.stopSharing();

    if (!unshared.ok) {
      resumeAfterFailedShutdown(context);

      return { ok: false, error: "Couldn't remove the shared copy, so nothing was deleted. Try again." };
    }

    await context.sharing.stop();
    context.store.close();
    // Stopping the queue sent a snapshot that now fails on the closed store; recording that would recreate the folder.
    context.diagnostics.stop();

    try {
      setOpenAtLogin(false);
    } catch {
      /* local data deletion continues */
    }

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
