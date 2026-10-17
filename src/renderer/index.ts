import { finishProject, initAddPermit } from "./add-permit.js";
import { closeSheet, finishConfirm, initOverlays, notice } from "./overlays.js";
import { initPermitActions } from "./permit-actions.js";
import { initPermitDetails, openDetails, refreshHistory } from "./permit-details.js";
import { initScheduleSettings } from "./schedule-settings.js";
import { initSettings } from "./settings.js";
import { initShareSettings } from "./share-settings.js";
import { applySnapshot, fetchSnapshot, initPermitFilter, setFilter, startNextCheckClock } from "./snapshot-render.js";
import { api, ui } from "./state.js";
import { mountWarmBackground } from "./warm-background.js";

const backgroundHost = document.getElementById("warm-background");

const backgroundCanvas = backgroundHost?.querySelector("canvas");

if (backgroundHost && backgroundCanvas instanceof HTMLCanvasElement) {
  const stopBackground = mountWarmBackground(backgroundHost, backgroundCanvas);
  window.addEventListener("pagehide", stopBackground, { once: true });
}

initAddPermit();

initSettings();

initScheduleSettings();

initPermitFilter();

initPermitActions();

initPermitDetails();

initOverlays();

initShareSettings(setFilter);

api.onSnapshot((snapshot) => {
  if (applySnapshot(snapshot)) refreshHistory(snapshot);
});

api.onLocalError((message) => notice(message));

api.onOpenDetails((permitId) => {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet:not(#details-sheet)"))
    closeSheet(dialog);
  finishConfirm(false);
  finishProject(null);

  if (ui.currentSnapshot?.permits.some((permit) => permit.id === permitId)) openDetails(permitId);
  else
    void fetchSnapshot().then((answered) => {
      if (answered) openDetails(permitId);
    });
});

api.onAppEvent((event) => notice(`${event.title}: ${event.body}`, event.tone));

startNextCheckClock();

void fetchSnapshot();
