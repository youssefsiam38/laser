// @vitest-environment happy-dom
/**
 * Settings → This device → Conversations on this device (RP-10, M18-T10).
 *
 * The states this screen exists for: what is kept and under whose limits, what
 * storage actually is on this device, why nothing is kept when nothing is, and
 * a clear that reports what happened instead of assuming it worked.
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DeviceCacheCounters } from "../../src/runtime/tail-cache/counters.js";
import type { TailBounds } from "../../src/runtime/tail-cache/bounds.js";

const listeners = new Set<() => void>();
let counters: DeviceCacheCounters;
const clear = vi.fn(async () => true);

vi.mock("../../src/runtime/tail-cache", () => ({
  tailCache: {
    counters: () => counters,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear: (...args: unknown[]) => clear(...(args as [])),
  },
}));

const { DeviceCacheSetting } = await import("../../src/components/settings/DeviceCacheSetting.js");
const { click, findButton, render, text } = await import("./mcp/harness.js");

const bounds: TailBounds = {
  sessions: 24,
  bytes: 8 * 1024 * 1024,
  bytesPerSession: 256 * 1024,
  entriesPerSession: 40,
  ageMs: 336 * 60 * 60 * 1000,
  attachments: "reference",
  inlineAttachmentBytes: 4096,
};

function state(partial: Partial<DeviceCacheCounters> = {}): DeviceCacheCounters {
  return {
    status: "open",
    records: 3,
    bytes: 120_000,
    hotRecords: 3,
    hotBytes: 120_000,
    evictions: 0,
    writesRefused: 0,
    discarded: { schema: 0, version: 0, invalid: 0, corrupt: 0, undecryptable: 0, oversize: 0, expired: 0, foreign: 0 },
    encryption: { kind: "not-applicable" },
    durable: true,
    bounds,
    ...partial,
  };
}

let root: Root | undefined;
beforeEach(() => {
  counters = state();
  clear.mockClear();
  clear.mockImplementation(async () => true);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  listeners.clear();
  document.body.innerHTML = "";
});

it("says what is kept, under whose limits, and that the browser is not encrypting it", async () => {
  root = (await render(<DeviceCacheSetting />)).root;
  expect(text()).toContain("Conversations on this device");
  expect(text()).toContain("3 of 24");
  expect(text()).toContain("kept by this browser, unencrypted");
  expect(text()).toContain("40 messages");
  expect(text()).toContain("336 hours");
});

it("names the operating system's own store when a key is really held there", async () => {
  counters = state({ encryption: { kind: "os-backed", store: "the system keyring" } });
  root = (await render(<DeviceCacheSetting />)).root;
  expect(text()).toContain("encrypted with a key the system keyring keeps");
});

it("says plainly when this computer has no keyring, rather than implying encryption", async () => {
  counters = state({ encryption: { kind: "unavailable", reason: "This system has no keychain this app can use." } });
  root = (await render(<DeviceCacheSetting />)).root;
  expect(text()).toContain("not encrypted");
  expect(text()).toContain("no keyring");
});

it("explains every refusal with something a person can do", async () => {
  for (const [refusal, expected] of [
    ["policy", "does not allow conversation content"],
    ["encryption", "requires conversations to be stored encrypted"],
    ["storage", "will not store anything"],
    ["purge", "could not verify"],
  ] as const) {
    counters = state({ status: "refused", refusal, records: 0, bytes: 0, bounds: undefined });
    const mounted = (await render(<DeviceCacheSetting />)).root;
    expect(text(), refusal).toContain(expected);
    await act(async () => mounted.unmount());
    document.body.innerHTML = "";
  }
});

it("offers the clear only when there is something to clear, or something stuck", async () => {
  counters = state({ records: 0, bytes: 0 });
  root = (await render(<DeviceCacheSetting />)).root;
  expect(findButton("Clear cached conversations")?.disabled).toBe(true);
  await act(async () => root!.unmount());
  document.body.innerHTML = "";

  counters = state({ status: "refused", refusal: "purge", records: 0, bounds: undefined });
  root = (await render(<DeviceCacheSetting />)).root;
  expect(findButton("Clear cached conversations")?.disabled).toBe(false);
});

it("clears behind a confirmation, and keeps the person's drafts out of it", async () => {
  root = (await render(<DeviceCacheSetting />)).root;
  await click("Clear cached conversations");
  expect(text()).toContain("Clear cached conversations?");
  expect(text()).toContain("Anything you have typed and not sent is kept");
  const confirm = [...document.querySelectorAll("button")].filter((button) => button.textContent?.includes("Clear cached conversations")).at(-1);
  await act(async () => confirm!.click());
  expect(clear).toHaveBeenCalledWith("environment");
});

it("does not claim a clear that the browser would not finish", async () => {
  clear.mockImplementation(async () => false);
  root = (await render(<DeviceCacheSetting />)).root;
  await click("Clear cached conversations");
  const confirm = [...document.querySelectorAll("button")].filter((button) => button.textContent?.includes("Clear cached conversations")).at(-1);
  await act(async () => confirm!.click());
  expect(text()).toContain("still holding on to the data");
});
