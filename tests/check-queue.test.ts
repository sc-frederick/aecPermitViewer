import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckQueue, SCOPE_SPACING_MS, type KeyProblem, type StartedCheck } from "../src/main/check-queue.js";
import type { RunOutcome } from "../src/shared/permit.js";

/**
 * What the test changes between steps: the saved key ("unreadable" makes reading it fail), when reading it finishes,
 * and whether scheduled work still qualifies.
 */
interface HarnessState {
  key: string | null;
  keyRead: Promise<void>;
  eligible: boolean;
}

/** A promise the test settles by hand, standing in for a slow prerequisite. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/** A gate that stays closed until the test opens it. */
function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });

  return { promise, open };
}

/** A queue wired to in-memory answers; each started check waits until the test finishes it. */
function harness(scopes: Record<string, string>) {
  const started: string[] = [];
  const running = new Map<string, (outcome: RunOutcome) => void>();
  const deferred: string[] = [];
  const keyNotices: Array<[KeyProblem, boolean]> = [];
  const state: HarnessState = { key: "key", keyRead: Promise.resolve(), eligible: true };

  const queue = new CheckQueue({
    scopeOf: (permitId) => scopes[permitId] ?? null,
    scheduledEligible: () => state.eligible,
    readKey: async () => {
      await state.keyRead;

      if (state.key === "unreadable") throw new Error("decryption failed");

      return state.key;
    },
    start: (permitId): StartedCheck => {
      started.push(permitId);
      let finish: (outcome: RunOutcome) => void = () => undefined;
      const finished = new Promise<RunOutcome>((resolve) => { finish = resolve; });
      running.set(permitId, finish);

      return { finished, cancel: () => finish("cancelled") };
    },
    defer: (permitId) => deferred.push(permitId),
    keyUnavailable: (problem, requested) => keyNotices.push([problem, requested]),
    saveFailed: () => undefined,
    changed: () => undefined,
  });

  /** Ends a running check and lets the queue react. */
  async function finish(permitId: string, outcome: RunOutcome = "success"): Promise<void> {
    running.get(permitId)?.(outcome);
    running.delete(permitId);
    await vi.advanceTimersByTimeAsync(0);
  }

  return { queue, started, deferred, keyNotices, state, finish };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 9, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("check pacing", () => {
  it("lets a permit on another portal go ahead while one portal cools down", async () => {
    const { queue, started, finish } = harness({ a1: "accela", a2: "accela", h1: "tyler" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "manual");
    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1"]);

    await finish("a1");
    expect(started).toEqual(["a1", "h1"]);

    await finish("h1");
    expect(started).toEqual(["a1", "h1"]);
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS);
    expect(started).toEqual(["a1", "h1", "a2"]);
  });

  it("spaces checks on one portal from the end of the last one", async () => {
    const { queue, started, finish } = harness({ a1: "accela", a2: "accela" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "manual");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await finish("a1");

    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS - 1);
    expect(started).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["a1", "a2"]);
  });

  it("starts newly queued work on a ready portal while another waits out its spacing", async () => {
    const { queue, started, finish } = harness({ a1: "accela", a2: "accela", h1: "tyler" });
    queue.enqueue("a1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    await finish("a1");
    queue.enqueue("a2", "manual");
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1", "h1"]);
  });
});

describe("cancelling", () => {
  it("drops a waiting check at once and defers it past the next scheduler pass", async () => {
    const { queue, started, deferred, finish } = harness({ a1: "accela", a2: "accela" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    await finish("a1");

    queue.cancel("a2");
    expect(queue.checkingIds()).toEqual(new Set());
    expect(deferred).toEqual(["a2"]);
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS * 2);
    expect(started).toEqual(["a1"]);
  });

  it("defers a check cancelled before it recorded a run", async () => {
    const deferred: string[] = [];

    const queue = new CheckQueue({
      scopeOf: () => "accela",
      scheduledEligible: () => true,
      readKey: async () => "key",
      start: (): StartedCheck => {
        let settle: (outcome: RunOutcome | null) => void = () => undefined;
        const finished = new Promise<RunOutcome | null>((resolve) => { settle = resolve; });

        // Main answers null when the check stopped before its run was saved, such as while the browser is verified.
        return { finished, cancel: () => settle(null) };
      },
      defer: (permitId) => deferred.push(permitId),
      keyUnavailable: () => undefined,
      saveFailed: () => undefined,
      changed: () => undefined,
    });

    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    queue.cancel("a1");
    await vi.advanceTimersByTimeAsync(0);
    expect(deferred).toEqual(["a1"]);
    expect(queue.busy).toBe(false);
  });

  it("cancels a running check through its own handle", async () => {
    const { queue, started } = harness({ a1: "accela" });
    queue.enqueue("a1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    queue.cancel("a1");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1"]);
    expect(queue.busy).toBe(false);
  });
});

describe("scheduled eligibility", () => {
  it("rechecks scheduled work when it is about to start, and keeps manual requests", async () => {
    const { queue, started, state, finish } = harness({ a1: "accela", a2: "accela", a3: "accela" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "scheduled");
    queue.enqueue("a3", "manual");
    await vi.advanceTimersByTimeAsync(0);
    // The check window closes while the backlog waits.
    state.eligible = false;
    await finish("a1");
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS);
    expect(started).toEqual(["a1", "a3"]);
  });

  it("upgrades a queued scheduled check when someone asks for it", async () => {
    const { queue, started, state, finish } = harness({ a1: "accela", a2: "accela" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "scheduled");
    queue.enqueue("a2", "manual");
    await vi.advanceTimersByTimeAsync(0);
    state.eligible = false;
    await finish("a1");
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS);
    expect(started).toEqual(["a1", "a2"]);
  });

  it("drops scheduled work that stops qualifying while its key is read", async () => {
    const { queue, started, deferred, state } = harness({ a1: "accela" });
    const keyRead = gate();
    state.keyRead = keyRead.promise;
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.busy).toBe(true);

    // Switching to manual mode prunes the queue, but this entry is already starting.
    state.eligible = false;
    queue.prune();
    keyRead.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([]);
    expect(deferred).toEqual([]);
    expect(queue.busy).toBe(false);
  });

  it("still starts a manual request after scheduling turns off during its key read", async () => {
    const { queue, started, state } = harness({ a1: "accela" });
    const keyRead = gate();
    state.keyRead = keyRead.promise;
    queue.enqueue("a1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    state.eligible = false;
    queue.prune();
    keyRead.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1"]);
  });

  it("tells the starter scheduled work stopped qualifying while the browser was verified, but keeps manual requests", async () => {
    const browser = gate();
    const launched: string[] = [];
    const deferred: string[] = [];
    let eligible = true;

    const queue = new CheckQueue({
      scopeOf: (permitId) => permitId,
      scheduledEligible: () => eligible,
      readKey: async () => "key",
      // Like main: wait for the browser payload, then ask the queue before launching anything.
      start: (permitId, _key, stillWanted): StartedCheck => ({
        finished: browser.promise.then(() => {
          if (!stillWanted()) return null;
          launched.push(permitId);

          return "success";
        }),
        cancel: () => undefined,
      }),
      defer: (permitId) => deferred.push(permitId),
      keyUnavailable: () => undefined,
      saveFailed: () => undefined,
      changed: () => undefined,
    });

    queue.enqueue("scheduled", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    eligible = false;
    queue.prune();
    browser.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual([]);
    expect(deferred).toEqual([]);
    expect(queue.busy).toBe(false);

    queue.enqueue("manual", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual(["manual"]);
  });

  it("prunes queued scheduled work after a setting change", async () => {
    const { queue, state } = harness({ a1: "accela", a2: "accela" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    state.eligible = false;
    queue.prune();
    expect(queue.checkingIds()).toEqual(new Set(["a1"]));
  });
});

describe("keys", () => {
  it("drops work without recording failures while no key is saved, tells someone who asks, and resumes once one reads", async () => {
    const { queue, started, keyNotices, state } = harness({ a1: "accela", h1: "tyler", s1: "click2gov" });
    state.key = null;

    for (const id of ["a1", "h1", "s1"]) queue.enqueue(id, "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([]);
    expect(keyNotices).toEqual([["missing", false]]);
    expect(queue.checkingIds()).toEqual(new Set());

    // The next scheduler pass stays quiet; a check someone asked for says why it didn't run.
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(keyNotices).toEqual([["missing", false], ["missing", true]]);

    state.key = "key";
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1"]);
  });

  it("tells an unreadable key apart from a missing one", async () => {
    const { queue, started, keyNotices, state } = harness({ a1: "accela" });
    state.key = "unreadable";
    queue.enqueue("a1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([]);
    expect(keyNotices).toEqual([["unreadable", true]]);
  });

  it("pauses scheduled work after the service rejects the key, but still runs a manual request", async () => {
    const { queue, started, keyNotices, finish } = harness({ a1: "accela", h1: "tyler" });
    queue.enqueue("a1", "scheduled");
    queue.enqueue("h1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    await finish("a1", "authentication_error");
    expect(started).toEqual(["a1"]);
    expect(keyNotices).toEqual([["rejected", false]]);
    expect(queue.keyPaused).toBe(true);

    queue.enqueue("h1", "scheduled");
    expect(queue.checkingIds()).toEqual(new Set());

    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1", "h1"]);
  });
});

describe("shutdown", () => {
  it("cancels running work, clears waiting work, and can restart", async () => {
    const { queue, started, finish } = harness({ a1: "accela", a2: "accela", h1: "tyler" });
    queue.enqueue("a1", "manual");
    queue.enqueue("a2", "manual");
    await vi.advanceTimersByTimeAsync(0);
    await queue.stop();
    expect(queue.busy).toBe(false);
    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS);
    expect(started).toEqual(["a1"]);

    queue.restart();
    queue.enqueue("h1", "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a1", "h1"]);
    await finish("h1");
  });
});
