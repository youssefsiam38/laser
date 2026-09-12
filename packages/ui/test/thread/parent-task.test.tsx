// @vitest-environment happy-dom
/**
 * M13-T23 — a child's transcript says what its parent asked for.
 *
 * The harness writes a `lasercode/agent-run` marker (`moment: "started"`)
 * into the child's own session file immediately before it prompts it, so the
 * attribution is durable: it is rebuilt from disk on every reload and after a
 * host restart. Live, the file gives no event, so the `agents/run`
 * notification published just before the prompt arms the same attribution.
 *
 * What must never happen: a message the person typed into a child wearing
 * someone else's name, a child with no marker inventing one, or the task text
 * being hidden, wrapped or made unsearchable to make room for a label.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { MESSAGE_METADATA_NS, SESSION_RUN_ENTRY_TYPE } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { blocksFromEntries, initialState, reduce, type AppState, type Block } from "../../src/store.js";
import { run, sessionState, summary } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({ actions: { openSession: vi.fn(async () => undefined), toast: vi.fn(), send: vi.fn(), fork: vi.fn(), jump: vi.fn() } }));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));
vi.mock("@/dialogs", () => ({
  ToolRowDialog: () => null,
  useRegisterToolRow: () => {},
  DialogBody: () => null,
  dialogFormOf: () => ({}),
  uiResponseFor: () => ({}),
}));
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p data-slot="markdown">{text}</p> }));

const { UserMessage } = await import("../../src/components/thread/messages.js");

const PARENT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";
const TASK = "List the files here and report the count.";

/** The child's file as the harness writes it: the marker, then the prompt. */
const marker = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: SESSION_RUN_ENTRY_TYPE,
  id: "m1",
  timestamp: "2026-09-08T10:00:00.000Z",
  data: { runId: "r1", moment: "started", origin: "agent", agentName: "default", subagentName: "explorer", parentPath: PARENT, task: TASK, ...over },
});
const userEntry = (text: string, id = "u1") => ({ type: "message", id, timestamp: "2026-09-08T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text }] } });
const assistantEntry = (text: string, id = "a1") => ({ type: "message", id, timestamp: "2026-09-08T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const userBlocks = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: "user" }> => b.kind === "user");

describe("the marker on disk", () => {
  it("attributes the prompt the parent sent, and only that one", () => {
    const blocks = blocksFromEntries([
      { type: "custom", customType: "lasercode/agent", data: { agentName: "default", kind: "child", parentPath: PARENT } },
      marker(),
      userEntry(TASK),
      assistantEntry("Counted the files."),
      userEntry("Now check the tests.", "u2"),
    ]);
    const users = userBlocks(blocks);
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ text: TASK, sentBy: { parentPath: PARENT, runId: "r1" } });
    // The person typed the second one into the child: it stays theirs.
    expect(users[1]!.sentBy).toBeUndefined();
    expect(users[1]!.text).toBe("Now check the tests.");
  });

  it("attributes a later `send_agent_message` from the same parent", () => {
    const blocks = blocksFromEntries([
      marker(),
      userEntry(TASK),
      assistantEntry("Counted the files."),
      marker({ runId: "r2", task: "Also count the directories." }),
      userEntry("Also count the directories.", "u2"),
    ]);
    expect(userBlocks(blocks).map((b) => b.sentBy?.runId)).toEqual(["r1", "r2"]);
  });

  it("attributes nothing for a run the person started, an ending moment, or a child with no marker", () => {
    expect(userBlocks(blocksFromEntries([marker({ origin: "user" }), userEntry("Count them again.")]))[0]!.sentBy).toBeUndefined();
    expect(userBlocks(blocksFromEntries([marker({ moment: "completed" }), userEntry("Count them again.")]))[0]!.sentBy).toBeUndefined();
    expect(userBlocks(blocksFromEntries([marker({ parentPath: undefined }), userEntry(TASK)]))[0]!.sentBy).toBeUndefined();
    expect(userBlocks(blocksFromEntries([userEntry("Hello.")]))[0]!.sentBy).toBeUndefined();
    // A marker whose run said nothing must not travel to a later prompt.
    const stray = blocksFromEntries([marker(), assistantEntry("Ready."), userEntry("Mine.")]);
    expect(userBlocks(stray)[0]!.sentBy).toBeUndefined();
  });

  it("survives a reload: hydrating the same file rebuilds the same attribution", () => {
    const entries = [marker(), userEntry(TASK)];
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: CHILD }) });
    state = reduce(state, { type: "hydrate", path: CHILD, entries });
    const first = userBlocks(state.open[CHILD]!.blocks)[0];
    expect(first).toMatchObject({ sentBy: { parentPath: PARENT, runId: "r1" } });
    // A host restart is the same read a second time, from the same bytes.
    expect(userBlocks(blocksFromEntries(entries))[0]!.sentBy).toEqual(first!.sentBy);
  });
});

describe("live, while the child is open", () => {
  const open = (): AppState => reduce(initialState, { type: "opened", state: sessionState({ path: CHILD }) });
  const started = (state: AppState, over = {}) =>
    reduce(state, { type: "notification", method: "agents/run", params: { run: run({ runId: "r1", sessionPath: CHILD, task: TASK, ...over }) } });
  const prompt = (state: AppState, seq: number, text: string) => {
    let next = reduce(state, { type: "notification", method: "session/update", params: { sessionPath: CHILD, seq, at: "2026-09-08T10:00:01.000Z", update: { kind: "message_start", role: "user" } } });
    next = reduce(next, { type: "notification", method: "session/update", params: { sessionPath: CHILD, seq: seq + 1, at: "2026-09-08T10:00:01.000Z", update: { kind: "message_end", message: { role: "user", content: [{ type: "text", text }] } } } });
    return next;
  };

  it("attributes the prompt that follows the run the parent just started", () => {
    const state = prompt(started(open()), 1, TASK);
    expect(userBlocks(state.open[CHILD]!.blocks)[0]).toMatchObject({ text: TASK, sentBy: { parentPath: PARENT, runId: "r1" } });
  });

  it("arms once: the run's own activity updates never attribute a second message", () => {
    let state = started(open());
    state = prompt(state, 1, TASK);
    state = reduce(state, { type: "notification", method: "agents/run", params: { run: run({ runId: "r1", sessionPath: CHILD, task: TASK, updatedAt: "2026-09-08T10:05:00.000Z", activity: { turns: 2, tools: 1, lastAt: "2026-09-08T10:05:00.000Z" } }) } });
    state = prompt(state, 3, "Mine.");
    expect(userBlocks(state.open[CHILD]!.blocks).map((b) => b.sentBy?.runId)).toEqual(["r1", undefined]);
  });

  it("leaves a run the person started, and their optimistic message, unattributed", () => {
    const userRun = prompt(started(open(), { origin: "user", parent: null }), 1, "Count them again.");
    expect(userBlocks(userRun.open[CHILD]!.blocks)[0]!.sentBy).toBeUndefined();

    let typed = reduce(open(), { type: "optimisticUser", path: CHILD, text: "Mine.", images: [], id: "opt" });
    typed = prompt(started(typed), 1, "Mine.");
    expect(userBlocks(typed.open[CHILD]!.blocks)[0]!.sentBy).toBeUndefined();
  });

  it("drops what it armed when the turn opens with the child speaking, and on hydration", () => {
    let spoke = started(open());
    spoke = reduce(spoke, { type: "notification", method: "session/update", params: { sessionPath: CHILD, seq: 1, at: "", update: { kind: "message_start", role: "assistant" } } });
    spoke = prompt(spoke, 2, "Mine.");
    expect(userBlocks(spoke.open[CHILD]!.blocks)[0]!.sentBy).toBeUndefined();

    const hydrated = reduce(started(open()), { type: "hydrate", path: CHILD, entries: [userEntry("Mine.")] });
    expect(hydrated.open[CHILD]!.pendingSentBy).toBeUndefined();
    expect(userBlocks(hydrated.open[CHILD]!.blocks)[0]!.sentBy).toBeUndefined();
  });
});

describe("the projection", () => {
  it("stamps the attribution on the message metadata and leaves the text alone", () => {
    const blocks: Block[] = [
      { kind: "user", id: "b1", text: TASK, images: [], sentBy: { parentPath: PARENT, runId: "r1" } },
      { kind: "user", id: "b2", text: "Mine.", images: [] },
    ];
    const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
    expect(messages[0]!.content).toEqual([{ type: "text", text: TASK }]);
    expect(messages[0]!.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ kind: "user", userOrdinal: 0, sentBy: { parentPath: PARENT, runId: "r1" } });
    expect((messages[1]!.metadata?.custom?.[MESSAGE_METADATA_NS] as { sentBy?: unknown }).sentBy).toBeUndefined();
  });
});

describe("the bubble", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: StateStore;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    stable.actions.openSession.mockClear();
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: CHILD }) });
    state = reduce(state, { type: "sessions", sessions: [summary({ path: PARENT, name: "Ship the parser" }), summary({ path: CHILD })] });
    store = createStateStore(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const mount = (blocks: Block[]) => {
    function Fixture() {
      const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages, isRunning: false, onNew: async () => {} });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Messages>{() => <UserMessage />}</ThreadPrimitive.Messages>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      );
    }
    return act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));
  };

  const attributed: Block = { kind: "user", id: "b1", text: TASK, images: [], sentBy: { parentPath: PARENT, runId: "r1" } };

  it("names the parent, opens it, and keeps the whole task readable and searchable", async () => {
    await mount([attributed]);
    const bubble = container.querySelector<HTMLElement>('[data-slot="user-bubble"]')!;
    expect(bubble.getAttribute("data-sent-by")).toBe("parent");
    const label = container.querySelector<HTMLElement>('[data-slot="parent-task"]')!;
    expect(label.textContent).toContain("Task from");
    expect(label.textContent).toContain("Ship the parser");
    // Chrome, not content: find must not spend a match on the label.
    expect(label.hasAttribute("data-search-exclude")).toBe(true);
    // The task itself is untouched prose in the bubble, outside every control.
    const prose = Array.from(bubble.querySelectorAll("p")).map((p) => p.textContent);
    expect(prose).toContain(TASK);
    expect(label.contains(bubble.querySelector("p"))).toBe(false);

    await act(async () => label.querySelector<HTMLButtonElement>("button")!.click());
    expect(stable.actions.openSession).toHaveBeenCalledWith(PARENT);
  });

  it("falls back to a person-facing name when the parent is not in the catalog yet", async () => {
    store = createStateStore(reduce(initialState, { type: "opened", state: sessionState({ path: CHILD }) }));
    await mount([attributed]);
    const label = container.querySelector<HTMLElement>('[data-slot="parent-task"]')!;
    expect(label.textContent).toContain("Task from");
    expect(label.querySelector("button")?.textContent).toBe("the parent session");
  });

  it("leaves the person's own message exactly as it was", async () => {
    await mount([{ kind: "user", id: "b2", text: "Mine.", images: [] }]);
    const bubble = container.querySelector<HTMLElement>('[data-slot="user-bubble"]')!;
    expect(bubble.hasAttribute("data-sent-by")).toBe(false);
    expect(container.querySelector('[data-slot="parent-task"]')).toBeNull();
    expect(bubble.textContent).toBe("Mine.");
  });
});
