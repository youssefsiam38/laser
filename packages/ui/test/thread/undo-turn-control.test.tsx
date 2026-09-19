// @vitest-environment happy-dom
/**
 * Undo this turn — the transcript control and its confirmation.
 *
 * Pointer and keyboard: the control is only on a prompt whose checkpoint is
 * kept; a no-op target is hidden; the dialog names repositories, files and
 * uncommitted work; Cancel never sends confirm; Confirm sends it once; a
 * running-turn refusal and a per-repository refusal each render as a sentence;
 * Enter from the row does not confirm (and does not open).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { RestorePreview, RestoreResult } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, useLaserState, type StateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";

const restoreImpl = vi.hoisted(() => ({
  list: [] as { turn: number; failed?: true }[],
  preview: undefined as RestorePreview | undefined,
  previewError: undefined as Error | undefined,
  result: undefined as RestoreResult | undefined,
  resultError: undefined as Error | undefined,
  calls: [] as Array<{ method: string; params: unknown }>,
}));

const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string, params: unknown) => {
      restoreImpl.calls.push({ method, params });
      if (method === "pi/project/checkpoint/list") {
        return {
          path: "/p/work.jsonl",
          retention: "200",
          checkpoints: restoreImpl.list.map((row) => ({
            turn: row.turn,
            ref: `refs/product/checkpoints/s/${row.turn}`,
            commit: `c${row.turn}`,
            createdAt: "2026-09-19T00:00:00.000Z",
            ...(row.failed ? { failed: true as const } : {}),
          })),
        };
      }
      if (method === "pi/project/restore") {
        const body = params as { confirm?: boolean };
        if (!body.confirm) {
          if (restoreImpl.previewError) throw restoreImpl.previewError;
          return { preview: restoreImpl.preview };
        }
        if (restoreImpl.resultError) throw restoreImpl.resultError;
        return restoreImpl.result ?? { preview: restoreImpl.preview, restored: { files: true, conversation: true, repos: [] } };
      }
      return {};
    }),
    subscribe: vi.fn(() => () => {}),
  },
  actions: {
    toast: vi.fn(),
    rereadHistory: vi.fn(async () => undefined),
    fork: vi.fn(async () => undefined),
    jump: vi.fn(async () => undefined),
    navigate: vi.fn(async () => ({})),
    send: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    loadAllEntries: vi.fn(async () => undefined),
  },
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useCapability: () => ({ state: "available" }),
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

const preview = (over: Partial<RestorePreview> = {}): RestorePreview => ({
  turn: 0,
  restore: "both",
  hidden: [],
  repos: [
    {
      repo: "/p/app",
      branch: "main",
      files: ["src/foo.ts", "src/bar.ts"],
      uncommittedLost: ["scratch.txt"],
    },
  ],
  conversation: { entryId: "u1", turn: 0 },
  staging: "not_restored",
  detail: "The working tree is restored. Staging is not: a checkpoint cannot record what was staged versus unstaged.",
  ...over,
});

const msg = (id: string, parentId: string | null, role: string, text: string) => ({
  id,
  parentId,
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  await act(async () => settle(0));
  await act(async () => settle(0));
};

const openStore = (entries: unknown[], leafId: string) => {
  let state: AppState = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION }) });
  state = reduce(state, {
    type: "destination",
    destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: SESSION } },
  });
  state = reduce(state, { type: "hydrate", path: SESSION, entries, leafId });
  store = createStateStore(state);
};

const mount = () => {
  function Fixture() {
    const view = useLaserState((s) => s.open[SESSION]);
    const { messages } = projectMessages({ blocks: view?.blocks ?? [], running: view?.running ?? false, dialogs: view?.dialogs ?? [] });
    const runtime = useExternalStoreRuntime({
      convertMessage: (message: ThreadMessageLike) => message,
      messages,
      isRunning: view?.running ?? false,
      onNew: async () => {},
    });
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

const userRoots = () => [...container.querySelectorAll<HTMLElement>('[data-role="user"]')];
const undoButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="undo-turn"]')];
const dialog = () => document.querySelector<HTMLElement>('[data-slot="undo-turn-dialog"]');
const confirm = () => document.querySelector<HTMLButtonElement>('[data-slot="undo-turn-confirm"]');
const dialogButton = (label: string) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.trim() === label);

const pressKey = async (el: HTMLElement, key: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
    if (!event.defaultPrevented && (key === "Enter" || key === " ")) el.click();
  });
  return event;
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  restoreImpl.list = [{ turn: 0 }];
  restoreImpl.preview = preview();
  restoreImpl.previewError = undefined;
  restoreImpl.result = undefined;
  restoreImpl.resultError = undefined;
  restoreImpl.calls = [];
  stable.client.request.mockClear();
  stable.actions.toast.mockClear();
  stable.actions.rereadHistory.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dialog()?.remove();
});

describe("Undo this turn", () => {
  it("appears only on a prompt whose checkpoint is kept", async () => {
    restoreImpl.list = [{ turn: 0 }, { turn: 1, failed: true }];
    openStore(
      [
        msg("u1", null, "user", "first"),
        msg("a1", "u1", "assistant", "ok"),
        msg("u2", "a1", "user", "second"),
        msg("a2", "u2", "assistant", "ok"),
      ],
      "a2",
    );
    await mount();
    await flush();
    const rows = userRoots();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[data-slot="undo-turn"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-slot="undo-turn"]')).toBeNull();
  });

  it("hides a no-op target, names repositories and uncommitted work, and Cancel never confirms", async () => {
    restoreImpl.preview = preview({ hidden: ["conversation"] });
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    await act(async () => undoButtons()[0]!.click());
    await flush();
    const sheet = dialog()!;
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain("This restores the files in this turn's checkpoint.");
    expect(sheet.querySelector('[data-target="files"]')).toBeNull();
    expect(sheet.querySelector('[data-target="conversation"]')).toBeNull();
    expect(sheet.querySelector('[data-target="both"]')).toBeNull();
    expect(sheet.textContent).toContain("app");
    expect(sheet.textContent).toContain("main");
    expect(sheet.textContent).toContain("src/foo.ts");
    expect(sheet.textContent).toContain("scratch.txt");
    expect(sheet.textContent).toContain("Uncommitted work that would be lost");
    expect(sheet.textContent).toContain("Staging is not");
    expect(sheet.textContent).not.toContain("The conversation moves back");
    await act(async () => dialogButton("Cancel")!.click());
    await flush();
    expect(dialog()).toBeNull();
    expect(restoreImpl.calls.filter((call) => call.method === "pi/project/restore")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ turn: 0, restore: "both" }) }),
    ]);
    expect(restoreImpl.calls.some((call) => (call.params as { confirm?: boolean }).confirm === true)).toBe(false);
  });

  it("confirms once with the chosen target and does not send confirm on the preview", async () => {
    restoreImpl.result = {
      preview: preview(),
      restored: { files: true, conversation: false, repos: [{ repo: "/p/app", restored: true }] },
    };
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    await act(async () => undoButtons()[0]!.click());
    await flush();
    const files = dialog()!.querySelector<HTMLButtonElement>('[data-target="files"]')!;
    await act(async () => files.click());
    await act(async () => confirm()!.click());
    await flush();
    const confirmed = restoreImpl.calls.filter(
      (call) => call.method === "pi/project/restore" && (call.params as { confirm?: boolean }).confirm === true,
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.params).toEqual(expect.objectContaining({ cwd: "/p", path: SESSION, turn: 0, restore: "files", confirm: true }));
    expect(stable.actions.rereadHistory).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("rereads history when the conversation was restored", async () => {
    restoreImpl.result = {
      preview: preview(),
      restored: { files: false, conversation: true, repos: [] },
    };
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    await act(async () => undoButtons()[0]!.click());
    await flush();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-target="conversation"]')!.click());
    await act(async () => confirm()!.click());
    await flush();
    expect(stable.actions.rereadHistory).toHaveBeenCalledTimes(1);
  });

  it("renders a running-turn refusal as a sentence and does not confirm", async () => {
    restoreImpl.previewError = new Error(
      "A turn is running, so this conversation cannot be restored until it finishes or is stopped.",
    );
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    await act(async () => undoButtons()[0]!.click());
    await flush();
    expect(dialog()?.querySelector('[data-slot="undo-turn-error"]')?.textContent).toMatch(/turn is running/);
    expect(confirm()).toBeNull();
    expect(restoreImpl.calls.some((call) => (call.params as { confirm?: boolean }).confirm === true)).toBe(false);
  });

  it("renders a per-repository refusal as a sentence instead of claiming success", async () => {
    restoreImpl.result = {
      preview: preview(),
      restored: {
        files: true,
        conversation: false,
        repos: [
          { repo: "/p/app", restored: true },
          { repo: "/p/other", restored: false, detail: "That checkpoint is not in this repository, so its files were left unchanged." },
        ],
      },
    };
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    await act(async () => undoButtons()[0]!.click());
    await flush();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-target="files"]')!.click());
    await act(async () => confirm()!.click());
    await flush();
    expect(dialog()?.querySelector('[data-slot="undo-turn-refusals"]')?.textContent).toMatch(/not in this repository/);
    expect(stable.actions.toast).not.toHaveBeenCalled();
    expect(dialogButton("Close")).toBeDefined();
  });

  it("does not confirm from Enter on the row; Space opens, and Cancel owns the first Enter", async () => {
    openStore([msg("u1", null, "user", "first"), msg("a1", "u1", "assistant", "ok")], "a1");
    await mount();
    await flush();
    const trigger = undoButtons()[0]!;
    const enter = await pressKey(trigger, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    await flush();
    expect(dialog()).toBeNull();
    expect(restoreImpl.calls.some((call) => call.method === "pi/project/restore")).toBe(false);

    const space = await pressKey(trigger, " ");
    expect(space.defaultPrevented).toBe(false);
    await flush();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialogButton("Cancel"));
    expect(restoreImpl.calls.filter((call) => call.method === "pi/project/restore" && (call.params as { confirm?: boolean }).confirm === true)).toHaveLength(0);

    await act(async () => dialogButton("Cancel")!.click());
    await flush();
    expect(dialog()).toBeNull();
  });
});
