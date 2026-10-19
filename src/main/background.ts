import { app, Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import path from "node:path";
import { DesktopNotificationFailed, type DesktopDelivery } from "./notification-delivery.js";
import { installedApp, updateExePath } from "./squirrel.js";

/**
 * The ID Squirrel.Windows gives the Start menu shortcut: com.squirrel.<maker name>.<executable name>. Windows only
 * delivers toast notifications for an app whose ID matches its Start menu shortcut.
 */
export const APP_USER_MODEL_ID = "com.squirrel.PermitMonitor.PermitMonitor";

/** Starts the app with its window hidden when a tray or menu bar icon is available. The login item passes it. */
export const HIDDEN_LAUNCH_ARG = "--hidden";

/** Windows and macOS: the platforms with a tray or menu bar icon and desktop notifications. */
export function desktopPlatform(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/** Where the icon lives, in the words each platform uses. */
export const TRAY_PLACE = process.platform === "darwin" ? "menu bar" : "tray";

/** What the tray or menu bar menu asks the rest of main to do. */
export interface BackgroundHooks {
  showWindow(): void;
  openPermit(permitId: string): void;
  checkAll(): void;
  setScheduled(enabled: boolean): void;
  quit(): void;
}

/** The counts and schedule the tray or menu bar icon summarizes. */
export interface TrayState {
  permits: number;
  checking: number;
  failing: number;
  scheduled: boolean;
  checkTimes: string;
}

/** The tray or menu bar icon and desktop notifications that let the app keep running with its window closed. */
export class Background {
  private tray: Tray | null = null;
  private attention = false;
  private shownState = "";
  private readonly live = new Set<Notification>();

  constructor(
    private readonly assetDir: string,
    private readonly hooks: BackgroundHooks,
  ) {}

  /**
   * Creates the tray icon on Windows or the menu bar icon on macOS. Returns false on other platforms, which keep
   * ordinary close-to-quit behavior, or when the icon can't be created.
   */
  start(): boolean {
    if (!desktopPlatform()) return false;

    try {
      this.tray = new Tray(this.image("tray"));
      this.tray.setToolTip("Permit Monitor");
      this.tray.on("click", () => this.hooks.showWindow());

      return true;
    } catch {
      this.tray = null;

      return false;
    }
  }

  /** Whether the icon exists. Without it, the app can't keep running with its window closed. */
  get available(): boolean {
    return this.tray !== null;
  }

  /** Refreshes the icon's tooltip, attention image, and menu; does nothing when `state` is unchanged. */
  update(state: TrayState): void {
    if (!this.tray) return;
    const shown = JSON.stringify(state);

    if (shown === this.shownState) return;
    this.shownState = shown;

    const summary =
      state.checking > 0
        ? `${state.checking} check${state.checking === 1 ? "" : "s"} running`
        : state.failing > 0
          ? `${state.failing} latest check${state.failing === 1 ? "" : "s"} failed`
          : `${state.permits} permit${state.permits === 1 ? "" : "s"} tracked`;

    this.tray.setToolTip(
      `Permit Monitor\n${summary}\nScheduled checks ${state.scheduled ? `at ${state.checkTimes}` : "off"}`,
    );
    const attention = state.failing > 0;

    if (attention !== this.attention) {
      this.attention = attention;
      this.tray.setImage(this.image(attention ? "tray-attention" : "tray"));
    }

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Permit Monitor", click: () => this.hooks.showWindow() },
        { label: "Check all permits now", enabled: state.permits > 0, click: () => this.hooks.checkAll() },
        { type: "separator" },
        {
          label: `Scheduled checks (${state.checkTimes})`,
          type: "checkbox",
          checked: state.scheduled,
          click: (item) => this.hooks.setScheduled(item.checked),
        },
        { type: "separator" },
        { label: "Quit Permit Monitor", click: () => this.hooks.quit() },
      ]),
    );
  }

  /**
   * Shows a desktop notification. Resolves `shown` once Electron reports it displayed, or `failed` when it is
   * unsupported, fails, or isn't shown within 10 seconds, so the caller can show the notice in the app instead. Never
   * rejects.
   */
  notify(input: { title: string; body: string; permitId?: string }): Promise<DesktopDelivery> {
    return new Promise((resolve) => {
      const fail = (code: DesktopNotificationFailed["code"]) =>
        resolve({ _tag: "failed", error: new DesktopNotificationFailed(code) });

      let cleanup = () => {};

      try {
        if (!desktopPlatform() || !Notification.isSupported()) {
          fail("unsupported");

          return;
        }

        const notification = new Notification({ title: input.title, body: input.body, icon: this.image("icon") });
        // Keep timed-out banners alive too: they can still be clicked in Notification Center.
        this.live.add(notification);
        const release = () => this.live.delete(notification);

        const timeout = setTimeout(() => {
          release();
          fail("not_shown");
        }, 10_000);

        cleanup = () => {
          clearTimeout(timeout);
          release();
        };

        timeout.unref();
        notification.on("show", () => {
          clearTimeout(timeout);
          resolve({ _tag: "shown" });
        });
        notification.on("failed", () => {
          clearTimeout(timeout);
          release();
          fail("failed");
        });
        notification.on("click", () => {
          release();

          if (input.permitId) this.hooks.openPermit(input.permitId);
          else this.hooks.showWindow();
        });
        notification.on("close", (details) => {
          if (details.reason !== "timedOut") release();
        });
        setTimeout(release, 30 * 60_000).unref();
        notification.show();
      } catch {
        cleanup();
        fail("failed");
      }
    });
  }

  /** Removes the icon. */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private image(name: string): NativeImage {
    return nativeImage.createFromPath(path.join(this.assetDir, `${name}.png`));
  }
}

function loginItemTarget() {
  // Launch through Squirrel's Update.exe so the login item survives app updates.
  return {
    path: updateExePath(),
    args: ["--processStart", `"${path.basename(process.execPath)}"`, "--process-start-args", `"${HIDDEN_LAUNCH_ARG}"`],
  };
}

/** Whether the installed Windows app starts at sign-in; always false elsewhere. */
export function getOpenAtLogin(): boolean {
  if (!installedApp()) return false;

  return app.getLoginItemSettings(loginItemTarget()).openAtLogin;
}

/** Turns starting at sign-in on or off for the installed Windows app; does nothing elsewhere. */
export function setOpenAtLogin(enabled: boolean): void {
  if (!installedApp()) return;
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemTarget() });
}
