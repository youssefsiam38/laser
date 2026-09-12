// @vitest-environment happy-dom
/**
 * M15-T5: completion completes, it never runs and never sends.
 *
 * Interaction tests through the real composer and the real picker — the
 * production `Composer`, the installed `composer-trigger-popover`, the real
 * slash adapter and the real ranking — because the defect lived in the seam
 * between them: Tab selected a row, and selecting a laser command *executed*
 * it, so completing `/compa` compacted the session.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

import { view as makeView } from "../agents/fixtures.js";

const mocks = vi.hoisted(() => ({
  mobile: false,
  touch: false,
  running: false,
  commands: [] as unknown[],
  client: { request: vi.fn() },
  toast: vi.fn(),
  compact: vi.fn(),
  fork: vi.fn(),
  clearQueue: vi.fn(),
  refreshEntries: vi.fn(),
  takeEditorText: vi.fn(),
  newSession: vi.fn(),
  openHistory: vi.fn(),
  setAddProjectOpen: vi.fn(),
  sent: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile, useIsTouch: () => mocks.touch }));
vi.mock("@/components/assistant-ui/elements/agent-selector", () => ({ SessionAgentSelector: () => null }));
vi.mock("@/components/assistant-ui/elements/model-selector", () => ({ SessionModelSelector: () => null }));
vi.mock("@/components/assistant-ui/elements/reasoning-effort", () => ({ ThinkingEffort: () => null }));
vi.mock("@/components/assistant-ui/elements/context-display", () => ({ ContextRingButton: () => null }));
vi.mock("@/components/assistant-ui/elements/draft-restore", () => ({ ComposerDraftRestore: () => null }));
vi.mock("@/components/assistant-ui/elements/message-queue", () => ({ ComposerQueue: () => null }));
vi.mock("@/components/assistant-ui/elements/quote.aui", () => ({ ComposerQuotePreview: () => null, quoteAsMarkdown: (text: string) => text }));
vi.mock("@/components/thread/StatusLine.js", () => ({ StatusLine: () => null }));
vi.mock("@/components/thread/session-preparation.js", () => ({
  SessionPreparationProvider: ({ children }: { children: ReactNode }) => children,
  useSessionPreparation: () => ({ pending: false }),
}));
vi.mock("@/components/thread/use-project-file-search.js", () => ({
  useProjectFileSearch: () => ({ files: [{ path: "src/app.ts", tracked: true }], loading: false, failed: false, truncated: false, retry: vi.fn() }),
}));
vi.mock("@/components/shell/session-groups", () => ({ useSessionsList: () => ({ tab: "code" }) }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ newSession: mocks.newSession, openHistory: mocks.openHistory, setAddProjectOpen: mocks.setAddProjectOpen }),
}));
vi.mock("@/agents", () => ({ useRunsForRoot: () => [] }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => mocks.view,
  useLaserStable: () => ({
    currentProject: "/project",
    client: mocks.client,
    actions: {
      toast: mocks.toast,
      compact: mocks.compact,
      fork: mocks.fork,
      clearQueue: mocks.clearQueue,
      refreshEntries: mocks.refreshEntries,
      takeEditorText: mocks.takeEditorText,
    },
  }),
  useSessionMeta: () => ({ running: mocks.running, compacting: false }),
})) as unknown as void;

import { Composer } from "../../src/components/thread/Composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

function Fixture() {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: mocks.running, onNew: mocks.sent });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Composer />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
const input = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const popup = () => container.querySelector('[role="listbox"]');
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const highlighted = () => container.querySelector('[role="option"][aria-selected="true"]');

async function type(value: string, position = value.length) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().setSelectionRange(position, position);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  await act(async () => {
    input().dispatchEvent(event);
  });
  // The command rows write the composer through a microtask-deferred timeout.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return event;
}

const mount = () => act(async () => root.render(<Fixture />));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.mobile = false;
  mocks.touch = false;
  mocks.running = false;
  mocks.commands = [];
  for (const fn of [mocks.toast, mocks.compact, mocks.fork, mocks.clearQueue, mocks.refreshEntries, mocks.takeEditorText, mocks.newSession, mocks.openHistory, mocks.setAddProjectOpen, mocks.sent]) fn.mockReset();
  mocks.client.request.mockReset().mockImplementation(async (method: string) => (method === "pi/commands/list" ? { commands: mocks.commands } : {}));
  mocks.view = makeView({ path: "/project/session.jsonl" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** Nothing ran and nothing was sent. */
const nothingHappened = () => {
  expect(mocks.compact).not.toHaveBeenCalled();
  expect(mocks.fork).not.toHaveBeenCalled();
  expect(mocks.clearQueue).not.toHaveBeenCalled();
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.openHistory).not.toHaveBeenCalled();
  expect(mocks.setAddProjectOpen).not.toHaveBeenCalled();
  expect(mocks.sent).not.toHaveBeenCalled();
};

describe("completing a slash command", () => {
  // The reported defect: Tab was a *selection*, and selecting a laser command
  // executed it, so completing `/compa` compacted the session and wiped the
  // draft. Tab now only writes the word.
  it("completes the one match on Tab, runs nothing and sends nothing", async () => {
    await mount();
    await type("/compa");
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["/compact"]);
    await key("Tab");
    nothingHappened();
    // The command's own word, completed the way a shell completes one: no
    // trailing space, so the caret — the one the person can see — is still
    // inside the command token.
    expect(input().value).toBe("/compact");
    expect(input().selectionStart).toBe("/compact".length);
    // Still open on what it completed, so the person's next Enter is the
    // explicit second act — and it is the one that runs the command.
    expect(popup()).not.toBeNull();
    expect(highlighted()?.getAttribute("aria-label")).toBe("/compact");
    await key("Enter");
    expect(mocks.compact).toHaveBeenCalledTimes(1);
    expect(mocks.sent).not.toHaveBeenCalled();
  });

  it("completes the highlighted row, not the first one, when several match", async () => {
    mocks.commands = [
      { name: "compare-diffs", source: "command", description: "Compare two diffs" },
      { name: "compose-release", source: "prompt", description: "Draft the notes" },
    ];
    await mount();
    await type("/comp");
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["/compact", "/compare-diffs", "/compose-release"]);
    await key("ArrowDown");
    await key("ArrowDown");
    expect(highlighted()?.getAttribute("aria-label")).toBe("/compose-release");
    await key("Tab");
    expect(input().value).toBe("/compose-release");
    nothingHappened();
  });

  it("keeps the rest of the draft, and stays on the command it completed", async () => {
    await mount();
    // The caret is inside the command token; everything after it is the
    // person's argument text and must survive untouched.
    await type("/compa keep this\nand this", 6);
    await key("Tab");
    expect(input().value).toBe("/compact keep this\nand this");
    // The caret lands after the command, not after the arguments: assigning a
    // new value would otherwise leave it at the end of the draft.
    expect(input().selectionStart).toBe("/compact".length);
    // The picker still holds the completed command — the completion moved the
    // query to the end of the command's own word, not past its arguments.
    expect(highlighted()?.getAttribute("aria-label")).toBe("/compact");
    nothingHappened();

    // Typing on past the command leaves the picker, as typing always does.
    await type("/compact keep this\nand this more", "/compact keep this\nand this more".length);
    expect(popup()).toBeNull();
    nothingHappened();
  });

  it("never queues while a turn is running", async () => {
    mocks.running = true;
    await mount();
    await type("/compa");
    await key("Tab");
    expect(input().value).toBe("/compact");
    nothingHappened();
  });

  // F4: the primitive's keyboard resource excludes only Shift from its
  // `case "Enter": case "Tab":`, so a chorded Tab that reached it would select
  // — and selecting one of the app's own commands runs it.
  it("lets a chorded Tab traverse without selecting or running anything", async () => {
    await mount();
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      await type("");
      await type("/compa");
      expect(popup()).not.toBeNull();
      const event = await key("Tab", { [modifier]: true });
      expect(event.defaultPrevented).toBe(false);
      expect(input().value).toBe("/compa");
      expect(popup()).toBeNull();
      nothingHappened();
    }
    // Shift+Tab is the same traversal it always was.
    await type("");
    await type("/compa");
    const shift = await key("Tab", { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    expect(input().value).toBe("/compa");
    expect(popup()).toBeNull();
    nothingHappened();
  });

  it("leaves an IME confirmation to the IME", async () => {
    await mount();
    await type("/compa");
    await key("Tab", { isComposing: true });
    await key("Enter", { isComposing: true });
    expect(input().value).toBe("/compa");
    nothingHappened();
  });

  it("writes an agent command into the draft on Tab, on Enter and on a tap, and sends none of them", async () => {
    mocks.commands = [{ name: "skill:review", source: "skill", description: "Review a diff" }];
    await mount();

    await type("/skil");
    await key("Tab");
    expect(input().value).toBe("/skill:review");
    nothingHappened();

    // Choosing the row is the other gesture: it prepares the command for its
    // arguments, with the trailing space it has always written.
    await type("/skil");
    await key("Enter");
    expect(input().value).toBe("/skill:review ");
    nothingHappened();

    await type("/skil");
    const row = rows()[0]!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      row.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input().value).toBe("/skill:review ");
    nothingHappened();
  });

  it("runs one of the app's own commands when the row is chosen, and still never sends the draft", async () => {
    await mount();
    // Choosing the row — with the mouse or a tap — is the person picking the
    // command, so it runs; it is still never a send.
    await type("/fo");
    const row = rows()[0]!;
    expect(row.getAttribute("aria-label")).toBe("/fork");
    await act(async () => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      row.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.refreshEntries).toHaveBeenCalledWith({ tail: true });
    expect(mocks.sent).not.toHaveBeenCalled();
    expect(input().value).toBe("");
  });
});

describe("completing an @ mention", () => {
  it("inserts the file and sends nothing, on Tab and on Enter", async () => {
    await mount();
    await type("@app");
    await key("Tab");
    expect(input().value).toContain("src/app.ts");
    expect(mocks.sent).not.toHaveBeenCalled();

    await type("@app");
    await key("Enter");
    expect(input().value).toContain("src/app.ts");
    expect(mocks.sent).not.toHaveBeenCalled();
  });
});
