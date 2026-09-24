import { app, Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import path from "node:path";

// Squirrel.Windows registers shortcuts under com.squirrel.<maker name>.<executable name>.
// Windows only delivers toast notifications for an app whose ID matches its Start menu shortcut.
export const APP_USER_MODEL_ID = "com.squirrel.PermitMonitor.PermitMonitor";
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface BackgroundHooks {
  showWindow(): void;
  openPermit(permitId: string): void;
  checkAll(): void;
  setScheduled(enabled: boolean): void;
  quit(): void;
}

export interface TrayState {
  permits: number;
  checking: number;
  failing: number;
  scheduled: boolean;
  /** The check times in words, e.g. "8:30 AM, 12:30 PM, and 4:30 PM". */
  checkTimes: string;
}

export class Background {
  private tray: Tray | null = null;
  private attention = false;
  private readonly live = new Set<Notification>();

  constructor(private readonly assetDir: string, private readonly hooks: BackgroundHooks) {}

  /** The packaged product is Windows-only; other platforms keep ordinary close-to-quit behavior. */
  start(): boolean {
    if (process.platform !== "win32") return false;
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

  get available(): boolean {
    return this.tray !== null;
  }

  update(state: TrayState): void {
    if (!this.tray) return;
    const summary = state.checking > 0 ? `${state.checking} check${state.checking === 1 ? "" : "s"} running`
      : state.failing > 0 ? `${state.failing} latest check${state.failing === 1 ? "" : "s"} failed`
        : `${state.permits} permit${state.permits === 1 ? "" : "s"} tracked`;
    this.tray.setToolTip(`Permit Monitor\n${summary}\nScheduled checks ${state.scheduled ? `at ${state.checkTimes}` : "off"}`);
    const attention = state.failing > 0;
    if (attention !== this.attention) {
      this.attention = attention;
      this.tray.setImage(this.image(attention ? "tray-attention" : "tray"));
    }
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Permit Monitor", click: () => this.hooks.showWindow() },
      { label: "Check all permits now", enabled: state.permits > 0, click: () => this.hooks.checkAll() },
      { type: "separator" },
      { label: `Scheduled checks (${state.checkTimes})`, type: "checkbox", checked: state.scheduled, click: (item) => this.hooks.setScheduled(item.checked) },
      { type: "separator" },
      { label: "Quit Permit Monitor", click: () => this.hooks.quit() },
    ]));
  }

  notify(input: { title: string; body: string; permitId?: string }): void {
    if (process.platform !== "win32" || !Notification.isSupported()) return;
    const notification = new Notification({ title: input.title, body: input.body, icon: this.image("icon") });
    // Holding a reference keeps the click handler alive until Windows dismisses the toast.
    this.live.add(notification);
    const release = () => this.live.delete(notification);
    notification.on("click", () => {
      release();
      if (input.permitId) this.hooks.openPermit(input.permitId); else this.hooks.showWindow();
    });
    notification.on("close", release);
    setTimeout(release, 30 * 60_000).unref();
    notification.show();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private image(name: string): NativeImage {
    return nativeImage.createFromPath(path.join(this.assetDir, `${name}.png`));
  }
}

export function openAtLoginAvailable(): boolean {
  return process.platform === "win32" && app.isPackaged;
}

function loginItemTarget(): { path: string; args: string[] } {
  // Launch through Squirrel's Update.exe so the login item survives app updates.
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  return { path: updateExe, args: ["--processStart", `"${path.basename(process.execPath)}"`, "--process-start-args", `"${HIDDEN_LAUNCH_ARG}"`] };
}

export function getOpenAtLogin(): boolean {
  if (!openAtLoginAvailable()) return false;
  return app.getLoginItemSettings(loginItemTarget()).openAtLogin;
}

export function setOpenAtLogin(enabled: boolean): void {
  if (!openAtLoginAvailable()) return;
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemTarget() });
}
