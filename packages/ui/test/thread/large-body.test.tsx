// @vitest-environment happy-dom
/**
 * RP-5b acceptance A10: what a person sees when the window is holding an
 * excerpt, and what reading the rest costs.
 *
 * The row says exactly how much is not shown and offers to read it; the viewer
 * pages in bounded slices and never builds the whole body; a reply still being
 * written says so instead of offering something that cannot be read yet.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { initialState, reduce } from "../../src/store.js";
import { ThreadMessage } from "../../src/components/thread/messages.js";
import { BODY_VIEWER_AGGREGATE_MAX_BYTES, BodyWindow, IMAGE_BLOB_MAX, ImageBlobs } from "../../src/runtime/body-reader.js";
import { sessionState } from "../agents/fixtures.js";

const SESSION = "/project/session.jsonl";
const BODY = "answer ".repeat(600_000); // ~4 MB

const slices = vi.hoisted(() => ({ calls: [] as Array<{ offset: number; limit?: number }> }));
const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "session/entry_range") return {};
      const offset = params.offset as number;
      const limit = (params.limit as number | undefined) ?? 65536;
      slices.calls.push({ offset, limit });
      const text = "answer ".repeat(600_000).slice(offset, offset + limit);
      return {
        authority: "durable", revision: "r1.env.1", component: params.component, totalBytes: 4_200_000,
        offset, bytes: text.length, ...(offset + text.length < 4_200_000 ? { next: offset + text.length } : {}),
        truncated: offset + text.length < 4_200_000, sliceDigest: "s", contentDigest: "c", text,
      };
    }),
  },
  actions: { listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn() },
}));
vi.mock("@/runtime", async original => ({
  ...await original<typeof import("../../src/runtime/index.js")>(),
  useLaserStable: () => stable,
  useActivityDetailLevel: () => "everything",
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stable.client.request.mockClear();
  slices.calls.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function mount(entries: unknown[], leafId: string) {
  let state = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
  state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } as never });
  state = reduce(state, { type: "historyBegin", path: SESSION, token: "t" });
  state = reduce(state, { type: "historySnapshot", path: SESSION, token: "t", entries, leafId, window: {
    epoch: "w1", seq: 2, revision: "r1.env.1", environmentKey: "e1.key", userOffset: 0, complete: true,
    branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
  } } as never);
  const view = state.open[SESSION]!;
  const store = createStateStore(state);
  function Fixture() {
    const { messages } = projectMessages({ blocks: view.blocks, running: false, dialogs: [] });
    const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages></ThreadPrimitive.Root></FileOpenerProvider></AssistantRuntimeProvider>;
  }
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));
  return view;
}

describe("a reply the window is holding an excerpt of", () => {
  it("says exactly how much is not shown and offers to read it", async () => {
    await mount([
      { id: "e0", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { id: "e1", parentId: "e0", type: "message", message: { role: "assistant", content: [{ type: "text", text: BODY }] } },
    ], "e1");

    const notice = container.querySelector('[data-slot="body-overflow"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toMatch(/more of this reply is not kept in this window/);
    expect(notice!.textContent).toMatch(/MB/);
    const button = [...container.querySelectorAll("button")].find(node => node.textContent === "Read all of it");
    expect(button).toBeDefined();
    // The row it belongs to renders only its excerpt, not four megabytes.
    expect(container.textContent!.length).toBeLessThan(200_000);
  });

  it("says a reply still being written will be readable when it finishes", async () => {
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
    state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } } as never);
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 1, at: "", update: { kind: "message_start", role: "assistant" } } } as never);
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 2, at: "", update: { kind: "text_delta", delta: BODY } } } as never);
    const view = state.open[SESSION]!;
    const store = createStateStore(state);
    function Fixture() {
      const { messages } = projectMessages({ blocks: view.blocks, running: true, dialogs: [] });
      const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: true, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages></ThreadPrimitive.Root></FileOpenerProvider></AssistantRuntimeProvider>;
    }
    await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));

    const block = view.blocks.at(-1) as { bodies?: { text?: unknown } };
    expect(block.bodies?.text).toBeDefined();
    const notice = container.querySelector('[data-slot="body-overflow"]');
    expect(notice, container.innerHTML.slice(0, 400)).not.toBeNull();
    expect(notice!.textContent).toMatch(/It will be readable when the reply finishes/);
    expect([...container.querySelectorAll("button")].some(node => node.textContent === "Read all of it")).toBe(false);
  });
});

describe("the bounded window over one body", () => {
  const ref = { entryId: "e1", component: { kind: "assistant_text" as const }, totalBytes: 4_200_000, revision: "r1.env.1", excerpt: { offset: 0, bytes: 16_384 } };

  it("pages forward and evicts rather than growing", async () => {
    const window = new BodyWindow(params => stable.client.request("session/entry_range", params) as never, SESSION, ref, 128 * 1024, "env");
    for (let step = 0; step < 12; step++) await window.more();
    const state = window.getSnapshot();
    expect(state.heldBytes).toBeLessThanOrEqual(128 * 1024);
    expect(state.evicted).toBeGreaterThan(0);
    expect(state.slices.length).toBeLessThanOrEqual(2);
    // Reading never went backwards, and each request was one bounded slice.
    expect(slices.calls.every(call => (call.limit ?? 0) <= 64 * 1024)).toBe(true);
    expect(slices.calls[0]!.offset).toBe(16_384);
    // The first slice read starts where the excerpt ends: nothing is re-read.
    expect(new Set(slices.calls.map(call => call.offset)).size).toBe(slices.calls.length);
  });

  it("jumps to a named place and holds only what it shows", async () => {
    const window = new BodyWindow(params => stable.client.request("session/entry_range", params) as never, SESSION, ref, BODY_VIEWER_AGGREGATE_MAX_BYTES, "env");
    await window.jump(1_000_000);
    const state = window.getSnapshot();
    expect(state.slices).toHaveLength(1);
    expect(state.slices[0]!.offset).toBe(1_000_000);
    expect(state.heldBytes).toBeLessThanOrEqual(64 * 1024);
    window.clear();
    expect(window.getSnapshot().slices).toHaveLength(0);
  });
});

describe("a prompt whose image the window points at", () => {
  it("reads its bytes back and shows the picture", async () => {
    let counter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:image-${++counter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    const data = btoa("x".repeat(40_000));
    stable.client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "session/revision") return { revision: "r1.env.1", environmentKey: "e1.key", authority: "durable" };
      if (method !== "session/entry_range") return {};
      const offset = params.offset as number;
      const text = data.slice(offset, offset + 65_536);
      return { authority: "durable", revision: "r1.env.1", component: params.component, totalBytes: data.length, offset,
        bytes: text.length, ...(offset + text.length < data.length ? { next: offset + text.length } : {}), truncated: false,
        sliceDigest: "s", contentDigest: "c", text };
    });

    await mount([
      { id: "e0", parentId: null, type: "message", message: { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image", mimeType: "image/png", data },
      ] } },
    ], "e0");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    const image = container.querySelector('[data-slot="message-image"]') as HTMLImageElement | null;
    expect(image, container.innerHTML.slice(0, 300)).not.toBeNull();
    expect(image!.getAttribute("src")).toMatch(/^blob:image-/);
    // The bytes were read through the range contract, never held in the store.
    const calls = stable.client.request.mock.calls.filter(call => call[0] === "session/entry_range");
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0]![1] as { component: { kind: string } }).component.kind).toBe("image");
  });
});

describe("images the window points at", () => {
  it("rebuilds them outside the heap, bounded, and revokes what it drops", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    let counter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => { const url = `blob:${++counter}`; created.push(url); return url; });
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    const data = btoa("image-bytes");
    const request = vi.fn(async () => ({ authority: "durable", revision: "r", component: { kind: "image" as const, index: 0 }, totalBytes: data.length, offset: 0, bytes: data.length, truncated: false, sliceDigest: "s", contentDigest: "c", text: data }));
    // A small pool, so the bound is the subject rather than the numbers.
    const blobs = new ImageBlobs(request as never, "env");
    for (let index = 0; index < 30; index++) {
      await blobs.load(`key-${index}`, SESSION, { entryId: `e${index}`, component: { kind: "image", index: 0 }, totalBytes: data.length, revision: "r", excerpt: { offset: 0, bytes: 0 } }, "image/png");
    }
    expect(created).toHaveLength(30);
    // Bounded by count, oldest revoked: the transcript never holds thirty images.
    expect(revoked.length).toBe(30 - IMAGE_BLOB_MAX);
    expect(blobs.url("key-29")).toBe("blob:30");
    expect(blobs.url("key-0")).toBeUndefined();
    blobs.clear();
    expect(revoked.length).toBe(30);
  });
});
