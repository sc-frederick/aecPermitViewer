import { clipboard } from "electron";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { createHandle, NO_INPUT } from "./handle.js";

export function registerSharingHandlers(context: AppContext): void {
  const handle = createHandle(context);

  handle("permit:share-start", NO_INPUT, "Invalid request.", () => context.sharing.startSharing());
  handle("permit:share-stop", NO_INPUT, "Invalid request.", () => context.sharing.stopSharing());
  handle("permit:share-copy", NO_INPUT, "Invalid request.", () => {
    const code = context.sharing.code();

    if (!code) return { ok: false, error: "This list isn't shared." };
    clipboard.writeText(code);

    return { ok: true, value: null };
  });
  handle("permit:follow", z.string().max(200), "That isn't a share code.", async (code) => {
    const result = await context.sharing.follow(code);

    if (result.ok) for (const permit of context.store.listPermits()) context.checks.cancel(permit.id);

    return result;
  });
  handle("permit:follow-stop", NO_INPUT, "Invalid request.", async () => {
    const result = await context.sharing.stopFollowing();
    context.scheduler.scheduleDue();

    return result;
  });
  handle("permit:share-sync", NO_INPUT, "Invalid request.", () => context.sharing.sync());
}
