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
import { BODY_VIEWER_AGGREGATE_MAX_BYTES, BodyReplyRefused, BodyWindow, COPY_INFLIGHT_MAX_BYTES, copyWholeBody, FIND_QUERY_MAX_BYTES, findInBody, IMAGE_BLOB_MAX, IMAGE_SURFACE_MAX_BYTES, ImageBlobs, indexOfFolded, streamBody } from "../../src/runtime/body-reader.js";
import { sliceUtf8RangeFrom, utf8ByteLength } from "@lasercode/protocol";
import { partial } from "../../src/components/thread/LargeBodyViewer.js";
import { sessionState } from "../agents/fixtures.js";
import { LIVE_TAIL_MAX_BYTES, MESSAGE_RENDER_MAX_BYTES } from "../../src/runtime/body-excerpt.js";
import { measureView } from "../../src/runtime/view-measure.js";

const SESSION = "/project/session.jsonl";
const BODY = "answer ".repeat(600_000); // ~4 MB, for the transcript rows
const HUGE_TOTAL = 32 * 1024 * 1024; // the acceptance body: 32 MiB, paged never held

const slices = vi.hoisted(() => ({ calls: [] as Array<{ offset: number; limit?: number }> }));

/** The digest an authority signs a slice with, exactly as the readers check it. */
async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const WHOLE_DIGEST = "c".repeat(64);
/** The digest of a whole body, for the fixtures a reader reconstructs. */
async function wholeDigestOf(text: string): Promise<string> { return digestOf(text); }
const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "session/entry_range") return {};
      const offset = params.offset as number;
      const limit = (params.limit as number | undefined) ?? 65536;
      slices.calls.push({ offset, limit });
      // A 32 MiB body, generated per slice: the fake authority never holds it
      // either, so the test measures the client's own behaviour.
      const total = 32 * 1024 * 1024;
      const bytes = Math.max(0, Math.min(limit, total - offset));
      const text = "x".repeat(bytes);
      return {
        authority: "durable", revision: "r1.env.1", entryId: params.entryId as string, component: params.component, totalBytes: total,
        offset, bytes, ...(offset + bytes < total ? { next: offset + bytes } : {}),
        truncated: offset + bytes < total, sliceDigest: await digestOf(text), contentDigest: WHOLE_DIGEST, text,
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

describe("what one message renders", () => {
  it("keeps the whole mounted row inside the per-message render budget", async () => {
    // A streamed turn with both bodies at their live tail: prose and reasoning
    // are shown together, so the budget is the row's, not each body's.
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
    state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } } as never);
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 1, at: "", update: { kind: "message_start", role: "assistant" } } } as never);
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 2, at: "", update: { kind: "text_delta", delta: BODY } } } as never);
    state = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: SESSION, seq: 3, at: "", update: { kind: "thinking_delta", delta: BODY } } } as never);
    const view = state.open[SESSION]!;
    const store = createStateStore(state);
    function Fixture() {
      const { messages } = projectMessages({ blocks: view.blocks, running: true, dialogs: [] });
      const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: true, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages></ThreadPrimitive.Root></FileOpenerProvider></AssistantRuntimeProvider>;
    }
    await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));

    const row = container.querySelector('[data-message-id]') as HTMLElement;
    expect(row).not.toBeNull();
    const rendered = new TextEncoder().encode(row.textContent ?? "").byteLength;
    expect(rendered).toBeLessThanOrEqual(MESSAGE_RENDER_MAX_BYTES + 4096);
    // Each body is at its own tail bound, and the two together are the budget.
    const block = view.blocks.at(-1) as { text: string; thinking: string };
    expect(new TextEncoder().encode(block.text).byteLength).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(new TextEncoder().encode(block.thinking).byteLength).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(measureView(view).largestBodyBytes).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(measureView(view).largestBlockBytes).toBeLessThanOrEqual(MESSAGE_RENDER_MAX_BYTES);
  });
});

describe("the bounded window over one body", () => {
  const ref = { entryId: "e1", component: { kind: "assistant_text" as const }, totalBytes: HUGE_TOTAL, revision: "r1.env.1", excerpt: { offset: 0, bytes: 16_384 } };

  it("pages a thirty-two megabyte body end to end without ever holding it", async () => {
    const window = new BodyWindow(params => stable.client.request("session/entry_range", params) as never, SESSION, ref, 128 * 1024, "env");
    let steps = 0;
    while (window.getSnapshot().next !== undefined || steps === 0) {
      await window.more();
      steps += 1;
      if (steps > 1000) break;
    }
    const end = window.getSnapshot();
    expect(end.totalBytes).toBe(HUGE_TOTAL);
    expect(end.next).toBeUndefined();
    expect(steps).toBeGreaterThan(500);
    // Whatever it read, it never held more than its aggregate.
    expect(end.heldBytes).toBeLessThanOrEqual(128 * 1024);
    expect(end.evicted).toBeGreaterThan(500);
  });

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

  it("reads one slice at a time however hard it is asked", async () => {
    const window = new BodyWindow(params => stable.client.request("session/entry_range", params) as never, SESSION, ref, 128 * 1024, "env");
    // A held key and a click at the same moment: one read, one answer.
    await Promise.all([window.more(), window.more(), window.more()]);
    const offsets = slices.calls.map(call => call.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets).toHaveLength(1);
  });

  it("pages backwards, and stops at the start", async () => {
    const window = new BodyWindow(params => stable.client.request("session/entry_range", params) as never, SESSION, ref, 128 * 1024, "env");
    await window.jump(1_000_000);
    expect(window.previous).toBe(1_000_000 - 64 * 1024);
    await window.back();
    expect(window.getSnapshot().slices[0]!.offset).toBe(1_000_000 - 64 * 1024);
    await window.jump(0);
    expect(window.previous).toBeUndefined();
    await window.back();
    expect(window.getSnapshot().slices[0]!.offset).toBe(0);
  });

  it("refuses a reply that does not describe the body it asked for", async () => {
    const hostile = [
      { revision: "r9.other" },
      { component: { kind: "reasoning" as const } },
      { offset: 4096 },
      { bytes: 999_999 },
      { next: 5 },
      { totalBytes: 12 },
    ];
    for (const over of hostile) {
      const window = new BodyWindow(async (params) => ({
        authority: "durable", revision: "r1.env.1", component: params.component, totalBytes: HUGE_TOTAL,
        offset: params.offset, bytes: 8, next: params.offset + 8, truncated: true,
        sliceDigest: await digestOf("xxxxxxxx"), contentDigest: WHOLE_DIGEST, text: "xxxxxxxx",
        ...over,
      }) as never, SESSION, ref, 128 * 1024, "env");
      await expect(window.more()).rejects.toThrow(BodyReplyRefused);
      expect(window.getSnapshot().slices).toHaveLength(0);
    }
  });

  it("refuses a reply that names another message, a number that is not one, or an authority it does not know", async () => {
    const base = {
      authority: "durable" as const, revision: "r1.env.1", entryId: "e1", component: { kind: "assistant_text" as const },
      totalBytes: HUGE_TOTAL, offset: 0, bytes: 8, next: 8, truncated: true, text: "xxxxxxxx",
    };
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["another message", { entryId: "e9" }],
      ["no message at all", { entryId: undefined }],
      ["an empty message id", { entryId: "" }],
      ["text that is not text", { text: 42 }],
      ["a sum past what a number can hold", { offset: Number.MAX_SAFE_INTEGER - 1, bytes: 8, totalBytes: Number.MAX_SAFE_INTEGER }],
      ["no offset at all", { offset: Number.NaN }],
      ["a fractional offset", { offset: 0.5 }],
      ["an unsafe total", { totalBytes: Number.MAX_SAFE_INTEGER + 2 }],
      ["a negative size", { bytes: -1 }],
      ["a cursor that is not a number", { next: "8" }],
      ["an authority nobody has", { authority: "index" }],
      ["no authority", { authority: undefined }],
    ];
    for (const [why, over] of hostile) {
      const window = new BodyWindow(async (params) => ({
        ...base, component: params.component, sliceDigest: await digestOf("xxxxxxxx"), contentDigest: WHOLE_DIGEST, ...over,
      }) as never, SESSION, ref, 128 * 1024, "env");
      await expect(window.more(), why).rejects.toThrow(BodyReplyRefused);
      expect(window.getSnapshot().slices, why).toHaveLength(0);
    }
  });

  it("refuses a window that changes authority half way through", async () => {
    let call = 0;
    const window = new BodyWindow(async (params) => {
      call += 1;
      return {
        authority: call === 1 ? "durable" : "live", revision: "r1.env.1", entryId: "e1", component: params.component,
        totalBytes: HUGE_TOTAL, offset: params.offset as number, bytes: 8, next: (params.offset as number) + 8, truncated: true,
        sliceDigest: await digestOf("xxxxxxxx"), contentDigest: WHOLE_DIGEST, text: "xxxxxxxx",
      } as never;
    }, SESSION, ref, 128 * 1024, "env");
    await window.more();
    await expect(window.more()).rejects.toThrow(BodyReplyRefused);
  });

  it("refuses a second reply that changes the body under it", async () => {
    let call = 0;
    const window = new BodyWindow(async (params) => {
      call += 1;
      const total = call === 1 ? HUGE_TOTAL : HUGE_TOTAL + 1;
      return {
        authority: "durable", revision: "r1.env.1", entryId: params.entryId as string, component: params.component, totalBytes: total,
        offset: params.offset, bytes: 8, next: params.offset + 8, truncated: true, sliceDigest: await digestOf("xxxxxxxx"),
        contentDigest: call === 1 ? WHOLE_DIGEST : "d".repeat(64), text: "xxxxxxxx",
      } as never;
    }, SESSION, ref, 128 * 1024, "env");
    await window.more();
    await expect(window.more()).rejects.toThrow(BodyReplyRefused);
  });

  it("lets a read that lands after a clear touch nothing of the next one", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let phase: "old" | "new" = "old";
    const request = vi.fn(async (params: Record<string, unknown>) => {
      const old = phase === "old";
      if (old) await gate;
      // The successor reads a different body entirely: another revision,
      // another size, another digest.
      const text = old ? "oldold88" : "newnew88";
      return {
        authority: "durable", revision: old ? "r1.env.1" : "r2.env.9", entryId: params.entryId as string, component: params.component,
        totalBytes: old ? HUGE_TOTAL : HUGE_TOTAL + 4096, offset: params.offset as number, bytes: 8,
        next: (params.offset as number) + 8, truncated: true,
        sliceDigest: await digestOf(text), contentDigest: old ? "a".repeat(64) : "b".repeat(64), text,
      } as never;
    });
    const window = new BodyWindow(request as never, SESSION, { ...ref, revision: undefined } as never, 128 * 1024, "env",
      async () => (phase === "old" ? "r1.env.1" : "r2.env.9"));
    // Its outcome is caught from the moment it exists: a refusal for a body
    // nobody is reading any more is not an error anyone should see.
    let staleRefused = false;
    const stale = window.more().catch(() => { staleRefused = true; });
    await Promise.resolve();
    window.clear();
    phase = "new";
    // A successor reads the body as it is now, and settles first.
    await window.more();
    const after = window.getSnapshot();
    expect(after.slices.map(slice => slice.text)).toEqual(["newnew88"]);
    expect(after.totalBytes).toBe(HUGE_TOTAL + 4096);

    release!();
    // Whether the late read finishes or is refused, it is silent.
    await stale;
    expect(typeof staleRefused).toBe("boolean");
    // The late read painted nothing, settled nothing, and left no belief about
    // size or digest behind: the successor can keep reading its own body.
    expect(window.getSnapshot()).toEqual(after);
    await window.more();
    const next = window.getSnapshot();
    expect(next.slices.at(-1)!.text).toBe("newnew88");
    expect(next.totalBytes).toBe(HUGE_TOTAL + 4096);
  });

  it("reads a newly settled body at one current revision, and refuses another body served at a newer one", async () => {
    const body = "設".repeat(50_000);
    const digest = await digestOf(body);
    let revisions = 0;
    let served = body;
    let servedRevision = "r5.env.9";
    const seen: string[] = [];
    const request = vi.fn(async (params: Record<string, unknown>) => {
      seen.push(params.revision as string);
      const offset = params.offset as number;
      const slice = sliceUtf8RangeFrom(served, offset, 64 * 1024);
      const text = slice?.text ?? "";
      const total = utf8ByteLength(served);
      const bytes = utf8ByteLength(text);
      return { authority: "durable", revision: servedRevision, entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: await digestOf(served), text };
    });
    // The reference a settle produced: an entry and the body's own digest, and
    // deliberately no revision — the conversation has moved on since.
    const settledRef = { entryId: "a1", component: { kind: "assistant_text" as const }, totalBytes: utf8ByteLength(body),
      contentDigest: digest, excerpt: { offset: 0, bytes: 0 } };
    const window = new BodyWindow(request as never, SESSION, settledRef, BODY_VIEWER_AGGREGATE_MAX_BYTES, "env",
      async () => { revisions += 1; return servedRevision; });

    await window.more();
    await window.more();
    // One authoritative revision was obtained and every slice was fenced to it.
    expect(revisions).toBe(1);
    expect(new Set(seen)).toEqual(new Set([servedRevision]));
    expect(window.getSnapshot().slices.length).toBeGreaterThan(0);

    // The conversation moves on and the record is replaced. A fresh read at the
    // new revision is refused, because the digest this reference trusts is the
    // one the settle published: a newer revision is not permission to show
    // different bytes under the same reference.
    window.clear();
    served = `${body}more`;
    servedRevision = "r6.env.9";
    await expect(window.more()).rejects.toThrow(BodyReplyRefused);
    expect(window.getSnapshot().slices).toHaveLength(0);
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
    const imageDigest = await wholeDigestOf(data);
    stable.client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "session/revision") return { revision: "r1.env.1", environmentKey: "e1.key", authority: "durable" };
      if (method !== "session/entry_range") return {};
      const offset = params.offset as number;
      const text = data.slice(offset, offset + 65_536);
      return { authority: "durable", revision: "r1.env.1", entryId: params.entryId as string, component: params.component, totalBytes: data.length, offset,
        bytes: text.length, ...(offset + text.length < data.length ? { next: offset + text.length } : {}),
        truncated: offset + text.length < data.length, sliceDigest: await digestOf(text), contentDigest: imageDigest, text };
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

describe("finding and copying what the window does not hold", () => {
  it("copies a whole excerpted message through its authority, and marks it when it cannot", async () => {
    const body = "答".repeat(120_000);
    const total = utf8ByteLength(body);
    const whole = await digestOf(body);
    const request = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const slice = sliceUtf8RangeFrom(body, offset, (params.limit as number) ?? 65536);
      const text = slice?.text ?? "";
      const bytes = utf8ByteLength(text);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: whole, text };
    });
    const ref_ = { entryId: "e1", component: { kind: "assistant_text" as const }, totalBytes: total, revision: "r",
      excerpt: { offset: 0, bytes: 16_384 } };
    const written: unknown[] = [];
    const outcome = await copyWholeBody(request as never, SESSION, ref_, { clipboard: { write: async (items) => { written.push(items[0]); } } });
    expect(outcome.ok).toBe(true);
    // Read in slices and verified as a whole; nothing was assembled as a string.
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(written).toHaveLength(1);

    // A window that cannot take a blob gets the marked excerpt instead, and the
    // marker is in the bytes — not only in a label that disappears.
    const shown = body.slice(0, 4000);
    const marked = partial(shown, 0, utf8ByteLength(shown), total);
    expect(marked.startsWith(shown)).toBe(true);
    expect(marked).toContain("more of this message is not included");
  });


  it("finds a match in the rest of a body and says where it is, without hydrating it", async () => {
    const body = `${"a".repeat(200_000)}needle${"b".repeat(200_000)}`;
    const request = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const limit = params.limit as number;
      const text = body.slice(offset, offset + limit);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: body.length, offset,
        bytes: text.length, ...(offset + text.length < body.length ? { next: offset + text.length } : {}),
        truncated: offset + text.length < body.length, sliceDigest: await digestOf(text), contentDigest: WHOLE_DIGEST, text };
    });
    const at = await findInBody(request as never, SESSION, { entryId: "e1", component: { kind: "tool_result" }, totalBytes: body.length, revision: "r", excerpt: { offset: 0, bytes: 0 } }, "NEEDLE");
    expect(at).toBe(200_000);
    // Read in slices; nothing of the body is retained by the search itself.
    expect(request.mock.calls.length).toBeGreaterThan(3);
    const absent = await findInBody(request as never, SESSION, { entryId: "e1", component: { kind: "tool_result" }, totalBytes: body.length, revision: "r", excerpt: { offset: 0, bytes: 0 } }, "not-in-there");
    expect(absent).toBeUndefined();
  });

  it("streams a whole body to a consumer without keeping it", async () => {
    const total = 4 * 1024 * 1024;
    const wholeDigest = await wholeDigestOf("y".repeat(total));
    const request = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const bytes = Math.max(0, Math.min(params.limit as number, total - offset));
      const text = "y".repeat(bytes);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: wholeDigest, text };
    });
    let seen = 0;
    let peak = 0;
    const outcome = await streamBody(request as never, SESSION, { entryId: "e1", component: { kind: "tool_result" }, totalBytes: total, revision: "r", excerpt: { offset: 0, bytes: 0 } }, {}, slice => {
      peak = Math.max(peak, slice.length);
      seen += slice.length;
    });
    expect(outcome.bytes).toBe(total);
    expect(outcome.totalBytes).toBe(total);
    expect(seen).toBe(total);
    expect(peak).toBeLessThanOrEqual(64 * 1024);
  });

  it("says what a copied part is not", async () => {
    const { partial } = await import("../../src/components/thread/LargeBodyViewer.js");
    const marked = partial("middle", 1024, 2048, 10_000);
    expect(marked).toMatch(/earlier in this message is not included/);
    expect(marked).toMatch(/more of this message is not included/);
    expect(marked).toContain("middle");
    // A part that is the whole body is copied as itself.
    expect(partial("all", 0, 10, 10)).toBe("all");
  });
});

describe("images the window points at", () => {
  const surface = (bytes: number) => ({ decodedBytes: bytes });
  const refOf = (index: number, total: number, decoded = 16 * 1024 * 1024) => ({
    entryId: `e${index}`, component: { kind: "image" as const, index: 0 }, totalBytes: total, revision: "r",
    excerpt: { offset: 0, bytes: 0 }, image: surface(decoded),
  });
  let created: string[];
  let revoked: string[];
  let blobParts: number[];

  beforeEach(() => {
    created = []; revoked = []; blobParts = [];
    let counter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => { const url = `blob:${++counter}`; created.push(url); return url; });
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    // A Blob that records how many parts it was built from, so the test can
    // see that slices are folded in as they arrive rather than collected.
    class RecordingBlob {
      size = 0;
      constructor(parts: Array<{ size?: number; byteLength?: number }> = []) {
        blobParts.push(parts.length);
        for (const part of parts) this.size += part?.size ?? part?.byteLength ?? 0;
      }
    }
    (globalThis as { Blob: unknown }).Blob = RecordingBlob as never;
  });

  /** A payload of `slices` slices of base64, generated per request. */
  const payload = (slices: number) => {
    const sliceChars = 64 * 1024;
    const total = slices * sliceChars;
    // The digest the authority publishes for the whole image, so a reader that
    // verifies its reconstruction sees the image it asked for.
    const whole = digestOf("QUJD".repeat(total / 4));
    return vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const bytes = Math.max(0, Math.min(params.limit as number, total - offset));
      const text = "QUJD".repeat(bytes / 4);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: await whole, text };
    });
  };

  it("folds slices into the blob as they arrive instead of collecting them", async () => {
    const request = payload(40); // 2.5 MB of base64 in forty slices
    const blobs = new ImageBlobs(request as never, "env");
    const url = await blobs.load("k", SESSION, refOf(1, 40 * 64 * 1024), "image/png");
    expect(url).toBe("blob:1");
    // Never more than the in-flight allowance in hand: each fold takes a few
    // slices, so the parts array is short and bounded, not forty long.
    // Each fold is the blob so far plus the few slices that fit the in-flight
    // allowance — never the forty slices of the whole image.
    expect(Math.max(...blobParts)).toBeLessThanOrEqual(8);
    expect(blobParts.length).toBeGreaterThan(5);
  });

  it("refuses an image larger than one window may rebuild", async () => {
    const blobs = new ImageBlobs(payload(1) as never, "env");
    const huge = { ...refOf(2, 64 * 1024 * 1024 + 1), image: surface(16 * 1024 * 1024) };
    expect(await blobs.load("huge", SESSION, huge, "image/png")).toBeUndefined();
    // …and one whose decoded surface alone would not fit the budget.
    const wide = { ...refOf(3, 4096), image: surface(IMAGE_SURFACE_MAX_BYTES + 1) };
    expect(await blobs.load("wide", SESSION, wide, "image/png")).toBeUndefined();
  });

  it("admits the unchanged twelve-image fixture and stays inside its surface budget", async () => {
    const blobs = new ImageBlobs(payload(2) as never, "env");
    const urls = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      blobs.load(`fixture-${index}`, SESSION, refOf(index, 2 * 64 * 1024), "image/png")));
    expect(urls.every(url => typeof url === "string")).toBe(true);
    expect(blobs.held.images).toBe(12);
    expect(blobs.held.surface).toBe(12 * 16 * 1024 * 1024);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);
  });

  it("drops the oldest nobody is showing when the budget is reached", async () => {
    const blobs = new ImageBlobs(payload(1) as never, "env");
    for (let index = 0; index < 30; index++) {
      await blobs.load(`k${index}`, SESSION, refOf(index, 64 * 1024, 1024), "image/png");
      blobs.release(`k${index}`);
      // A row that has gone releases its hold; the URL is revoked at once.
    }
    expect(revoked.length).toBe(30);
    expect(blobs.held.images).toBe(0);
  });

  it("revokes when the last row showing an image goes", async () => {
    const blobs = new ImageBlobs(payload(1) as never, "env");
    await blobs.load("shared", SESSION, refOf(1, 64 * 1024, 1024), "image/png");
    await blobs.load("shared", SESSION, refOf(1, 64 * 1024, 1024), "image/png"); // a second row
    blobs.release("shared");
    expect(revoked).toHaveLength(0);
    expect(blobs.url("shared")).toBe("blob:1");
    blobs.release("shared");
    expect(revoked).toEqual(["blob:1"]);
    expect(blobs.url("shared")).toBeUndefined();
    expect(blobs.held).toEqual({ images: 0, bytes: 0, surface: 0 });
  });

  it("fences a read that lands after the cache was cleared", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async (params: Record<string, unknown>) => {
      await gate;
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: 4, offset: 0, bytes: 4,
        truncated: false, sliceDigest: await digestOf("QUJD"), contentDigest: await digestOf("QUJD"), text: "QUJD" };
    });
    const blobs = new ImageBlobs(request as never, "env");
    const pending = blobs.load("late", SESSION, refOf(1, 4, 1024), "image/png");
    blobs.clear();
    release!();
    expect(await pending).toBeUndefined();
    expect(blobs.url("late")).toBeUndefined();
    // Whatever it built was revoked rather than published into the new environment.
    expect(revoked.length).toBe(created.length);
    expect(blobs.held.images).toBe(0);
  });

  it("does not read the same image twice while one read is in flight", async () => {
    const request = payload(1);
    const blobs = new ImageBlobs(request as never, "env");
    const [first, second] = await Promise.all([
      blobs.load("same", SESSION, refOf(1, 64 * 1024, 1024), "image/png"),
      blobs.load("same", SESSION, refOf(1, 64 * 1024, 1024), "image/png"),
    ]);
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });

  it("never holds more than the stated scratch, on uneven multi-byte slices", async () => {
    // Slices of awkward sizes in characters that are two and four bytes each:
    // the ceiling is in bytes, and it is a ceiling, not an average.
    const unit = "ü😀";           // 2 + 4 bytes
    const body = unit.repeat(120_000);
    const totalBytes = utf8ByteLength(body);
    const whole = await digestOf(body);
    let cursor = 0;
    const request = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      // Uneven slices, every one inside the protocol's own slice bound.
      const want = [61_000, 7, 64 * 1024, 999, 33_333][cursor++ % 5]!;
      const slice = sliceUtf8RangeFrom(body, offset, want);
      const text = slice?.text ?? "";
      const bytes = utf8ByteLength(text);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes, offset, bytes,
        ...(offset + bytes < totalBytes ? { next: offset + bytes } : {}), truncated: offset + bytes < totalBytes,
        sliceDigest: await digestOf(text), contentDigest: whole, text };
    });
    // Every Blob this builds records the bytes it was handed beyond the blob
    // it grew from: that is the scratch in the JavaScript heap at that moment.
    let peak = 0;
    const RealBlob = globalThis.Blob;
    class MeasuringBlob {
      size = 0;
      constructor(parts: Array<{ size?: number; byteLength?: number } | string> = []) {
        let fresh = 0;
        for (const part of parts) {
          const size = typeof part === "string" ? utf8ByteLength(part) : (part?.size ?? part?.byteLength ?? 0);
          this.size += size;
          if (typeof part === "string") fresh += size;
        }
        peak = Math.max(peak, fresh);
      }
    }
    (globalThis as { Blob: unknown }).Blob = MeasuringBlob as never;
    const writer = { write: vi.fn(async () => {}) };
    const outcome = await copyWholeBody(request as never, SESSION,
      { entryId: "e1", component: { kind: "tool_result" }, totalBytes, revision: "r", excerpt: { offset: 0, bytes: 0 } },
      { clipboard: writer as never });
    (globalThis as { Blob: unknown }).Blob = RealBlob;
    expect(outcome.ok).toBe(true);
    // Whatever was in hand at once stayed inside the promise, literally.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(COPY_INFLIGHT_MAX_BYTES);
  });

  it("refuses an image whose slices are each signed but whose whole is not the image", async () => {
    const total = 64 * 1024;
    const corrupt = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const bytes = Math.max(0, Math.min(params.limit as number, total - offset));
      const text = "QUJD".repeat(bytes / 4);
      // Every slice digest is honest; the body as a whole is a different one.
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: await digestOf("something else"), text };
    });
    const blobs = new ImageBlobs(corrupt as never, "env");
    expect(await blobs.load("corrupt", SESSION, refOf(1, total, 1024), "image/png")).toBeUndefined();
    expect(blobs.held).toEqual({ images: 0, bytes: 0, surface: 0 });
    // Nothing was published, and whatever was built was given back.
    expect(revoked.length).toBe(created.length);
  });

  it("keeps count and surface exact when many unique reads race, and refuses the rest", async () => {
    // Every read is held open until the test lets it finish, so all of them are
    // in flight at once: admission must count what is being read, not only what
    // has been published (RP-5b §7.3).
    let open = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const total = 64 * 1024;
    const whole = digestOf("QUJD".repeat(total / 4));
    const slow = vi.fn(async (params: Record<string, unknown>) => {
      open += 1; peak = Math.max(peak, open);
      await gate;
      open -= 1;
      const offset = params.offset as number;
      const bytes = Math.max(0, Math.min(params.limit as number, total - offset));
      const text = "QUJD".repeat(bytes / 4);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: await whole, text };
    });
    const blobs = new ImageBlobs(slow as never, "env");
    // Sixty distinct images, each claiming a twelfth of the surface budget.
    const claim = Math.floor(IMAGE_SURFACE_MAX_BYTES / 12);
    const pending = Array.from({ length: 60 }, (_, index) =>
      blobs.load(`race-${index}`, SESSION, { ...refOf(index, total), image: surface(claim) }, "image/png"));
    // Never more reads in flight than the pool may ever hold.
    expect(peak).toBeLessThanOrEqual(IMAGE_BLOB_MAX);
    release!();
    const urls = await Promise.all(pending);
    const admitted = urls.filter(url => typeof url === "string").length;
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(12);
    expect(blobs.held.images).toBe(admitted);
    expect(blobs.held.images).toBeLessThanOrEqual(IMAGE_BLOB_MAX);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);
    expect(blobs.committed).toEqual(blobs.held);
    // Nothing published was stolen from a row that is showing it.
    for (let index = 0; index < 60; index++) {
      const url = blobs.url(`race-${index}`);
      if (url) expect(revoked).not.toContain(url);
    }
  });

  it("lets a read that outlived its environment touch nothing of the next one", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const total = 64 * 1024;
    const whole = digestOf("QUJD".repeat(total / 4));
    let held = true;
    const request = vi.fn(async (params: Record<string, unknown>) => {
      if (held) await gate;
      const offset = params.offset as number;
      const bytes = Math.max(0, Math.min(params.limit as number, total - offset));
      const text = "QUJD".repeat(bytes / 4);
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component, totalBytes: total, offset, bytes,
        ...(offset + bytes < total ? { next: offset + bytes } : {}), truncated: offset + bytes < total,
        sliceDigest: await digestOf(text), contentDigest: await whole, text };
    });
    const blobs = new ImageBlobs(request as never, "env");
    const old = blobs.load("same-key", SESSION, refOf(1, total, 1024), "image/png");
    blobs.clear();
    // A new generation reads the same key and two rows show it.
    held = false;
    const fresh = await blobs.load("same-key", SESSION, refOf(1, total, 1024), "image/png");
    await blobs.load("same-key", SESSION, refOf(1, total, 1024), "image/png");
    expect(typeof fresh).toBe("string");

    release!();
    expect(await old).toBeUndefined();
    // The successor is untouched: its URL still published, its holders intact,
    // its counters exact and never negative.
    expect(blobs.url("same-key")).toBe(fresh);
    expect(revoked).not.toContain(fresh);
    expect(blobs.held.images).toBe(1);
    expect(blobs.committed).toEqual(blobs.held);
    expect(blobs.held.bytes).toBeGreaterThan(0);
    blobs.release("same-key");
    expect(blobs.url("same-key")).toBe(fresh);
    blobs.release("same-key");
    expect(blobs.url("same-key")).toBeUndefined();
    expect(blobs.held).toEqual({ images: 0, bytes: 0, surface: 0 });
    expect(blobs.committed).toEqual({ images: 0, bytes: 0, surface: 0 });
  });

  it("hands a rebuilt picture out from the pool, held and never copied", async () => {
    const blobs = new ImageBlobs(payload(1) as never, "env");
    const url = await blobs.load("open-me", SESSION, refOf(1, 64 * 1024, 1024), "image/png");
    expect(typeof url).toBe("string");
    const before = blobs.held;
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

    const source = blobs.source("open-me")!;
    // The pool's own blob and URL, and not one byte more charged for opening it.
    expect(source.url).toBe(url);
    expect(source.bytes).toBe(before.bytes);
    expect(blobs.held).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The row goes; the viewer is still open, so nothing is revoked.
    blobs.release("open-me");
    expect(revoked).not.toContain(url);
    expect(blobs.url("open-me")).toBe(url);
    // The viewer closes: now it goes.
    blobs.release("open-me");
    expect(revoked).toContain(url);
    expect(blobs.url("open-me")).toBeUndefined();
    expect(blobs.held).toEqual({ images: 0, bytes: 0, surface: 0 });
    fetchSpy.mockRestore();
  });

  it("refuses a malformed payload rather than showing something else", async () => {
    const malformed = vi.fn(async (params: Record<string, unknown>) => ({
      authority: "durable", revision: "r", component: params.component, totalBytes: 14, offset: 0, bytes: 14,
      truncated: false, sliceDigest: await digestOf("!!not base64!!"), contentDigest: WHOLE_DIGEST, text: "!!not base64!!",
    }));
    const blobs = new ImageBlobs(malformed as never, "env");
    expect(await blobs.load("bad", SESSION, refOf(1, 8, 1024), "image/png")).toBeUndefined();
    expect(created).toHaveLength(0);
  });
});
