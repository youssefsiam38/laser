// @vitest-environment happy-dom
/**
 * Deleting a child agent's session, when that child left a worktree behind
 * (M13-T42).
 *
 * The worktree is the parent's to merge and remove, so deleting the child's
 * transcript must never take the directory with it silently. These are
 * interaction tests on purpose: the dialog has to name the branch, say what it
 * holds, offer the choice, keep the safe answer selected, and put the safe verb
 * under the first Enter — and a delete that never passed through the dialog has
 * to reach the host with no instruction at all, which the host reads as "keep".
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import type { AgentWorktreeStatus, SessionSummary } from "@lasercode/protocol";

import { SessionsPanel } from "../../src/components/shell/SessionsPanel.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { sessionFolds } from "../../src/components/assistant-ui/elements/session-folds.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { takeWorktreeDisposition } from "../../src/agents/worktree.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { toThreadMetadata } from "../../src/runtime/threadList.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { snapshot, summary } from "../agents/fixtures.js";

const CHILD = "/one/.worktrees/alpha/s.jsonl";

const worktreeStatus = vi.hoisted(() => vi.fn());
const stable = vi.hoisted(() => ({
  projects: ["/one"],
  currentProject: "/one",
  setCurrentProject: vi.fn(),
  actions: {
    toast: vi.fn(),
    removeProject: vi.fn(),
    newSession: vi.fn(async () => "/one/new.jsonl"),
    openSession: vi.fn(async () => undefined),
    agents: { worktreeStatus: vi.fn() },
  },
  archive: { add: vi.fn(), has: () => true },
  client: { request: vi.fn(async () => ({ hits: [], unreadable: 0 })) },
}));
stable.actions.agents.worktreeStatus = worktreeStatus;
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

const sessions: SessionSummary[] = [
  summary({
    path: CHILD,
    cwd: "/one/.worktrees/alpha",
    name: "alpha",
    modifiedAt: "2026-09-08T03:01:00Z",
    agent: { agentName: "default", kind: "child", subagentName: "alpha", parentPath: "/one/root.jsonl", rootPath: "/one/root.jsonl" },
  }),
];

/** Records what the delete actually asked the host to do with the worktree. */
const deleted: Array<{ path: string; worktree: string }> = [];
const adapter: RemoteThreadListAdapter = {
  list: async () => ({ threads: sessions.map((s) => toThreadMetadata(s, undefined, true)) }),
  initialize: async (id) => ({ remoteId: id, externalId: id }),
  fetch: async (id) => toThreadMetadata(sessions.find((s) => s.path === id)!, undefined, true),
  rename: async () => {},
  archive: async () => {},
  unarchive: async () => {},
  // Exactly what `LaserProvider`'s adapter does: the instruction is taken from
  // the one-shot store, and absent means keep.
  delete: async (remoteId) => {
    deleted.push({ path: remoteId, worktree: takeWorktreeDisposition(remoteId) });
  },
  generateTitle: async () => {
    throw new Error("Not used");
  },
};

function useEmptyRuntime() {
  return useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
}

const shell: ShellContextValue = {
  layout: "desktop", sessionsOpen: true, telemetryOpen: false, setSessionsOpen: () => {}, setTelemetryOpen: () => {}, toggleSessions: () => {}, toggleTelemetry: () => {},
  historyOpen: false, setHistoryOpen: () => {}, openHistory: () => {}, toolsOpen: false, setToolsOpen: () => {}, addProjectOpen: false, setAddProjectOpen: () => {},
  newSession: async () => {}, canCreate: true, showChat: () => {}, returnToChat: () => {},
};

function Fixture({ store, children }: { store: StateStore; children: ReactNode }) {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return (
    <LaserStoreProvider store={store}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    </LaserStoreProvider>
  );
}

const holding = (over: Partial<AgentWorktreeStatus> = {}): AgentWorktreeStatus => ({
  path: "/one/.worktrees/alpha",
  branch: "agents/alpha-1",
  exists: true,
  unmergedCommits: 0,
  uncommittedFiles: 0,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
const seed = (): AppState => {
  let state = reduce(initialState, { type: "agents/loaded", snapshot: snapshot() });
  state = reduce(state, { type: "sessions", sessions });
  return { ...state, connection: "open" };
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionsList.reset();
  sessionFolds.reset();
  localStorage.clear();
  deleted.length = 0;
  worktreeStatus.mockReset();
  stable.actions.toast.mockClear();
  store = createStateStore(seed());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async () => act(async () => root.render(<Fixture store={store}><SessionsPanel variant="panel" /></Fixture>));
const buttons = (text: string): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.includes(text));
const dialog = (): HTMLElement | null => document.body.querySelector('[data-slot="delete-session-dialog"]');

/** Archived group → the row's menu → "Delete permanently". */
async function openDeleteDialog(): Promise<void> {
  await mount();
  await act(async () => buttons("Archived")[0]!.click());
  const trigger = [...document.body.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"] button')].find((b) =>
    b.getAttribute("aria-label")?.startsWith("Actions for"),
  )!;
  // Radix opens on pointerdown, not click; a plain `.click()` never gets there.
  await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.includes("Delete permanently"))!;
  await act(async () => item.click());
}

describe("deleting a child agent's session", () => {
  it("names its worktree, says what it holds, and keeps it unless the person says otherwise", async () => {
    worktreeStatus.mockResolvedValue(holding({ unmergedCommits: 3, uncommittedFiles: 2 }));
    await openDeleteDialog();

    expect(dialog()?.getAttribute("data-worktree")).toBe("present");
    expect(dialog()!.textContent).toContain("agents/alpha-1");
    expect(dialog()!.textContent).toContain("/one/.worktrees/alpha");
    expect(dialog()!.textContent).toContain("3 commits your project does not have and 2 uncommitted files");

    // Keeping it is the selected answer, and the verb says only "transcript".
    const choices = [...dialog()!.querySelectorAll<HTMLButtonElement>('[data-slot="delete-session-worktree-choice"]')];
    expect(choices.map((c) => [c.getAttribute("data-choice"), c.getAttribute("aria-pressed")])).toEqual([
      ["keep", "true"],
      ["delete", "false"],
    ]);
    expect(buttons("Delete transcript")[0]!.textContent).toBe("Delete transcript");
    // The safe verb owns the first Enter.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => buttons("Delete transcript")[0]!.click());
    expect(deleted).toEqual([{ path: CHILD, worktree: "keep" }]);
  });

  it("deletes the worktree too when the person chooses that, and says so on the button", async () => {
    worktreeStatus.mockResolvedValue(holding({ unmergedCommits: 1 }));
    await openDeleteDialog();

    const chooseDelete = dialog()!.querySelector<HTMLButtonElement>('[data-slot="delete-session-worktree-choice"][data-choice="delete"]')!;
    await act(async () => chooseDelete.click());
    expect(chooseDelete.getAttribute("aria-pressed")).toBe("true");
    const confirm = buttons("Delete transcript and worktree")[0]!;
    expect(confirm).toBeDefined();
    await act(async () => confirm.click());
    expect(deleted).toEqual([{ path: CHILD, worktree: "delete" }]);
  });

  it("says a clean worktree loses no work, so the choice is answerable", async () => {
    worktreeStatus.mockResolvedValue(holding());
    await openDeleteDialog();
    expect(dialog()!.textContent).toContain("Nothing in it is unmerged");
  });

  it("is exactly the dialog it always was for a session with no worktree", async () => {
    worktreeStatus.mockResolvedValue(null);
    await openDeleteDialog();
    expect(dialog()?.getAttribute("data-worktree")).toBeNull();
    expect(dialog()!.querySelector('[data-slot="delete-session-worktree"]')).toBeNull();
    expect(dialog()!.textContent).not.toContain("worktree");
    await act(async () => buttons("Delete transcript")[0]!.click());
    expect(deleted).toEqual([{ path: CHILD, worktree: "keep" }]);
  });

  it("keeps the worktree, and says so, when it cannot be read at all", async () => {
    worktreeStatus.mockRejectedValue(new Error("the host is not answering"));
    await openDeleteDialog();
    expect(dialog()!.textContent).toContain("Could not check for a worktree");
    expect(dialog()!.textContent).toContain("Its directory is kept either way");
    await act(async () => buttons("Delete transcript")[0]!.click());
    expect(deleted).toEqual([{ path: CHILD, worktree: "keep" }]);
  });

  it("forgets a choice the person backed out of, so the next delete keeps the worktree", async () => {
    worktreeStatus.mockResolvedValue(holding({ unmergedCommits: 4 }));
    await openDeleteDialog();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="delete-session-worktree-choice"][data-choice="delete"]')!.click());
    await act(async () => buttons("Cancel")[0]!.click());
    expect(deleted).toEqual([]);
    // Nothing may survive a cancelled question.
    expect(takeWorktreeDisposition(CHILD)).toBe("keep");
  });
});
