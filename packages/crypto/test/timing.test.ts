/**
 * The keystroke shaper. Both halves are tested because shipping only the grid
 * (and not the chaff tail) still leaks where typing stopped.
 */
import { describe, expect, it } from "vitest";
import { KEYSTROKE_GRID_MS, KeystrokeShaper } from "../src/index.js";

/** A hand-cranked interval timer so the test has no real clock in it. */
function fakeTimer() {
  let handler: (() => void) | null = null;
  let period = 0;
  return {
    period: () => period,
    running: () => handler !== null,
    tick: async (times = 1) => {
      for (let i = 0; i < times; i++) {
        handler?.();
        // Let the shaper's async send chain settle before the next tick, the
        // way 20 ms of wall clock would.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    setTimer: (fn: () => void, ms: number) => {
      handler = fn;
      period = ms;
      return 1;
    },
    clearTimer: () => {
      handler = null;
    },
  };
}

function shaper(options: { random?: () => number; minChaffTicks?: number; maxChaffTicks?: number } = {}) {
  const timer = fakeTimer();
  const sent: string[] = [];
  const s = new KeystrokeShaper({
    sendFrame: (frame) => {
      sent.push(frame === null ? "." : String.fromCharCode(...frame));
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    random: options.random ?? (() => 0),
    ...(options.minChaffTicks !== undefined ? { minChaffTicks: options.minChaffTicks } : {}),
    ...(options.maxChaffTicks !== undefined ? { maxChaffTicks: options.maxChaffTicks } : {}),
  });
  return { s, timer, sent };
}

describe("KeystrokeShaper", () => {
  it("puts frames on a 20 ms grid, one per tick", async () => {
    const { s, timer, sent } = shaper({ minChaffTicks: 0, maxChaffTicks: 0 });
    s.enqueue(Uint8Array.from([97]));
    s.enqueue(Uint8Array.from([98]));
    s.enqueue(Uint8Array.from([99]));
    expect(timer.period()).toBe(KEYSTROKE_GRID_MS);
    expect(sent).toEqual([]); // nothing leaves before a tick

    await timer.tick();
    expect(sent).toEqual(["a"]);
    await timer.tick(2);
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("keeps sending chaff after the last real frame, then stops", async () => {
    const { s, timer, sent } = shaper({ minChaffTicks: 3, maxChaffTicks: 3 });
    s.enqueue(Uint8Array.from([97]));
    await timer.tick(1);
    expect(sent).toEqual(["a"]);

    await timer.tick(3);
    expect(sent).toEqual(["a", ".", ".", "."]);
    expect(timer.running()).toBe(true);

    // The tail is spent: the next tick shuts the grid down and sends nothing.
    await timer.tick(1);
    expect(sent).toEqual(["a", ".", ".", "."]);
    expect(timer.running()).toBe(false);
    expect(s.active).toBe(false);
  });

  it("restarts the tail on every new frame, so the burst end stays hidden", async () => {
    const { s, timer, sent } = shaper({ minChaffTicks: 2, maxChaffTicks: 2 });
    s.enqueue(Uint8Array.from([97]));
    await timer.tick(2); // "a", then one chaff
    s.enqueue(Uint8Array.from([98]));
    await timer.tick(1);
    expect(sent).toEqual(["a", ".", "b"]);
    await timer.tick(3);
    expect(sent).toEqual(["a", ".", "b", ".", "."]);
    expect(timer.running()).toBe(false);
  });

  it("draws the tail length from the configured range", () => {
    const lengths = new Set<number>();
    for (const r of [0, 0.5, 0.999]) {
      const { s, timer } = shaper({ random: () => r, minChaffTicks: 4, maxChaffTicks: 8 });
      s.enqueue(Uint8Array.from([97]));
      lengths.add(4 + Math.floor(r * 5));
      expect(timer.running()).toBe(true);
      s.stop();
    }
    expect([...lengths].sort()).toEqual([4, 6, 8]);
  });

  it("drops rather than growing without bound, and says so", () => {
    let error: unknown;
    const s = new KeystrokeShaper({
      sendFrame: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
      maxQueue: 2,
      onError: (e) => {
        error = e;
      },
    });
    s.enqueue(new Uint8Array(1));
    s.enqueue(new Uint8Array(1));
    s.enqueue(new Uint8Array(1));
    expect(s.pending).toBe(2);
    expect(s.dropped).toBe(1);
    expect(String(error)).toMatch(/queue is full/);
  });
});
