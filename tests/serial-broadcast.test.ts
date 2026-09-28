import { describe, expect, it } from "vitest";
import { serialBroadcast } from "../src/main/serial-broadcast.js";

/** Lets every pending turn, including setImmediate callbacks, run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** A send that records which state it read and waits until the test finishes it. */
function controlledSend(state: { version: number }) {
  const read: number[] = [];
  const sent: number[] = [];
  const finishers: Array<() => void> = [];

  const send = () => {
    const version = state.version;
    read.push(version);

    return new Promise<void>((resolve) => {
      finishers.push(() => {
        sent.push(version);
        resolve();
      });
    });
  };

  return { send, read, sent, finish: (index: number) => finishers[index]?.() };
}

describe("serial broadcast", () => {
  it("shares one send among calls in the same turn", async () => {
    const state = { version: 1 };
    const target = controlledSend(state);
    const broadcast = serialBroadcast(target.send);

    const first = broadcast();
    const second = broadcast();
    await settle();
    target.finish(0);
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(target.read).toEqual([1]);
  });

  it("starts a later send only after a slow earlier one finishes, and reads the newest state then", async () => {
    const state = { version: 1 };
    const target = controlledSend(state);
    const broadcast = serialBroadcast(target.send);

    const first = broadcast();
    await settle();
    state.version = 2;
    const second = broadcast();
    state.version = 3;
    const third = broadcast();
    await settle();

    // The first send is still under way, so nothing else has read state yet.
    expect(target.read).toEqual([1]);

    target.finish(0);
    await first;
    await settle();
    target.finish(1);
    await Promise.all([second, third]);

    expect(second).toBe(third);
    expect(target.read).toEqual([1, 3]);
    expect(target.sent).toEqual([1, 3]);
  });

  it("goes on sending after a send fails, and tells only that send's callers", async () => {
    let calls = 0;

    const broadcast = serialBroadcast(async () => {
      calls += 1;

      if (calls === 1) throw new Error("window gone");
    });

    await expect(broadcast()).rejects.toThrow("window gone");
    await expect(broadcast()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
