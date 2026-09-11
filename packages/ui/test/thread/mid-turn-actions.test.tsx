// @vitest-environment happy-dom
/**
 * M13-T44 / M13-T46 — the newest prompt's actions do not wait for its turn.
 *
 * The engine writes a prompt's entry before the provider request goes out, and
 * the worker sends that entry with the prompt's own `message_end`. So while the
 * reply streams, the newest bubble already knows where it is in the tree: its
 * menu offers the request that was just sent, the tree actions and the version
 * picker, and they act on the real id — without a re-read of the tree. Only a
 * prompt the engine has not taken yet (optimistic) still has nothing.
 *
 * Mid-turn, Edit, Fork and Jump are live (M13-T46): the engine will not move
 * the leaf while a reply streams, so each asks the worker to stop the reply
 * first and then move — `stopFirst`, one request, the worker's sequence — and
 * says so beside the action. The same actions once the turn is over carry no
 * such request.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import type { HostNotifications, SessionUpdate } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, useLaserState, type StateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string) => {
      if (method === "pi/models/catalog") return { models: [] };
      if (method === "pi/logs/query") return { entries: [], hasMore: false };
      if (method === "pi/prefs/get") return { entries: [] };
      return {};
    }),
    subscribe: vi.fn(() => () => {}),
  },
  actions: {
    openSession: vi.fn(async () => undefined),
    toast: vi.fn(),
    send: vi.fn(async () => undefined),
    fork: vi.fn(async () => undefined),
    jump: vi.fn(async () => undefined),
    navigate: vi.fn(async () => ({ editorText: "" }) as { editorText?: string } | false),
    setModel: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    refreshEntries: vi.fn(async () => undefined),
  },
}));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => stable,
}));
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

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
let seq = 0;

/** What the host sends: one `session/update` per engine event, in order. */
const update = (u: SessionUpdate) => {
  const params: HostNotifications["session/update"] = { sessionPath: SESSION, seq: ++seq, update: u, at: "2026-09-08T09:00:01.000Z" };
  store.dispatch({ type: "notification", method: "session/update", params });
};

/** A prompt goes in and its turn starts: the shape of every send. */
const promptTaken = (text: string, entry?: { id: string; parentId: string | null }) => {
  store.dispatch({ type: "optimisticUser", path: SESSION, text, images: 0 });
  update({ kind: "agent_start" });
  update({ kind: "message_start", role: "user" });
  update({ kind: "message_end", role: "user", message: { role: "user", content: [{ type: "text", text }] }, ...(entry ? { entry } : {}) });
  update({ kind: "message_start", role: "assistant" });
  update({ kind: "text_delta", delta: "on it", contentIndex: 0 });
};

const open = (entries: unknown[], leafId: string) => {
  let state: AppState = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION }) });
  state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: SESSION } } });
  state = reduce(state, { type: "hydrate", path: SESSION, entries, leafId });
  store = createStateStore(state);
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  seq = 0;
  for (const fn of Object.values(stable.actions)) fn.mockClear();
  stable.client.request.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = () => {
  function Fixture() {
    const view = useLaserState((s) => s.open[SESSION]);
    const { messages } = projectMessages({ blocks: view?.blocks ?? [], running: view?.running ?? false, dialogs: view?.dialogs ?? [] });
    const runtime = useExternalStoreRuntime({ messages, isRunning: view?.running ?? false, onNew: async () => {} });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
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

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const dispatch = async (fn: () => void) => {
  await act(async () => fn());
  await act(async () => settle(0));
};
const userRoots = () => [...container.querySelectorAll<HTMLElement>('[data-role="user"]')];
/** A control by its label; mid-turn a label may carry a " · stops the reply" suffix. */
const control = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label || (b.getAttribute("aria-label") ?? "").split(" · ")[0] === label);
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (label: string) => menuItems().find((el) => (el.textContent ?? "").includes(label));
/** Radix opens on pointerdown, not click. */
const openMenu = async (row: HTMLElement) => {
  await act(async () => control(row, "More")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  await act(async () => settle(10));
};
const closeMenu = async () => {
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => settle(10));
};
const choose = async (label: string) => {
  const el = item(label)!;
  expect(el).toBeDefined();
  // A menu item activates on pointerup after a pointermove, or on Enter.
  await act(async () => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await act(async () => settle(10));
};

describe("the newest prompt while its turn runs", () => {
  it("knows its entry: the request it produced opens, and the tree actions are offered", async () => {
    open([msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages")], "a1");
    await mount();
    await dispatch(() => promptTaken("list the tests", { id: "u2", parentId: "a1" }));

    const newest = userRoots().at(-1)!;
    expect(newest.textContent).toContain("list the tests");
    expect(newest.dataset["optimistic"]).toBeUndefined();
    // The tree actions are on the menu and live: each will stop the reply
    // first, and the row says so where the person is about to click.
    await openMenu(newest);
    expect(item("View API request")).toBeDefined();
    expect(item("Fork from here")).toBeDefined();
    expect(item("Jump to this entry")).toBeDefined();
    expect(item("Fork from here")?.getAttribute("aria-disabled")).toBeNull();
    expect(item("Jump to this entry")?.getAttribute("aria-disabled")).toBeNull();
    expect(item("Fork from here")?.textContent).toContain("stops the reply");
    expect(item("Jump to this entry")?.textContent).toContain("stops the reply");
    // The request went out at turn start; the dialog asks for it by the
    // prompt's own entry, not by a time window that would miss it.
    await choose("View API request");
    expect(stable.client.request).toHaveBeenCalledWith("pi/logs/query", expect.objectContaining({ sessionPath: SESSION, promptEntryId: "u2", kind: "provider_request" }));
    expect(document.body.textContent).toContain("No captured request for this message");
    // Nothing above asked for the tree to be re-read.
    expect(stable.actions.refreshEntries).not.toHaveBeenCalled();
    expect(stable.client.request).not.toHaveBeenCalledWith("pi/session/entries", expect.anything());
  });

  it("acts on the real entry the moment the turn ends, before the tree is re-read, and asks for no stop", async () => {
    open([msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages")], "a1");
    await mount();
    await dispatch(() => promptTaken("list the tests", { id: "u2", parentId: "a1" }));
    await dispatch(() => {
      update({ kind: "message_end", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } });
      update({ kind: "agent_settled" });
    });
    const newest = userRoots().at(-1)!;
    expect(control(newest, "Edit")?.disabled).toBe(false);
    await openMenu(newest);
    expect(item("Fork from here")?.textContent).not.toContain("stops the reply");
    await choose("Fork from here");
    expect(stable.actions.fork).toHaveBeenCalledWith("u2", { stopFirst: false });
    await openMenu(newest);
    await choose("Jump to this entry");
    expect(stable.actions.jump).toHaveBeenCalledWith("u2", { stopFirst: false });
    // The older prompt still resolves through the tree as it was read.
    const first = userRoots()[0]!;
    await openMenu(first);
    await choose("Fork from here");
    expect(stable.actions.fork).toHaveBeenLastCalledWith("u1", { stopFirst: false });
    await closeMenu();
  });

  describe("while the reply streams, each tree action stops it first (M13-T46)", () => {
    const streaming = async () => {
      open([msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages")], "a1");
      await mount();
      await dispatch(() => promptTaken("list the tests", { id: "u2", parentId: "a1" }));
      expect(store.getSnapshot().open[SESSION]?.running).toBe(true);
    };

    it("Fork from here: one request, stop then fork", async () => {
      await streaming();
      const newest = userRoots().at(-1)!;
      await openMenu(newest);
      await choose("Fork from here");
      expect(stable.actions.fork).toHaveBeenCalledWith("u2", { stopFirst: true });
      // Not a stop the UI made on its own, followed by a move it hoped for.
      expect(stable.client.request).not.toHaveBeenCalledWith("session/cancel", expect.anything());
    });

    it("Jump to this entry: one request, stop then move — on an older prompt too", async () => {
      await streaming();
      const first = userRoots()[0]!;
      await openMenu(first);
      await choose("Jump to this entry");
      expect(stable.actions.jump).toHaveBeenCalledWith("u1", { stopFirst: true });
      expect(stable.client.request).not.toHaveBeenCalledWith("session/cancel", expect.anything());
    });

    it("Edit: the card says it stops the reply, sends, and the re-prompt goes out after the stop", async () => {
      await streaming();
      const newest = userRoots().at(-1)!;
      const edit = control(newest, "Edit")!;
      expect(edit.disabled).toBe(false);
      expect(edit.getAttribute("aria-label")).toContain("stops the reply");
      await act(async () => edit.click());
      const card = container.querySelector('[data-slot="edit-message"]')!;
      expect(card.textContent).toContain("Stops the reply being written");
      expect(card.textContent).not.toContain("Finish or stop");
      const field = card.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(field, "list the tests and the scripts");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const send = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Send")!;
      expect(send.disabled).toBe(false);
      const order: string[] = [];
      stable.actions.navigate.mockImplementation(async () => {
        order.push("navigate");
        return { editorText: "list the tests" };
      });
      stable.actions.send.mockImplementation(async () => {
        order.push("send");
      });
      await act(async () => send.click());
      await act(async () => settle(10));
      expect(stable.actions.navigate).toHaveBeenCalledWith("u2", { stopFirst: true });
      // A prompt, not a tray entry: the worker stopped the turn, so it sends.
      expect(stable.actions.send).toHaveBeenCalledWith([{ type: "text", text: "list the tests and the scripts" }], "prompt");
      expect(order).toEqual(["navigate", "send"]);
      expect(container.querySelector('[data-slot="edit-message"]')).toBeNull();
    });

    it("Edit: a move that fails after the stop keeps the words and the editor, and sends nothing", async () => {
      await streaming();
      const newest = userRoots().at(-1)!;
      await act(async () => control(newest, "Edit")!.click());
      const card = container.querySelector('[data-slot="edit-message"]')!;
      // What the provider answers when the worker's move threw after its stop.
      stable.actions.navigate.mockResolvedValue(false);
      const send = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Send")!;
      await act(async () => send.click());
      await act(async () => settle(10));
      expect(stable.actions.navigate).toHaveBeenCalledWith("u2", { stopFirst: true });
      expect(stable.actions.send).not.toHaveBeenCalled();
      expect(container.querySelector('[data-slot="edit-message"] textarea')).not.toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>('[data-slot="edit-message"] textarea')!.value).toBe("list the tests");
    });

    it("Edit: one click is one send while the move is in flight", async () => {
      await streaming();
      const newest = userRoots().at(-1)!;
      await act(async () => control(newest, "Edit")!.click());
      let release!: () => void;
      stable.actions.navigate.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ editorText: "list the tests" }))));
      const send = () => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="edit-message"] button')].find((b) => b.textContent?.trim() === "Send")!;
      await act(async () => send().click());
      expect(send().disabled).toBe(true);
      expect(container.querySelector('[data-slot="edit-message"]')?.textContent).toContain("sending");
      await act(async () => send().click());
      await act(async () => {
        release();
        await settle(10);
      });
      expect(stable.actions.navigate).toHaveBeenCalledTimes(1);
      expect(stable.actions.send).toHaveBeenCalledTimes(1);
    });

    it("Try again still waits for the turn", async () => {
      await streaming();
      // The finished reply above: re-running its prompt over a reply still
      // being written is the one thing stop-then-do cannot mean.
      const reply = [...container.querySelectorAll<HTMLElement>('[data-role="assistant"]')][0]!;
      const again = control(reply, "Try again");
      expect(again).toBeDefined();
      expect(again?.disabled).toBe(true);
    });
  });

  it("counts the new version of an edited prompt while its turn runs", async () => {
    // An edit in place: the leaf moved to before u2b, and the new wording is
    // being sent there beside u2a and u2b.
    open(
      [
        msg("u1", null, "user", "explore the repo"),
        msg("a1", "u1", "assistant", "three packages"),
        msg("u2a", "a1", "user", "list the tests"),
        msg("a2a", "u2a", "assistant", "eleven files"),
        msg("u2b", "a1", "user", "list the tests"),
        msg("a2b", "u2b", "assistant", "eleven files, one skipped"),
      ],
      "a1",
    );
    await mount();
    await dispatch(() => promptTaken("list the tests and the scripts", { id: "u2c", parentId: "a1" }));
    const newest = userRoots().at(-1)!;
    const picker = newest.querySelector('[data-slot="message-branches"] span');
    expect(picker?.getAttribute("aria-label")).toBe("Version 3 of 3");
  });

  it("gives a prompt the engine has not taken yet nothing to act on", async () => {
    open([msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages")], "a1");
    await mount();
    await dispatch(() => store.dispatch({ type: "optimisticUser", path: SESSION, text: "list the tests", images: 0 }));
    const newest = userRoots().at(-1)!;
    expect(newest.dataset["optimistic"]).toBe("true");
    expect(control(newest, "Edit")).toBeUndefined();
    await openMenu(newest);
    expect(item("Fork from here")).toBeUndefined();
    expect(item("Jump to this entry")).toBeUndefined();
    await closeMenu();
  });

  it("falls back to the tree as read for a prompt an older worker reports without an entry", async () => {
    open([msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages")], "a1");
    await mount();
    await dispatch(() => promptTaken("list the tests"));
    const newest = userRoots().at(-1)!;
    expect(control(newest, "Edit")).toBeUndefined();
    await dispatch(() => store.dispatch({ type: "entries", path: SESSION, entries: [msg("u1", null, "user", "explore the repo"), msg("a1", "u1", "assistant", "three packages"), msg("u2", "a1", "user", "list the tests")], leafId: "u2" }));
    expect(control(userRoots().at(-1)!, "Edit")).toBeDefined();
  });
});
