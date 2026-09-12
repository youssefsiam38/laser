import type { ThreadMessageLike } from "@assistant-ui/react";
// @vitest-environment happy-dom
/**
 * M13-T35 — which control does which thing.
 *
 * The runtime half of this (the tree, the leaf, the transcript that comes
 * back) is `test/runtime/edit-in-place.test.tsx`. This one is about the
 * promise the buttons make: the primary action changes the session that is
 * open, the fork is a second, clearly named choice, and neither is ever a
 * silent no-op when the engine refuses.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useAui, useExternalStoreRuntime } from "@assistant-ui/react";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { goalRecords } from "../../src/runtime/goal-history.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { blocksFromEntries, initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({
  // The real provider hands every consumer a host client; the "run it again with
  // another model / thinking level" controls inside a message footer ask it for
  // the model catalog on mount. A fixture without one crashes the whole tree.
  footerRenders: new Map<string, number>(),
  client: { request: vi.fn(async (method: string) => (method === "pi/models/catalog" ? { models: [
    { provider: "test", id: "fallback", name: "Fallback", thinkingLevels: ["off", "high"] },
  ] } : {})) },
  actions: {
    openSession: vi.fn(async () => undefined),
    toast: vi.fn(),
    send: vi.fn(async () => undefined),
    fork: vi.fn(async () => undefined),
    jump: vi.fn(async () => undefined),
    navigate: vi.fn(async () => ({ editorText: "list the tests" }) as { editorText?: string } | false),
    setModel: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
  },
}));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => stable,
}));
vi.mock("@/components/assistant-ui/elements/message-pair", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/assistant-ui/elements/message-pair.js")>();
  const { useAui } = await import("@assistant-ui/react");
  return { ...actual, MessageFooter: (props: React.ComponentProps<typeof actual.MessageFooter>) => {
    const message = useAui().message.getState();
    if (message.role === "assistant") stable.footerRenders.set(message.id, (stable.footerRenders.get(message.id) ?? 0) + 1);
    return <actual.MessageFooter {...props} />;
  } };
});
vi.mock("@/dialogs", () => ({
  ToolRowDialog: () => null,
  useRegisterToolRow: () => {},
  DialogBody: () => null,
  dialogFormOf: () => ({}),
  uiResponseFor: () => ({}),
}));
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p data-slot="markdown">{text}</p> }));

const { ThreadMessage } = await import("../../src/components/thread/messages.js");

const SESSION = "/p/work.jsonl";

const msg = (id: string, parentId: string | null, role: string, text: string) => ({
  id,
  parentId,
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

/**
 * One conversation, and one older version of its second message — the shape an
 * edit in place leaves behind. u2b is live; u2a and its reply are the version
 * the picker goes back to.
 *
 *   u1 ─ a1 ─ u2a ─ a2a
 *            └ u2b ─ a2b
 */
const entries = [
  msg("u1", null, "user", "explore the repo"),
  msg("a1", "u1", "assistant", "three packages"),
  msg("u2a", "a1", "user", "list the tests"),
  msg("a2a", "u2a", "assistant", "eleven files"),
  msg("u2b", "a1", "user", "list the tests"),
  msg("a2b", "u2b", "assistant", "eleven files, one skipped"),
];
const LEAF = "a2b";

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stable.footerRenders.clear();
  for (const fn of Object.values(stable.actions)) fn.mockClear();
  stable.actions.navigate.mockResolvedValue({ editorText: "list the tests" });
  let state: AppState = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION }) });
  state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: SESSION } } });
  state = reduce(state, { type: "hydrate", path: SESSION, entries, leafId: LEAF });
  store = createStateStore(state);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The thread's own composer, reached the way a message reaches it. */
let threadComposer: { getState(): { text: string }; setText(text: string): void } | undefined;

const mount = (history: unknown[] = entries, leafId: string | undefined = LEAF) => {
  function Probe() {
    const aui = useAui();
    threadComposer = aui.thread.composer();
    return null;
  }
  function Fixture() {
    const blocks = blocksFromEntries(history, leafId);
    const { messages } = projectMessages({ blocks, running: false, dialogs: [], goals: goalRecords(history, blocks) });
    const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: false, onNew: async () => {} });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <Probe />
          <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    );
  }
  return act(async () =>
    root.render(
      <LaserStoreProvider store={store}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </LaserStoreProvider>,
    ),
  );
};

const byTitle = (title: string): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.getAttribute("aria-label") === title || b.textContent?.trim() === title);
const click = async (element: Element | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await act(async () => undefined);
};
const userRoots = () => [...container.querySelectorAll('[data-role="user"]')];
const editor = () => container.querySelector<HTMLTextAreaElement>('[data-slot="edit-message"] textarea');
const type = async (text: string) => {
  const field = editor()!;
  const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** The pencil on the second user bubble: the message with two versions. */
const startEdit = async () => {
  const bubble = userRoots().at(-1)!;
  const pencil = [...bubble.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Edit")!;
  await click(pencil);
};

describe("streaming footer subscriptions", () => {
  it.skipIf(!process.env.PERF_BENCH)("benchmarks 12 settled footers across 500 irrelevant deltas", async () => {
    const history = Array.from({ length: 24 }, (_, index) => msg(`bench-${index}`, index ? `bench-${index - 1}` : null, index % 2 ? "assistant" : "user", `Message ${index}`));
    store.dispatch({ type: "hydrate", path: SESSION, entries: history, leafId: "bench-23" });
    await mount(history, "bench-23");
    stable.footerRenders.clear();
    const start = performance.now();
    const cpu = process.cpuUsage();
    for (let seq = 1; seq <= 500; seq++) {
      await act(async () => store.dispatch({ type: "notification", method: "session/update", params: {
        sessionPath: SESSION, seq, at: "2026-09-12T00:00:00Z",
        update: { kind: "text_delta", contentIndex: 0, delta: "x" },
      } }));
    }
    const elapsed = process.cpuUsage(cpu);
    console.log("PERF_BATCH_1", JSON.stringify({ footers: 12, deltas: 500, executions: [...stable.footerRenders.values()].reduce((a, b) => a + b, 0), wallMs: performance.now() - start, cpuMs: (elapsed.user + elapsed.system) / 1000 }));
  });
  it("does not execute settled footers for 500 text deltas", async () => {
    await mount();
    stable.footerRenders.clear();
    for (let seq = 1; seq <= 500; seq++) {
      await act(async () => store.dispatch({ type: "notification", method: "session/update", params: {
        sessionPath: SESSION, seq, at: new Date().toISOString(),
        update: { kind: "text_delta", contentIndex: 0, delta: "x" },
      } }));
    }
    expect([...stable.footerRenders.values()].every((count) => count <= 1)).toBe(true);
  });

  it("uses fallback model capabilities when opening regenerate", async () => {
    await mount();
    await act(async () => store.dispatch({ type: "notification", method: "session/update", params: {
      sessionPath: SESSION, seq: 1, at: new Date().toISOString(),
      update: { kind: "state", state: sessionState({ path: SESSION, model: { provider: "test", id: "fallback" }, thinkingLevel: "high" }) },
    } }));
    await click(byTitle("Try again with another model or thinking level")[0]);
    const levels = document.querySelector<HTMLSelectElement>('select[aria-label="Thinking level for re-run"]');
    expect([...levels!.options].map((option) => option.value)).toEqual(["off", "high"]);
    expect(levels!.value).toBe("high");
    expect(document.body.textContent).toContain("fallback");
  });
});

describe("editing a message you sent", () => {
  it("offers a plain Edit, not a fork, on the bubble", async () => {
    await mount();
    const bubble = userRoots().at(-1)!;
    const labels = [...bubble.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Edit");
    expect(labels.join(" ")).not.toMatch(/fork/i);
  });

  it("sends the edit into this session, and says that is what it does", async () => {
    await mount();
    await startEdit();

    const card = container.querySelector('[data-slot="edit-message"]')!;
    expect(card.textContent).toContain("Edit message");
    expect(card.textContent).toContain("Replaces this message here");
    expect(editor()!.value).toBe("list the tests");

    await type("list the tests and the scripts");
    await click(byTitle("Send")[0]);

    // Before it: the session moves to this prompt's place in the tree, then the
    // new wording is sent there.
    expect(stable.actions.navigate).toHaveBeenCalledWith("u2b", { stopFirst: false });
    expect(stable.actions.fork).not.toHaveBeenCalled();
    expect(stable.actions.send).toHaveBeenCalledWith([{ type: "text", text: "list the tests and the scripts" }], "prompt");
    expect(container.querySelector('[data-slot="edit-message"]')).toBeNull();
  });

  it("keeps a fork as the second choice, named as a new session", async () => {
    await mount();
    await startEdit();

    const secondary = byTitle("In a new session")[0];
    expect(secondary).toBeDefined();
    await click(secondary);

    expect(stable.actions.fork).toHaveBeenCalledWith("u2b", { stopFirst: false });
    expect(stable.actions.navigate).not.toHaveBeenCalled();
    expect(stable.actions.send).toHaveBeenCalledWith([{ type: "text", text: "list the tests" }], "prompt");
  });

  it("takes the forked prompt back out of the composer, and leaves a real draft alone", async () => {
    await mount();
    // The fork hands the original prompt to the composer for editing; the edit
    // has just been sent, so the box goes back to empty.
    await act(async () => threadComposer!.setText("list the tests"));
    await startEdit();
    await click(byTitle("In a new session")[0]);
    expect(threadComposer!.getState().text).toBe("");

    stable.actions.fork.mockClear();
    await act(async () => threadComposer!.setText("and then open a PR"));
    await startEdit();
    await click(byTitle("In a new session")[0]);
    expect(threadComposer!.getState().text).toBe("and then open a PR");
  });

  it("keeps the words and the editor when the move is refused", async () => {
    stable.actions.navigate.mockResolvedValue(false);
    await mount();
    await startEdit();
    await type("something else entirely");

    await click(byTitle("Send")[0]);

    expect(stable.actions.send).not.toHaveBeenCalled();
    expect(editor()?.value).toBe("something else entirely");
  });
});

describe("the version picker", () => {
  it("counts the versions of the prompt and places the live one", async () => {
    await mount();
    const picker = userRoots().at(-1)!.querySelector('[data-slot="message-branches"]')!;
    expect(picker.textContent).toBe("2 / 2");
    // "2 / 2" alone does not say what it counts; the count carries the words.
    expect(picker.querySelector("span[aria-label]")!.getAttribute("aria-label")).toBe("Version 2 of 2");
    expect([...picker.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Previous version", "Next version"]);
  });

  it("says nothing under a message that has only ever had one version", async () => {
    await mount();
    expect(userRoots()[0]!.querySelector('[data-slot="message-branches"]')).toBeNull();
  });

  it("switches through the version's own last entry, not the prompt", async () => {
    await mount();
    const picker = userRoots().at(-1)!.querySelector('[data-slot="message-branches"]')!;
    await click(picker.querySelector('button[aria-label="Previous version"]') ?? picker.querySelector("button")!);
    // Navigating onto a prompt would put the session before it; the version is
    // reached through the reply that ends it.
    expect(stable.actions.jump).toHaveBeenCalledWith("a2a");
  });
});

describe("running a reply again", () => {
  it("returns to the visible goal setter rather than its hidden continuation", async () => {
    const text = "Goal mode is active.\n<goal_objective>\nVisible objective\n</goal_objective>\n<goal_id>\ng1\n</goal_id>\n<!-- pi-goal-prompt:test-g1 -->";
    const history = [
      { id: "goal", type: "custom", customType: "goal-state", data: { goal: { id: "g1", text: "Visible objective", status: "active", startedAt: 1, updatedAt: 1, iteration: 0 } } },
      msg("visible", "goal", "user", text),
      msg("reply", "visible", "assistant", "Working"),
      msg("hidden", "reply", "user", text),
      msg("final", "hidden", "assistant", "Done"),
    ];
    store.dispatch({ type: "hydrate", path: SESSION, entries: history, leafId: "final" });
    stable.actions.navigate.mockResolvedValue({});
    await mount(history, "final");
    await click(byTitle("Try again").at(-1));
    expect(stable.actions.navigate).toHaveBeenCalledWith("visible");
    expect(stable.actions.send).toHaveBeenCalledWith([{ type: "text", text: "Visible objective" }], "prompt");
  });
  it("answers again in this session, from the prompt the engine hands back", async () => {
    await mount();
    const footer = [...container.querySelectorAll('[data-role="assistant"]')].at(-1)!;
    const again = [...footer.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Try again")!;
    expect(again).toBeDefined();

    await click(again);

    expect(stable.actions.navigate).toHaveBeenCalledWith("u2b");
    expect(stable.actions.fork).not.toHaveBeenCalled();
    expect(stable.actions.send).toHaveBeenCalledWith([{ type: "text", text: "list the tests" }], "prompt");
  });

  it("does not run anything when the move is refused", async () => {
    stable.actions.navigate.mockResolvedValue(false);
    await mount();
    const footer = [...container.querySelectorAll('[data-role="assistant"]')].at(-1)!;
    await click([...footer.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Try again")!);
    expect(stable.actions.send).not.toHaveBeenCalled();
  });
});
