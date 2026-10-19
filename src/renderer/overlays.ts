import { element, eventButton } from "./dom.js";

const noticeElement = element("notice", HTMLDivElement);

const noticeText = element("notice-text");

const noticeIcon = element("notice-icon", SVGUseElement);

const confirmDialog = element("confirm-dialog", HTMLDialogElement);

const confirmTitle = element("confirm-title");

const confirmBody = element("confirm-body");

const confirmAccept = element("confirm-accept", HTMLButtonElement);

const confirmCancel = element("confirm-cancel", HTMLButtonElement);

let noticeTimer: number | null = null;

let settleConfirm: ((accepted: boolean) => void) | null = null;

const closeHooks = new Map<HTMLDialogElement, () => void>();

// Modal dialogs make the rest of the page inert, so notices must live inside the frontmost dialog.
function placeNotice(): void {
  const host =
    document.querySelector("dialog.confirm:modal") ?? document.querySelector("dialog.sheet:modal") ?? document.body;

  if (noticeElement.parentElement !== host) host.append(noticeElement);
}

/** Shows `message` in the notice bar in front of any open dialog; errors stay up for 9 seconds, info for 5. */
export function notice(message: string, kind: "info" | "error" = "error"): void {
  placeNotice();
  noticeText.textContent = message;
  noticeElement.dataset.kind = kind;
  noticeIcon.setAttribute("href", kind === "error" ? "#i-alert" : "#i-check");
  noticeElement.hidden = false;

  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(
    () => {
      noticeElement.hidden = true;
    },
    kind === "error" ? 9000 : 5000,
  );
}

/**
 * Asks a yes-or-no question in the confirm dialog. Resolves true when `accept` is chosen, and false when the dialog is
 * dismissed or another confirmation replaces it.
 */
export function confirmAction(title: string, body: string, accept: string, cancel = "Cancel"): Promise<boolean> {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmAccept.textContent = accept;
  confirmCancel.textContent = cancel;
  settleConfirm?.(false);
  confirmDialog.showModal();

  return new Promise((resolve) => {
    settleConfirm = resolve;
  });
}

/** Closes the confirm dialog, if open, and settles its pending question with `accepted`. */
export function finishConfirm(accepted: boolean): void {
  if (confirmDialog.open) confirmDialog.close();
  const settle = settleConfirm;
  settleConfirm = null;
  settle?.(accepted);
}

/** Registers `hook` to run each time `closeSheet` is called for `dialog`, whether or not it was open. */
export function onSheetClose(dialog: HTMLDialogElement, hook: () => void): void {
  closeHooks.set(dialog, hook);
}

/** Closes a sheet if it is open and runs its close hook. */
export function closeSheet(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  closeHooks.get(dialog)?.();
}

/** Wires sheet dismissal, notice placement, and the confirm dialog's buttons. */
export function initOverlays(): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.sheet")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeSheet(dialog);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSheet(dialog);
    });
    dialog.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", () => closeSheet(dialog));
  }

  for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("toggle", placeNotice);

  confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishConfirm(false);
  });

  confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) {
      finishConfirm(false);

      return;
    }

    const choice = eventButton(event, "button[value]")?.value;

    if (choice) {
      event.preventDefault();
      finishConfirm(choice === "accept");
    }
  });
}
