// @vitest-environment happy-dom
/**
 * RP-5b acceptance A11, at the surface: releasing the older part of a
 * conversation somebody is reading takes nothing they are using.
 *
 * The rows the transcript is standing on — the viewport's anchor, the focused
 * message, anything a surface pinned while it is open — are protected by the
 * trim itself, not by luck, and what survives is checked on the mounted
 * transcript: the row is still there, its message actions still address the
 * same entries, the prompt ordinals still mean the same thing, and the
 * person's own draft is untouched.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { ThreadMessage } from "../../src/components/thread/messages.js";
import { blockBytes } from "../../src/runtime/view-measure.js";
import { anchoredMessages, resetAnchoredMessages, setAnchoredMessages } from "../../src/runtime/anchored-messages.js";
import { MessageEditPresentation, TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { sessionState } from "../agents/fixtures.js";

const SESSION = "/project/session.jsonl";
const stable = vi.hoisted(() => ({ client: { request: vi.fn(async () => ({})) }, actions: { listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn() } }));
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
  resetAnchoredMessages();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetAnchoredMessages(); });

const entry = (index: number) => ({
  id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, type: "message",
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `${index === 0 ? "first prompt" : `turn ${index}`} ${"x".repeat(3000)}` }] },
});

function loaded(): AppState {
  let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
  state = { ...state, current: SESSION };
  state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } } as never);
  state = reduce(state, { type: "historyBegin", path: SESSION, token: "t" });
  const entries = Array.from({ length: 24 }, (_, index) => entry(index));
  state = reduce(state, { type: "historySnapshot", path: SESSION, token: "t", entries, leafId: "e23", window: {
    epoch: "w1", seq: 24, revision: "r1.env.24", environmentKey: "k", userOffset: 0, complete: true,
    branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [], anchor: "e0", before: "cursor-older",
  } } as never);
  return state;
}

async function mount(state: AppState) {
  const store = createStateStore(state);
  const view = state.open[SESSION]!;
  function Fixture() {
    const { messages } = projectMessages({ blocks: view.blocks, running: false, dialogs: [] });
    const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages></ThreadPrimitive.Root></FileOpenerProvider></AssistantRuntimeProvider>;
  }
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));
  return store;
}

const rowIds = (): string[] => [...container.querySelectorAll("[data-message-id]")].map(node => (node as HTMLElement).dataset.messageId!);

describe("releasing the older part of a conversation on screen", () => {
  it("keeps the row the viewport is standing on, and the focused one", async () => {
    const state = loaded();
    // What the transcript publishes while a person reads an older message.
    setAnchoredMessages(SESSION, ["entry:e4", "entry:e6"]);
    expect(anchoredMessages(SESSION)).toEqual(["entry:e4", "entry:e6"]);

    const store = createStateStore(state);
    store.dispatch({ type: "views/trim", paths: [SESSION], keepBytes: 8 * 1024, at: "2026-09-15T00:00:00.000Z", anchored: anchoredMessages(SESSION) });
    const after = store.getSnapshot().open[SESSION]!;

    const kept = new Set(after.blocks.map(block => block.id));
    expect(kept.has("entry:e4")).toBe(true);
    expect(kept.has("entry:e6")).toBe(true);
    expect(after.blocks.length).toBeLessThan(state.open[SESSION]!.blocks.length);
    // The records of the rows that stayed are still here, by identity.
    for (const id of ["e4", "e6"]) expect(after.entries.some(record => (record as { id: string }).id === id)).toBe(true);
    await mount(store.getSnapshot());
    expect(rowIds()).toContain("entry:e4");
    expect(rowIds()).toContain("entry:e6");
  });

  it("keeps every message action addressing the same entries, and the prompt ordinals honest", async () => {
    const before = loaded();
    await mount(before);
    const beforeRows = rowIds();
    const beforeOffset = before.open[SESSION]!.history!.userOffset;

    const store = createStateStore(before);
    setAnchoredMessages(SESSION, ["entry:e22"]);
    store.dispatch({ type: "views/trim", paths: [SESSION], keepBytes: 8 * 1024, at: "2026-09-15T00:00:00.000Z", anchored: anchoredMessages(SESSION) });
    const after = store.getSnapshot().open[SESSION]!;

    // Exactly the prompts that went are added to the offset, so the n-th
    // prompt still means the n-th prompt of the conversation.
    const releasedPrompts = before.open[SESSION]!.blocks.filter(block => block.kind === "user").length
      - after.blocks.filter(block => block.kind === "user").length;
    expect(after.history!.userOffset).toBe(beforeOffset + releasedPrompts);
    // Edit, fork, jump and the version picker all address entries by id.
    for (const block of after.blocks) {
      if (!("entryId" in block) || !block.entryId) continue;
      expect(after.entries.some(record => (record as { id: string }).id === block.entryId)).toBe(true);
    }
    // The rows that remain are the same rows, with the same identities.
    await mount(store.getSnapshot());
    for (const id of rowIds()) expect(beforeRows).toContain(id);
    // The cursor it cannot mint is gone rather than invented, and the page
    // says it is no longer complete.
    expect(after.history!.before).toBeUndefined();
    expect(after.history!.complete).toBe(false);
    expect(after.trimmed?.prompts).toBe(releasedPrompts);
  });

  it("never touches the person's own unsent words", async () => {
    let state = loaded();
    state = reduce(state, { type: "optimisticUser", path: SESSION, text: "mine, not sent", images: [], id: "unsent" });
    const presentation = new TranscriptPresentation();
    const edit = new MessageEditPresentation("half an edit");
    presentation.rememberEdit(SESSION, "entry:e4", edit);

    const store = createStateStore(state);
    store.dispatch({ type: "views/trim", paths: [SESSION], keepBytes: 4 * 1024, at: "2026-09-15T00:00:00.000Z" });
    const after = store.getSnapshot().open[SESSION]!;

    expect(after.blocks.some(block => block.kind === "user" && block.optimistic === true)).toBe(true);
    // The edit draft lives outside the view and is untouched by a release.
    expect(presentation.hasEditDraft(SESSION)).toBe(true);
    expect(edit.getSnapshot().draft).toBe("half an edit");
    expect(after.dormant).toBeUndefined();
  });

  it("measures what it released, and leaves the view inside its share", async () => {
    const state = loaded();
    const view = state.open[SESSION]!;
    const before = view.blocks.reduce((sum, block) => sum + blockBytes(block), 0);
    const store = createStateStore(state);
    store.dispatch({ type: "views/trim", paths: [SESSION], keepBytes: 8 * 1024, at: "2026-09-15T00:00:00.000Z" });
    const after = store.getSnapshot().open[SESSION]!;
    const kept = after.blocks.reduce((sum, block) => sum + blockBytes(block), 0);
    expect(kept).toBeLessThan(before);
    expect(kept).toBeLessThanOrEqual(8 * 1024 + 4096);
  });
});
