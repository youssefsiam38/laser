/**
 * What this window can read about its own memory (RP-8, D-265).
 *
 * Two numbers, and only these two:
 *
 * - **private resident** — the pages this window's process holds that nobody
 *   else does. Only the app shell can offer it (Electron's
 *   `process.getProcessMemoryInfo().private`, proven available in the packaged
 *   sandboxed renderer), so it arrives through the desktop bridge when there is
 *   one and is honestly `unavailable` when there is not. It is *not* PSS, and
 *   the surfaces that show it say so.
 * - **JS heap** — `performance.memory` where the engine has it (Chromium), and
 *   nothing at all where it does not.
 *
 * Never throws, never substitutes: a counter that could not be read is a
 * measure with a reason, never a zero, and heap is never presented as a
 * physical figure. Everything is injectable, so tests read no globals.
 */
import { type MemoryPressureMeasure } from "@lasercode/protocol";

import { type RendererPressureSample } from "./thresholds.js";

const unavailable = (reason: "unsupported_platform" | "collector_failed"): MemoryPressureMeasure => ({ status: "unavailable", reason });

const availableBytes = (value: unknown): MemoryPressureMeasure | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? { status: "available", value } : undefined;

/** Electron reports kilobytes; the contract carries bytes. */
const bytesFromKb = (value: unknown): MemoryPressureMeasure | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  const bytes = value * 1024;
  return Number.isSafeInteger(bytes) ? { status: "available", value: bytes } : undefined;
};

/**
 * The shell's memory bridge, if this build has one.
 *
 * Shaped as a capability the page discovers rather than a dependency it takes:
 * the same pattern the theme sink, the device-cache vault and the source-file
 * opener already use. A browser, a PWA and a phone simply do not have it.
 */
export interface DesktopMemoryBridge {
  /** `process.getProcessMemoryInfo()`, in kilobytes, from the window's own process. */
  process?: () => Promise<{ private?: number } | undefined> | { private?: number } | undefined;
}

const desktopMemory = (): DesktopMemoryBridge | undefined =>
  (globalThis as typeof globalThis & { desktop?: { memory?: DesktopMemoryBridge } }).desktop?.memory;

interface JsHeapReading {
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

const jsHeapOf = (): JsHeapReading | undefined => {
  const memory = (globalThis as typeof globalThis & { performance?: { memory?: JsHeapReading } }).performance?.memory;
  return memory && typeof memory === "object" ? memory : undefined;
};

export interface RendererSamplerIo {
  now?: () => number;
  /** Private resident of this window's process, in kilobytes. */
  processMemory?: DesktopMemoryBridge["process"];
  /** This window's JS heap, in bytes. */
  jsHeap?: () => JsHeapReading | undefined;
}

/**
 * Read this window once.
 *
 * A missing bridge is `unsupported_platform` — this environment has no such
 * counter — while a bridge that failed or answered with something unreadable
 * is `collector_failed`. The difference is the difference between "there is
 * nothing to read here" and "we tried and could not".
 */
export function createRendererPressureSampler(io: RendererSamplerIo = {}): () => Promise<RendererPressureSample> {
  const now = io.now ?? Date.now;
  return async () => {
    const atMs = now();
    let physical: MemoryPressureMeasure = unavailable("unsupported_platform");
    const readProcess = io.processMemory ?? desktopMemory()?.process;
    if (readProcess) {
      try {
        const info = await readProcess();
        physical = bytesFromKb(info?.private) ?? unavailable("collector_failed");
      } catch {
        physical = unavailable("collector_failed");
      }
    }
    let heapUsed: MemoryPressureMeasure = unavailable("unsupported_platform");
    let heapLimit: MemoryPressureMeasure = unavailable("unsupported_platform");
    try {
      const heap = (io.jsHeap ?? jsHeapOf)();
      if (heap) {
        heapUsed = availableBytes(heap.usedJSHeapSize) ?? unavailable("collector_failed");
        heapLimit = availableBytes(heap.jsHeapSizeLimit) ?? unavailable("collector_failed");
      }
    } catch {
      heapUsed = unavailable("collector_failed");
      heapLimit = unavailable("collector_failed");
    }
    return { atMs: Number.isSafeInteger(atMs) ? atMs : 0, physical, heapUsed, heapLimit };
  };
}
