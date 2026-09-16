/**
 * What a window can honestly read about itself (RP-8 milestone F, D-265).
 *
 * The rule under test is the one that matters: a counter nobody could read is
 * a measure with a reason, never a zero, and nothing is ever reported under
 * another number's name — heap is heap, private resident is private resident,
 * and neither is PSS.
 */
import { describe, expect, it } from "vitest";

import { createRendererPressureSampler } from "../../../src/runtime/pressure/sampler.js";

const MiB = 1024 * 1024;

describe("the renderer's own measurement", () => {
  it("reads private resident from the shell's bridge, in bytes", async () => {
    const sample = await createRendererPressureSampler({
      now: () => 1_000,
      processMemory: () => ({ private: 512 * 1024 }),
      jsHeap: () => ({ usedJSHeapSize: 40 * MiB, jsHeapSizeLimit: 2048 * MiB }),
    })();
    expect(sample).toEqual({
      atMs: 1_000,
      physical: { status: "available", value: 512 * MiB },
      heapUsed: { status: "available", value: 40 * MiB },
      heapLimit: { status: "available", value: 2048 * MiB },
    });
  });

  it("awaits a bridge that answers asynchronously", async () => {
    const sample = await createRendererPressureSampler({
      processMemory: async () => ({ private: 4 * 1024 }),
      jsHeap: () => undefined,
    })();
    expect(sample.physical).toEqual({ status: "available", value: 4 * MiB });
  });

  it("says the platform has no such counter when there is no bridge", async () => {
    const sample = await createRendererPressureSampler({ jsHeap: () => ({ usedJSHeapSize: 1, jsHeapSizeLimit: 2 }) })();
    expect(sample.physical).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.heapUsed).toEqual({ status: "available", value: 1 });
  });

  it("says the collector failed when the bridge throws or answers with nonsense", async () => {
    const threw = await createRendererPressureSampler({ processMemory: () => { throw new Error("gone"); } })();
    expect(threw.physical).toEqual({ status: "unavailable", reason: "collector_failed" });
    for (const value of [undefined, -1, 1.5, Number.NaN, "512" as unknown as number]) {
      const sample = await createRendererPressureSampler({ processMemory: () => ({ private: value as number }) })();
      expect(sample.physical).toEqual({ status: "unavailable", reason: "collector_failed" });
    }
  });

  it("never reports a heap this engine does not expose, and never as physical", async () => {
    const sample = await createRendererPressureSampler({ processMemory: () => ({ private: 8 * 1024 }), jsHeap: () => undefined })();
    expect(sample.heapUsed).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.heapLimit).toEqual({ status: "unavailable", reason: "unsupported_platform" });
    expect(sample.physical).toEqual({ status: "available", value: 8 * MiB });
  });

  it("refuses an unreadable heap rather than calling it zero", async () => {
    const sample = await createRendererPressureSampler({
      jsHeap: () => ({ usedJSHeapSize: Number.NaN, jsHeapSizeLimit: -1 }),
    })();
    expect(sample.heapUsed).toEqual({ status: "unavailable", reason: "collector_failed" });
    expect(sample.heapLimit).toEqual({ status: "unavailable", reason: "collector_failed" });
  });
});
