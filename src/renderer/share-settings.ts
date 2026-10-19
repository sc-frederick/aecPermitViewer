import type { ShareState } from "../shared/bridge.js";
import { busy, element, setInlineError } from "./dom.js";
import { permitCount, stamp } from "./format.js";
import { confirmAction, notice } from "./overlays.js";
import { api, ui, type Filter } from "./state.js";

const shareStatus = element("share-status");

const shareOff = element("share-off");

const shareOn = element("share-on");

const followOn = element("follow-on");

const shareSync = element("share-sync", HTMLButtonElement);

const shareCode = element("share-code", HTMLInputElement);

const shareStart = element("share-start", HTMLButtonElement);

const shareCopy = element("share-copy", HTMLButtonElement);

const shareStop = element("share-stop", HTMLButtonElement);

const followForm = element("follow-form", HTMLFormElement);

const followInput = element("follow-input", HTMLInputElement);

const followError = element("follow-error");

const followSave = element("follow-save", HTMLButtonElement);

const followStop = element("follow-stop", HTMLButtonElement);

export function renderShare(share: ShareState): void {
  shareOff.hidden = share.mode !== "off" || !share.available;
  shareOn.hidden = share.mode !== "sharing";
  followOn.hidden = share.mode !== "following";
  shareSync.hidden = share.mode === "off";
  shareSync.title =
    share.mode === "sharing" ? "Send the shared list now" : "Get the newest copy of the shared list now";

  switch (share.mode) {
    case "off":
      shareStatus.textContent = share.available
        ? "Share a read-only copy of this list, or follow a list someone shares with you."
        : "Sharing isn't available in this build.";
      break;
    case "sharing":
      if (shareCode.value !== share.code) shareCode.value = share.code;
      shareStatus.textContent =
        share.problem ??
        (share.publishedAt
          ? `Anyone with this code can view this list. It's sent after each round of checks; last sent ${stamp(share.publishedAt)}.`
          : "Anyone with this code can view this list. It's sent after each round of checks.");
      break;
    case "following":
      shareStatus.textContent =
        share.problem ??
        (share.publishedAt
          ? `Viewing a shared list, sent ${stamp(share.publishedAt)}. A newer copy is fetched after each of the owner's check times.`
          : "Viewing a shared list.");
      break;
  }
}

export function initShareSettings(setFilter: (next: Filter) => void): void {
  shareStart.addEventListener("click", async () => {
    const result = await busy(shareStart, () => api.startSharing());

    if (!result.ok) notice(result.error);
  });

  shareCopy.addEventListener("click", async () => {
    const result = await api.copyShareCode();

    if (result.ok) notice("Share code copied.", "info");
    else notice(result.error);
  });

  shareStop.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Stop sharing this list?",
        "The code stops working, and people following it keep only the copy they last received.",
        "Stop sharing",
      ))
    )
      return;
    const result = await busy(shareStop, () => api.stopSharing());

    if (!result.ok) notice(result.error);
  });

  followInput.addEventListener("input", () => setInlineError(followInput, followError, null));

  followForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = followInput.value.trim();

    if (!code) {
      setInlineError(followInput, followError, "Paste the code someone shared with you.");
      followInput.focus();

      return;
    }

    const own = ui.currentSnapshot?.share.mode === "off" ? ui.currentSnapshot.permits.length : 0;

    if (
      own > 0 &&
      !(await confirmAction(
        "Follow this shared list?",
        `Your own ${permitCount(own)} stay on this computer but aren't shown or checked until you stop following.`,
        "Follow",
      ))
    )
      return;
    const result = await busy(followSave, () => api.follow(code));

    if (!result.ok) {
      setInlineError(followInput, followError, result.error);
      followInput.focus();

      return;
    }

    followInput.value = "";
    setInlineError(followInput, followError, null);

    if (ui.filter !== "all") setFilter("all");
    notice("Following the shared list.", "info");
  });

  shareSync.addEventListener("click", async () => {
    const sharing = ui.currentSnapshot?.share.mode === "sharing";
    const result = await busy(shareSync, () => api.syncShared());

    if (result.ok) notice(sharing ? "Shared list sent." : "Shared list is up to date.", "info");
    else notice(result.error);
  });

  followStop.addEventListener("click", async () => {
    if (
      !(await confirmAction(
        "Stop following?",
        "Your own list comes back. You'll need the code to follow this list again.",
        "Stop following",
      ))
    )
      return;
    const result = await api.stopFollowing();

    if (!result.ok) notice(result.error);
  });
}
