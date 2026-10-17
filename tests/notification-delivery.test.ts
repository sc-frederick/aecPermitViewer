import { describe, expect, it } from "vitest";
import type { AppEvent } from "../src/shared/bridge.js";
import {
  CheckNotifier,
  DesktopNotificationFailed,
  type DesktopDelivery,
  type NotificationState,
} from "../src/main/notification-delivery.js";
import { keyNotice, type CheckEvent } from "../src/main/notifications.js";

const review: CheckEvent = {
  kind: "review-action",
  permitId: "permit-one",
  title: "HC-SITECON-26-0000004",
  body: "Natural Resources Review: Corrections Required · Action: AEC",
};

interface DeliveryResult {
  value: DesktopDelivery;
}

/** Real routing policy with observable in-memory notification destinations. */
function delivery(overrides: Partial<NotificationState> = {}) {
  const state: NotificationState = {
    statusChanges: true,
    failures: true,
    desktop: true,
    windowInFront: false,
    ...overrides,
  };

  const inApp: AppEvent[] = [];
  const desktop: AppEvent[] = [];
  const failures: DesktopNotificationFailed[] = [];
  const result: DeliveryResult = { value: { _tag: "shown" } };

  const notifier = new CheckNotifier({
    state: () => state,
    inApp: (notice) => {
      inApp.push(notice);
    },
    desktop: async (notice) => {
      desktop.push(notice);

      return result.value;
    },
    failed: (error) => {
      failures.push(error);
    },
  });

  return { state, inApp, desktop, failures, result, notifier };
}

describe("notification delivery", () => {
  it("surfaces review corrections on the desktop while Windows is in the background", async () => {
    const app = delivery();
    await app.notifier.announce(review);
    expect(app.desktop).toEqual([{ tone: "info", title: review.title, body: review.body, permitId: review.permitId }]);
    expect(app.inApp).toEqual([]);
  });

  it.each<[string, Partial<NotificationState>]>([
    ["the window is in front", { windowInFront: true }],
    ["the app posts no desktop notifications", { desktop: false }],
  ])("shows the notice in the window instead of the desktop when %s", async (_situation, state) => {
    const app = delivery(state);
    await app.notifier.announce(review);
    expect(app.inApp).toHaveLength(1);
    expect(app.desktop).toEqual([]);
  });

  it("respects the separate status and failure preferences", async () => {
    const app = delivery({ statusChanges: false });
    await app.notifier.announce(review);
    await app.notifier.announce({ ...review, kind: "first-status" });
    await app.notifier.announce({ ...review, kind: "status-changed" });
    expect(app.desktop).toEqual([]);
    await app.notifier.announce({ ...review, kind: "check-failed" });
    expect(app.desktop).toHaveLength(1);
    app.state.failures = false;
    await app.notifier.announce({ ...review, kind: "check-failed" });
    app.state.statusChanges = true;
    await app.notifier.announce(review);
    expect(app.desktop.map((notice) => notice.tone)).toEqual(["error", "info"]);
  });

  it.each(["unsupported", "failed", "not_shown"] as const)(
    "preserves %s desktop delivery until the user returns",
    async (code) => {
      const app = delivery();
      app.result.value = { _tag: "failed", error: new DesktopNotificationFailed(code) };
      await app.notifier.announce(review);
      app.notifier.windowFocused();
      expect(app.inApp).toEqual([]);
      expect(app.failures.map((error) => error.code)).toEqual([code]);
      app.state.windowInFront = true;
      app.notifier.windowFocused();
      app.notifier.windowFocused();
      expect(app.inApp).toEqual([{ tone: "info", title: review.title, body: review.body, permitId: review.permitId }]);
    },
  );

  it("surfaces a late native failure if the user already returned to the app", async () => {
    const app = delivery();
    app.result.value = { _tag: "failed", error: new DesktopNotificationFailed("failed") };
    const pending = app.notifier.announce(review);
    app.state.windowInFront = true;
    await pending;
    expect(app.inApp).toHaveLength(1);
  });

  it("summarizes multiple pending notices instead of immediately overwriting them", async () => {
    const app = delivery();
    app.result.value = { _tag: "failed", error: new DesktopNotificationFailed("failed") };
    await app.notifier.announce(review);
    await app.notifier.announce({ ...review, permitId: "permit-two" });
    app.state.windowInFront = true;
    app.notifier.windowFocused();
    expect(app.inApp).toHaveLength(1);
    expect(app.inApp[0]?.body).toContain("2 permits or checks have updates");
  });

  it("drops an older pending notice when a newer notice for the permit succeeds", async () => {
    const app = delivery();
    app.result.value = { _tag: "failed", error: new DesktopNotificationFailed("failed") };
    await app.notifier.announce(review);
    app.result.value = { _tag: "shown" };
    await app.notifier.announce({ ...review, body: "Newer review request" });
    app.state.windowInFront = true;
    app.notifier.windowFocused();
    expect(app.inApp).toEqual([]);
  });

  it("groups key notices until a new key or explicit check resets them", async () => {
    const app = delivery();
    await app.notifier.announce(keyNotice("missing"));
    await app.notifier.announce(keyNotice("missing"));
    expect(app.desktop).toHaveLength(1);
    app.notifier.resetKeyNotice();
    await app.notifier.announce(keyNotice("missing"));
    expect(app.desktop).toHaveLength(2);
  });
});
