// @vitest-environment happy-dom
/**
 * M16-T60 (D-275): a large output folds into its own tool block, opens as
 * output — decoded text, never the record's JSON — and is read continuously a
 * few segments at a time, holding no more than the one in view and its
 * neighbours.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sliceUtf8RangeFrom, utf8ByteLength } from "@lasercode/protocol";

import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { OUTPUT_HELD_MAX, OUTPUT_SEGMENT_BYTES, OutputPager } from "../../src/components/thread/output-pager.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce } from "../../src/store.js";
import type { BodyRef } from "../../src/runtime/body-excerpt.js";
import { sessionState } from "../agents/fixtures.js";

const PATH = "/p/session.jsonl";

async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** An authority over one body that refuses offsets inside a character, as the real one does. */
function authority(body: string) {
  const total = utf8ByteLength(body);
  const whole = digestOf(body);
  return vi.fn(async (params: Record<string, unknown>) => {
    const slice = sliceUtf8RangeFrom(body, params.offset as number, (params.limit as number | undefined) ?? 65536);
    if (!slice) throw Object.assign(new Error("not a boundary"), { code: -32602 });
    const end = slice.offset + slice.bytes;
    return {
      authority: "durable", revision: params.revision, entryId: params.entryId, component: params.component, totalBytes: total,
      offset: slice.offset, bytes: slice.bytes, ...(end < total ? { next: end } : {}), truncated: end < total,
      sliceDigest: await digestOf(slice.text), contentDigest: await whole, text: slice.text,
    };
  });
}

const outputRef = (body: string): BodyRef & { entryId: string } => ({
  entryId: "e1",
  // Lane A's component: the tool result's decoded text.
  component: { kind: "tool_output" } as unknown as BodyRef["component"],
  totalBytes: utf8ByteLength(body),
  revision: "r1.env.1",
  excerpt: { offset: 0, bytes: 16_384 },
});

/** Wait until the pager has nothing in flight. */
async function settle(pager: OutputPager): Promise<void> {
  for (let step = 0; step < 200; step++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (pager.getSnapshot().loading.size > 0) continue;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (pager.getSnapshot().loading.size === 0) return;
  }
}

describe("reading a large output a few segments at a time", () => {
  const unit = "line 設 😀 of output\n";
  const body = unit.repeat(Math.ceil(700_000 / utf8ByteLength(unit)));

  it("meets neighbouring segments exactly, across multi-byte characters", async () => {
    const request = authority(body);
    const pager = new OutputPager(request as never, PATH, outputRef(body), "env");
    let rebuilt = "";
    for (let index = 0; index < pager.segmentCount; index++) {
      pager.show(index);
      await settle(pager);
      const segment = pager.getSnapshot().segments.get(index)!;
      expect(segment, `segment ${index}`).toBeDefined();
      if (index > 0) expect(segment.start).toBeGreaterThanOrEqual(index * OUTPUT_SEGMENT_BYTES);
      rebuilt += segment.text;
    }
    expect(rebuilt === body).toBe(true);
  });

  it("holds the segment in view and its neighbours, evicts the rest, and reads again on return", async () => {
    const request = authority(body);
    const pager = new OutputPager(request as never, PATH, outputRef(body), "env");
    for (const visible of [0, 1, 5, 9, 4, 0]) {
      pager.show(visible);
      await settle(pager);
      const held = [...pager.getSnapshot().segments.keys()];
      expect(held.length).toBeLessThanOrEqual(OUTPUT_HELD_MAX);
      expect(held.every(index => Math.abs(index - visible) <= 1)).toBe(true);
      expect(held).toContain(visible);
      expect(pager.heldBytes).toBeLessThanOrEqual(OUTPUT_HELD_MAX * (OUTPUT_SEGMENT_BYTES + 4));
    }
    // Segment 0 was evicted on the way and read again on return.
    const readsOfZero = request.mock.calls.filter(([params]) => (params as { offset: number }).offset === 0).length;
    expect(readsOfZero).toBe(2);
  });

  it("drops everything on close, and a read that lands afterwards paints nothing", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const real = authority(body);
    const slow = vi.fn(async (params: Record<string, unknown>) => { await gate; return real(params); });
    const pager = new OutputPager(slow as never, PATH, outputRef(body), "env");
    pager.show(3);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pager.clear().count).toBe(0);
    release!();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pager.getSnapshot().segments.size).toBe(0);
  });

  it("releases the neighbours under memory pressure and keeps the segment in view", async () => {
    const pager = new OutputPager(authority(body) as never, PATH, outputRef(body), "env");
    pager.show(4);
    await settle(pager);
    expect(pager.getSnapshot().segments.size).toBe(3);
    const released = pager.releaseNeighbours();
    expect(released.count).toBe(2);
    expect([...pager.getSnapshot().segments.keys()]).toEqual([4]);
  });

  it("finds the next match after a place, and wraps to none past the last", async () => {
    const needle = `${"a".repeat(200_000)}needle${"b".repeat(100_000)}needle${"c".repeat(10)}`;
    const pager = new OutputPager(authority(needle) as never, PATH, outputRef(needle), "env");
    const first = await pager.find("NEEDLE", 0);
    expect(first).toBe(200_000);
    const second = await pager.find("needle", first! + 1);
    expect(second).toBe(300_006);
    expect(await pager.find("needle", second! + 1)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The fold inside the tool block, and the viewer it opens
// ---------------------------------------------------------------------------

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ client, actions: { send: vi.fn(), openSession: vi.fn() } }),
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));
vi.mock("@/agents/hooks", () => ({ useNamerLabel: () => undefined, useSessionMcpServers: () => [] }));
vi.mock("@assistant-ui/react", async (original) => ({ ...(await original<typeof import("@assistant-ui/react")>()), useToolCallElapsed: () => undefined }));

describe("a large output in its tool block", () => {
  // Real output: lines, and colour a terminal would show as colour.
  const output = Array.from({ length: 9000 }, (_, i) => `\u001b[32mok\u001b[0m test ${i} passed`).join("\n");
  let container: HTMLDivElement;
  let root: Root;
  let store: StateStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const served = authority(output);
    client.request.mockReset();
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "session/revision") return { revision: "r1.env.1" };
      if (method === "session/entry_range") return served(params);
      return {};
    });
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: PATH }) });
    state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: PATH } } });
    store = createStateStore(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const mount = (node: ReactNode) => act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider>{node}</TooltipProvider></LaserStoreProvider>));
  const excerpt = output.slice(0, 16_000);
  const call = (ref: BodyRef, running = false) => ({
    toolCallId: "bash-1", toolName: "bash", args: { command: "pnpm test --filter ui" }, argsText: '{"command":"pnpm test --filter ui"}',
    status: running ? { type: "running" as const } : { type: "complete" as const, reason: "stop" as const },
    ...(running ? {} : { result: excerpt }),
    artifact: { bodies: running ? { partial: ref } : { result: ref } },
    addResult: vi.fn(), resume: vi.fn(), respondToApproval: vi.fn(async () => {}),
  });
  const openRow = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.click());
  };
  const dialog = () => document.querySelector<HTMLElement>('[data-slot="output-viewer"]');
  const flush = async () => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

  it("ends the terminal block with the fold, not a box between rows, and opens the output with a pointer", async () => {
    await mount(<ToolRow {...call(outputRef(output))} type="tool-call" />);
    await openRow();
    const fold = container.querySelector<HTMLElement>('[data-slot="body-overflow"]')!;
    expect(fold).not.toBeNull();
    expect(fold.closest('[data-slot="terminal-block"]')).not.toBeNull();
    expect(fold.closest('[data-slot="tool-fallback-content"]')).not.toBeNull();
    const action = fold.querySelector<HTMLButtonElement>('[data-slot="body-overflow-open"]')!;
    expect(action.textContent).toMatch(/^Show full output · \d+ KB$/);
    expect(fold.textContent).not.toMatch(/not kept|window/);

    await act(async () => action.click());
    await flush();
    const viewer = dialog()!;
    expect(viewer).not.toBeNull();
    expect(viewer.querySelector('[data-slot="output-viewer-tool"]')?.textContent).toBe("bash");
    expect(viewer.querySelector('[data-slot="output-viewer-command"]')?.textContent).toContain("pnpm test --filter ui");
    const scroller = viewer.querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]')!;
    // Decoded output with real lines and colour, never the stored record.
    const text = scroller.querySelector("[data-run]")?.textContent ?? "";
    expect(text).toContain("ok test 0 passed\nok test 1 passed");
    expect(text).not.toContain("\u001b[");
    expect(text).not.toMatch(/"content"|"type":\s*"text"/);
    expect(scroller.querySelector("[data-run] span[style]")).not.toBeNull();
    // Wrap is on, and says so.
    expect(scroller.dataset.wrap).toBe("true");
    const wrap = [...viewer.querySelectorAll("button")].find(button => button.textContent?.includes("Wrap lines"))!;
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    await act(async () => wrap.click());
    expect(scroller.dataset.wrap).toBe("false");
    // Never more than the segment in view and its neighbours.
    expect(scroller.querySelectorAll("[data-segment]").length).toBeLessThanOrEqual(OUTPUT_HELD_MAX);

    // Esc closes, drops what was read, and gives focus back to the action.
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.querySelector("[data-segment]")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-slot="body-overflow-open"]'));
  });

  it("shows the first lines of an output the page left out, only while the row is open", async () => {
    // A page that elided the record: a reference, and no held text at all.
    const { result: _held, ...elided } = call({ ...outputRef(output), excerpt: { offset: 0, bytes: 0 } });
    await mount(<ToolRow {...elided} type="tool-call" />);
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    if (trigger.getAttribute("aria-expanded") === "true") await act(async () => trigger.click());
    await flush();
    const ranges = () => client.request.mock.calls.filter(([method]) => method === "session/entry_range").length;
    expect(ranges()).toBe(0);
    await openRow();
    await flush();
    const block = container.querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
    expect(block.textContent).toContain("test 0 passed");
    expect(block.textContent).not.toContain("test 8999 passed");
    expect(block.querySelector('[data-slot="body-overflow-open"]')).not.toBeNull();
    expect(ranges()).toBe(1);
  });

  it("opens from the keyboard and jumps to the end with End", async () => {
    await mount(<ToolRow {...call(outputRef(output))} type="tool-call" />);
    await openRow();
    const action = container.querySelector<HTMLButtonElement>('[data-slot="body-overflow-open"]')!;
    action.focus();
    expect(document.activeElement).toBe(action);
    // A native button: Enter and Space activate it.
    expect(action.tagName).toBe("BUTTON");
    await act(async () => {
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      action.dispatchEvent(enter);
      if (!enter.defaultPrevented && !dialog()) action.click();
    });
    await flush();
    const scroller = dialog()!.querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]')!;
    expect(document.activeElement).toBe(scroller);
    const before = client.request.mock.calls.filter(([method]) => method === "session/entry_range").map(([, params]) => (params as { offset: number }).offset);
    expect(before).toContain(0);
    await act(async () => { scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
    await flush();
    const offsets = client.request.mock.calls.filter(([method]) => method === "session/entry_range").map(([, params]) => (params as { offset: number }).offset);
    const lastSegment = Math.ceil(utf8ByteLength(output) / OUTPUT_SEGMENT_BYTES) - 1;
    expect(offsets.some(offset => offset >= lastSegment * OUTPUT_SEGMENT_BYTES)).toBe(true);
    const held = [...scroller.querySelectorAll<HTMLElement>("[data-segment]")].map(node => Number(node.dataset.segment));
    expect(held.length).toBeLessThanOrEqual(OUTPUT_HELD_MAX);
    expect(held).toContain(lastSegment);
    expect(held).not.toContain(0);
  });

  it("says when output still being written can be read, with no action", async () => {
    const live: BodyRef = { component: { kind: "tool_partial" }, totalBytes: 200_000, excerpt: { offset: 168_000, bytes: 32_000 }, live: true };
    await mount(<ToolRow {...call(live, true)} type="tool-call" />);
    await openRow();
    const fold = container.querySelector<HTMLElement>('[data-slot="body-overflow"]')!;
    expect(fold.closest('[data-slot="terminal-block"]')).not.toBeNull();
    expect(fold.textContent).toBe("Full output available when the command finishes");
    expect(fold.querySelector("button")).toBeNull();
  });
});
