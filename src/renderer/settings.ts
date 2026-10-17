import { PREFERENCE_KEYS, type KeyState } from "../shared/bridge.js";
import { keyProblem } from "../shared/key-format.js";
import type { AppPreferences, AppSnapshot, PreferenceKey } from "../shared/permit.js";
import { busy, element, setInlineError } from "./dom.js";
import { confirmAction, notice } from "./overlays.js";
import { api, ui } from "./state.js";

const settingsSheet = element("settings-sheet", HTMLDialogElement);

const openSettings = element("open-settings", HTMLButtonElement);

const keyBanner = element("key-banner");

const keyBannerTitle = element("key-banner-title");

const bannerAddKey = element("banner-add-key", HTMLButtonElement);

const settingsKeyState = element("settings-key-state");

const keyForm = element("key-form", HTMLFormElement);

const keyInput = element("key-input", HTMLInputElement);

const keyError = element("key-error");

const keySave = element("key-save", HTMLButtonElement);

const keyRemove = element("key-remove", HTMLButtonElement);

const trayPlace = element("tray-place");

const preferenceInputs = document.querySelectorAll<HTMLInputElement>("input[data-pref]");

const checkUpdate = element("check-update", HTMLButtonElement);

const updateStatus = element("update-status");

const downloadUpdate = element("download-update", HTMLButtonElement);

const installUpdate = element("install-update", HTMLButtonElement);

const deleteLocalData = element("delete-local-data", HTMLButtonElement);

let desktopShortcutAsked = false;

function preferenceKey(value: string | undefined): PreferenceKey | null {
  return PREFERENCE_KEYS.find((key) => key === value) ?? null;
}

/** What the window says about a key state that holds checks back. */
interface KeyStateCopy {
  banner: string;
  /** The banner button's label, which opens the key settings; null when saving a key can't help. */
  action: string | null;
  /** The note above the key field in Settings, if any. */
  settings: string | null;
}

function keyStateCopy(state: Exclude<KeyState, "configured">): KeyStateCopy {
  switch (state) {
    case "missing":
      return { banner: "Add your TypeSafe key to run checks.", action: "Add key", settings: null };
    case "unavailable":
      return {
        banner: "Key storage isn't available on this computer.",
        action: null,
        settings: "Key storage isn't available on this computer.",
      };
    case "unreadable":
      return {
        banner: "Your saved TypeSafe key can't be read. Checks are paused.",
        action: "Save key again",
        settings: "The saved key can't be read. Paste it again to keep checking.",
      };
    case "rejected":
      return {
        banner: "TypeSafe turned down your key. Scheduled checks are paused.",
        action: "Replace key",
        settings: "TypeSafe turned down the saved key. Paste a working key to resume scheduled checks.",
      };
  }
}

/**
 * Shows the key banner whenever a key problem holds checks back, regardless of notification settings, and updates the
 * key form in Settings to match.
 */
export function renderKey(state: KeyState): void {
  const copy = state === "configured" ? null : keyStateCopy(state);
  keyBanner.hidden = copy === null;
  keyBannerTitle.textContent = copy?.banner ?? "";
  bannerAddKey.hidden = !copy?.action;
  bannerAddKey.textContent = copy?.action ?? "";
  settingsKeyState.hidden = !copy?.settings;
  settingsKeyState.textContent = copy?.settings ?? "";
  keyForm.hidden = state === "unavailable";
  // A saved key that doesn't work is still saved: it can be replaced or removed.
  const saved = state === "configured" || state === "unreadable" || state === "rejected";
  keyInput.placeholder = state === "configured" ? "Saved. Paste a new key to replace it." : "Paste your API key";
  keySave.textContent = saved ? "Replace" : "Save";
  keySave.className = `btn btn-sm ${state === "configured" ? "btn-secondary" : "btn-primary"}`;
  keyRemove.hidden = !saved;
}

/**
 * Sets the preference checkboxes and what this platform and install offer, then asks about a desktop shortcut once on
 * the first launch after installing.
 */
export function renderPreferences(preferences: AppPreferences, platform: AppSnapshot["platform"]): void {
  trayPlace.textContent = platform === "mac" ? "menu bar" : "tray";

  for (const input of preferenceInputs) {
    const key = preferenceKey(input.dataset.pref);

    if (!key) continue;
    input.checked = preferences[key];
    const label = input.closest("label");

    if (key === "runInBackground") {
      input.disabled = !preferences.backgroundAvailable;

      if (label) label.title = preferences.backgroundAvailable ? "" : "Available on Windows and macOS.";
    }

    // Sign-in and desktop shortcuts come from the Windows installer; a Mac copy has neither.
    if (key === "openAtLogin" || key === "desktopShortcut") {
      input.disabled = !preferences.installedApp;

      if (label) {
        label.hidden = platform === "mac";
        label.title = preferences.installedApp ? "" : "Available in the installed app.";
      }
    }
  }

  if (preferences.offerDesktopShortcut && !desktopShortcutAsked) void askDesktopShortcut();
}

/** Asks on the first launch after installing, since the installer can't. Either answer is saved as the setting. */
async function askDesktopShortcut(): Promise<void> {
  desktopShortcutAsked = true;

  const wanted = await confirmAction(
    "Add a desktop shortcut?",
    "Permit Monitor is in the Start menu. You can change this later in Settings.",
    "Add shortcut",
    "Not now",
  );

  const result = await api.setPreference("desktopShortcut", wanted);

  if (!result.ok) notice(result.error);
}

function openKeySettings(): void {
  if (!settingsSheet.open) settingsSheet.showModal();
  keyInput.focus();
}

/** Wires the Settings button and the key, preference, update, and data controls. */
export function initSettings(): void {
  bannerAddKey.addEventListener("click", openKeySettings);

  keyInput.addEventListener("input", () => setInlineError(keyInput, keyError, null));

  keyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const problem = keyProblem(keyInput.value.trim());

    if (problem) {
      setInlineError(keyInput, keyError, problem);
      keyInput.focus();

      return;
    }

    // Clear the field before sending so the key does not linger in the window.
    const key = keyInput.value.trim();
    keyInput.value = "";
    const result = await busy(keySave, () => api.saveKey(key));

    if (!result.ok) {
      setInlineError(keyInput, keyError, result.error);
      keyInput.focus();

      return;
    }

    setInlineError(keyInput, keyError, null);
    // Main sends the updated snapshot before it answers, so the banner is already current.
    notice("Key saved.", "info");
  });

  keyRemove.addEventListener("click", async () => {
    if (!(await confirmAction("Remove your TypeSafe key?", "Checks stop until you add a key.", "Remove"))) return;
    const result = await api.removeKey();

    if (!result.ok) {
      notice(result.error);

      return;
    }

    notice("Key removed.", "info");
  });

  openSettings.addEventListener("click", () => settingsSheet.showModal());

  checkUpdate.addEventListener("click", async () => {
    updateStatus.hidden = false;
    downloadUpdate.hidden = true;
    installUpdate.hidden = true;
    const result = await busy(checkUpdate, () => api.checkForUpdate());

    if (!result.ok) {
      updateStatus.textContent = result.error;

      return;
    }

    if (result.value.state === "unavailable") updateStatus.textContent = "No update feed in this build.";
    else if (result.value.state === "current") updateStatus.textContent = "You're up to date.";
    // The size is the Windows installer's, so a Mac copy leaves it out.
    else if (ui.currentSnapshot?.platform === "mac") {
      updateStatus.textContent = `Version ${result.value.version} available. Download it, quit Permit Monitor, and replace the copy in Applications.`;
      downloadUpdate.hidden = false;
    } else {
      updateStatus.textContent = `Version ${result.value.version} available (${Math.ceil(result.value.size / 1_000_000)} MB).`;
      downloadUpdate.hidden = false;
    }
  });

  downloadUpdate.addEventListener("click", async () => {
    if (ui.currentSnapshot?.platform === "mac") {
      const result = await busy(downloadUpdate, () => api.openUpdateDownload());

      if (!result.ok) updateStatus.textContent = result.error;

      return;
    }

    updateStatus.textContent = "Downloading… This can take a few minutes.";
    // A check during the download could replace the update being downloaded.
    checkUpdate.disabled = true;

    const result = await busy(downloadUpdate, () => api.downloadUpdate()).finally(() => {
      checkUpdate.disabled = false;
    });

    if (!result.ok) {
      updateStatus.textContent = result.error;

      return;
    }

    downloadUpdate.hidden = true;
    updateStatus.textContent = `Version ${result.value} is ready to install.`;
    installUpdate.hidden = false;
  });

  installUpdate.addEventListener("click", async () => {
    if (!(await confirmAction("Install the update?", "Permit Monitor will close to install it.", "Install"))) return;
    const result = await api.installUpdate();

    if (!result.ok) notice(result.error);
  });

  deleteLocalData.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Delete all data?",
        "Permits, history, and your key will be deleted and the app will close. This can't be undone.",
        "Delete",
      ))
    )
      return;
    const result = await api.deleteLocalData("DELETE LOCAL DATA");

    if (!result.ok) notice(result.error);
  });

  for (const input of preferenceInputs) {
    const key = preferenceKey(input.dataset.pref);

    if (!key) continue;
    input.addEventListener("change", async () => {
      const result = await api.setPreference(key, input.checked);

      if (!result.ok) {
        input.checked = !input.checked;
        notice(result.error);
      }
    });
  }
}
