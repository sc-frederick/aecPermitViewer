import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { PREF_FLAGS } from "../app-state.js";
import { setOpenAtLogin } from "../background.js";
import { installedApp, setDesktopShortcut } from "../squirrel.js";
import { createHandle, NO_INPUT } from "./handle.js";
import { PREFERENCE_KEYS } from "../../shared/bridge.js";
import { keyProblem } from "../../shared/key-format.js";
import { MAX_CHECK_TIMES, normalizeCheckTimes } from "../../shared/schedule.js";

export function registerSettingsHandlers(context: AppContext): void {
  const handle = createHandle(context);

  handle("permit:save-key", z.string(), "Enter your API key.", async (raw) => {
    const key = raw.trim();
    const problem = keyProblem(key);

    if (problem) return { ok: false, error: problem };

    const saved = await context.keys.save(key);

    if (saved._tag === "failed") {
      if (saved.error._tag === "KeyStorageUnavailable")
        return { ok: false, error: "Key storage isn't available, so the key wasn't saved." };
      context.diagnostics.record("permit:save-key", null, saved.error.cause);

      return { ok: false, error: "The key couldn't be saved. Try again." };
    }

    context.notifier.resetKeyNotice();
    context.checks.resume();
    context.scheduler.scheduleDue();
    await context.broadcast();

    return { ok: true, value: null };
  });
  handle("permit:remove-key", NO_INPUT, "Invalid request.", async () => {
    await context.keys.remove();
    await context.broadcast();

    return { ok: true, value: null };
  });
  handle("permit:set-monitoring", z.enum(["manual", "scheduled"]), "Invalid monitoring mode.", (mode) => {
    context.store.setMonitoring(mode);
    context.scheduler.settingsChanged();

    return { ok: true, value: null };
  });
  const checkTimesProblem = `Choose between 1 and ${MAX_CHECK_TIMES} check times.`;

  handle("permit:set-check-times", z.array(z.string()), checkTimesProblem, (times) => {
    const normalized = normalizeCheckTimes(times);

    if (!normalized) return { ok: false, error: checkTimesProblem };
    context.store.setCheckTimes(normalized, new Date());
    context.scheduler.settingsChanged();

    return { ok: true, value: null };
  });
  handle(
    "permit:set-preference",
    z.object({
      key: z.enum(PREFERENCE_KEYS),
      value: z.boolean(),
    }),
    "Invalid setting.",
    async ({ key, value }) => {
      if ((key === "openAtLogin" || key === "desktopShortcut") && !installedApp())
        return { ok: false, error: "Available in the installed app." };

      if (key === "openAtLogin") {
        setOpenAtLogin(value);
      } else if (key === "desktopShortcut") {
        context.offerDesktopShortcut = false;

        try {
          await setDesktopShortcut(value);
        } catch (cause) {
          context.diagnostics.record("permit:desktop-shortcut", null, cause);
          void context.broadcast();

          return { ok: false, error: "The desktop shortcut couldn't be changed." };
        }
      } else {
        context.store.setFlag(PREF_FLAGS[key], value);
      }

      void context.broadcast();

      return { ok: true, value: null };
    },
  );
}
