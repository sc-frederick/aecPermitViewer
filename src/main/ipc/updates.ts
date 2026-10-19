import { app, shell } from "electron";
import { spawn } from "node:child_process";
import type { AppContext } from "../app-context.js";
import { reopenAfterFailedShutdown, resumeAfterFailedShutdown, stopChecks } from "../shutdown.js";
import { createHandle, NO_INPUT } from "./handle.js";

/** Registers the window's update requests: checking, downloading, and installing an update. */
export function registerUpdateHandlers(context: AppContext): void {
  const handle = createHandle(context);

  handle("permit:check-update", NO_INPUT, "Invalid request.", async () => {
    try {
      return { ok: true, value: await context.updates.check() };
    } catch (cause) {
      context.diagnostics.record("permit:check-update", null, cause);

      return { ok: false, error: "Couldn't check for updates." };
    }
  });
  handle("permit:download-update", NO_INPUT, "Invalid request.", async () => {
    if (process.platform === "darwin") return { ok: false, error: "Download the new version from the download page." };

    try {
      return { ok: true, value: await context.updates.download() };
    } catch (cause) {
      context.diagnostics.record("permit:download-update", null, cause);

      return { ok: false, error: "Download failed. Nothing was changed." };
    }
  });
  handle("permit:open-update-download", NO_INPUT, "Invalid request.", async () => {
    const page = context.updates.macDownloadUrl();

    if (process.platform !== "darwin" || !page) return { ok: false, error: "No download page in this build." };
    await shell.openExternal(page);

    return { ok: true, value: null };
  });
  handle("permit:install-update", NO_INPUT, "Invalid request.", async () => {
    let installer: string;

    try {
      installer = await context.updates.installerForApprovedHandoff();
    } catch (cause) {
      context.diagnostics.record("permit:install-update:verify", null, cause);

      return { ok: false, error: "The update failed verification. Check again." };
    }

    if (!(await stopChecks(context))) {
      resumeAfterFailedShutdown(context);

      return { ok: false, error: "A check is still running. Try again." };
    }

    await context.sharing.stop();

    try {
      context.store.close();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(installer, [], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      context.lifecycle.quitAllowed = true;
      app.quit();

      return { ok: true, value: null };
    } catch (cause) {
      context.diagnostics.record("permit:install-update:start", null, cause);
      await reopenAfterFailedShutdown(context);

      return { ok: false, error: "The installer couldn't start. Restart the app and try again." };
    }
  });
}
