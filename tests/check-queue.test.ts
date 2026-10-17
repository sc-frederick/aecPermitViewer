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

function gate(): Gate {
  let open: () => void = () => undefined;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

/** A queue wired to in-memory answers; each started check waits until the test finishes it. */
function harness(scopes: Record<string, string>) {
  const started: string[] = [];
  const startedKeys: string[] = [];
  const running = new Map<string, (outcome: RunOutcome) => void>();
  const deferred: string[] = [];
  const keyNotices: Array<[KeyProblem, boolean]> = [];
  const state: HarnessState = { key: "key", keyRead: Promise.resolve(), eligible: true };

  const queue = new CheckQueue({
    scopeOf: (permitId) => scopes[permitId] ?? null,
    scheduledEligible: () => state.eligible,
    readKey: async () => {
      const key = state.key;
      await state.keyRead;

      if (key === "unreadable") throw new Error("decryption failed");

      return key;
    },
    start: (permitId, key): StartedCheck => {
      started.push(permitId);
      startedKeys.push(`${permitId}:${key}`);
      let finish: (outcome: RunOutcome) => void = () => undefined;

      const finished = new Promise<RunOutcome>((resolve) => {
        finish = resolve;
      });

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

  return { queue, started, startedKeys, deferred, keyNotices, state, finish };
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

        const finished = new Promise<RunOutcome | null>((resolve) => {
          settle = resolve;
        });

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

  it("lets the starter drop scheduled work that stops qualifying during browser verification", async () => {
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
  it("restarts a requested check with the new key after replacement during the starter's prerequisite", async () => {
    const browser = gate();
    const entered: string[] = [];
    const recorded: string[] = [];
    let key = "old";

    const queue = new CheckQueue({
      scopeOf: () => "accela",
      scheduledEligible: () => true,
      readKey: async () => key,
      start: (id, credential, stillWanted) => {
        entered.push(`${id}:${credential}`);

        return {
          finished: browser.promise.then(() => {
            if (!stillWanted()) return null;
            recorded.push(`${id}:${credential}`);

            return "success" as const;
          }),
          cancel: () => undefined,
        };
      },
      defer: () => undefined,
      keyUnavailable: () => undefined,
      saveFailed: () => undefined,
      changed: () => undefined,
    });

    queue.enqueue("a", "manual");
    await vi.advanceTimersByTimeAsync(0);
    key = "new";
    queue.resume();
    queue.enqueue("a", "manual");
    browser.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toEqual(["a:old", "a:new"]);
    expect(recorded).toEqual(["a:new"]);
    expect(queue.checkingIds()).toEqual(new Set());
    await queue.stop();
  });

  it("ignores an old-key rejection and retains pending new-key work with portal spacing", async () => {
    const { queue, startedKeys, keyNotices, state, finish } = harness({ a1: "accela", a2: "accela" });
    state.key = "old";
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    state.key = "new";
    queue.resume();
    queue.enqueue("a2", "scheduled");
    await finish("a1", "authentication_error");
    expect(queue.keyPaused).toBe(false);
    expect(keyNotices).toEqual([]);
    expect(queue.checkingIds()).toEqual(new Set(["a2"]));
    await vi.advanceTimersByTimeAsync(SCOPE_SPACING_MS - 1);
    expect(startedKeys).toEqual(["a1:old"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedKeys).toEqual(["a1:old", "a2:new"]);
    await finish("a2", "authentication_error");
    expect(queue.keyPaused).toBe(true);
    expect(keyNotices).toEqual([["rejected", false]]);
    queue.enqueue("a2", "scheduled");
    expect(queue.checkingIds()).toEqual(new Set());
  });

  it("rereads a key replaced during a delayed read instead of starting the stale key", async () => {
    const { queue, startedKeys, state, finish } = harness({ a1: "accela" });
    const wait = gate();
    state.key = "old";
    state.keyRead = wait.promise;
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    state.key = "new";
    queue.resume();
    wait.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(startedKeys).toEqual(["a1:new"]);
    await finish("a1");
  });

  it("does not pause on an obsolete missing-key answer after replacement", async () => {
    const { queue, startedKeys, keyNotices, state, finish } = harness({ a1: "accela" });
    const wait = gate();
    state.key = null;
    state.keyRead = wait.promise;
    queue.enqueue("a1", "scheduled");
    await vi.advanceTimersByTimeAsync(0);
    state.key = "new";
    queue.resume();
    wait.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(startedKeys).toEqual(["a1:new"]);
    expect(keyNotices).toEqual([]);
    await finish("a1");
  });

  it("skips checks while no key is saved and resumes once a key reads", async () => {
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
    expect(keyNotices).toEqual([
      ["missing", false],
      ["missing", true],
    ]);

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
