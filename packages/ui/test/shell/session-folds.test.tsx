// @vitest-environment happy-dom
/**
 * The sessions sidebar's two folds (M13-T24): a parent's sub-sessions behind a
 * disclosure in its own row, and the settled ones behind a second disclosure
 * beneath the live ones.
 *
 * These are interaction tests on purpose (AGENTS.md, disclosures): pointer and
 * keyboard toggles, the remembered choice, a collapsed body that genuinely has
 * no rows in it, and the reveal that keeps the open session findable.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react";
import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import { SessionsPanel } from "../../src/components/shell/SessionsPanel.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { ThreadList } from "../../src/components/assistant-ui/elements/thread-list.aui.js";
import { SESSION_FOLDS_STORAGE_KEY, sessionFolds } from "../../src/components/assistant-ui/elements/session-folds.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { toThreadMetadata } from "../../src/runtime/threadList.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { run, snapshot, summary } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({
  projects: ["/one"],
  currentProject: "/one",
  setCurrentProject: vi.fn(),
  actions: { toast: vi.fn(), removeProject: vi.fn(), newSession: vi.fn(async () => "/one/new.jsonl"), openSession: vi.fn(async () => undefined) },
  archive: { add: vi.fn(), has: () => false },
  client: { request: vi.fn(async () => ({ hits: [], unreadable: 0 })) },
}));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

// One parent with every state under it at once: two working, one waiting on
// the person, one done, one failed, and one that is itself done but still has
// a working child — the branch that must not be filed away as finished.
const ROOT = "/one/root.jsonl";
const QUIET = "/one/quiet.jsonl";
const ALPHA = "/one/.worktrees/alpha/s.jsonl";
const BRAVO = "/one/.worktrees/bravo/s.jsonl";
const CHARLIE = "/one/.worktrees/charlie/s.jsonl";
const DELTA = "/one/.worktrees/delta/s.jsonl";
const ECHO = "/one/.worktrees/echo/s.jsonl";
const FOXTROT = "/one/.worktrees/foxtrot/s.jsonl";

const child = (path: string, name: string, parentPath: string, at: string): SessionSummary =>
  summary({
    path,
    cwd: path.slice(0, path.lastIndexOf("/")),
    name,
    modifiedAt: at,
    agent: { agentName: "default", kind: "child", subagentName: name, parentPath, rootPath: ROOT, runId: name },
  });

const sessions: SessionSummary[] = [
  summary({ path: ROOT, cwd: "/one", name: "Ship the release", modifiedAt: "2026-09-08T03:00:00Z", attention: "working" }),
  summary({ path: QUIET, cwd: "/one", name: "Quiet session", modifiedAt: "2026-09-08T02:00:00Z" }),
  child(ALPHA, "alpha", ROOT, "2026-09-08T03:01:00Z"),
  child(BRAVO, "bravo", ROOT, "2026-09-08T03:02:00Z"),
  child(CHARLIE, "charlie", ROOT, "2026-09-08T03:03:00Z"),
  child(DELTA, "delta", ROOT, "2026-09-08T03:04:00Z"),
  child(ECHO, "echo", ROOT, "2026-09-08T03:05:00Z"),
  child(FOXTROT, "foxtrot", ECHO, "2026-09-08T03:06:00Z"),
];

const at = (minute: number) => `2026-09-08T03:${String(minute).padStart(2, "0")}:00Z`;
const childRun = (runId: string, sessionPath: string, status: AgentRun["status"], minute: number, parentPath = ROOT): AgentRun =>
  run({ runId, sessionPath, subagentName: runId, agentName: "default", projectCwd: "/one", rootSessionPath: ROOT, parent: { sessionPath: parentPath, sessionId: parentPath }, status, startedAt: at(minute), updatedAt: at(minute) });

const runs: AgentRun[] = [
  childRun("alpha", ALPHA, "running", 1),
  childRun("bravo", BRAVO, "blocked", 2),
  childRun("charlie", CHARLIE, "completed", 3),
  childRun("delta", DELTA, "failed", 4),
  childRun("echo", ECHO, "completed", 5),
  childRun("foxtrot", FOXTROT, "running", 6, ECHO),
];

const adapter: RemoteThreadListAdapter = {
  list: async () => ({ threads: sessions.map((s) => toThreadMetadata(s, undefined, false)) }),
  initialize: async (id) => ({ remoteId: id, externalId: id }),
  fetch: async (id) => toThreadMetadata(sessions.find((s) => s.path === id)!, undefined, false),
  rename: async () => {}, archive: async () => {}, unarchive: async () => {}, delete: async () => {},
  generateTitle: async () => { throw new Error("Not used"); },
};
function useEmptyRuntime() { return useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} }); }
const shell: ShellContextValue = {
  layout: "desktop", sessionsOpen: true, telemetryOpen: false, setSessionsOpen: () => {}, setTelemetryOpen: () => {}, toggleSessions: () => {}, toggleTelemetry: () => {},
  historyOpen: false, setHistoryOpen: () => {}, openHistory: () => {}, toolsOpen: false, setToolsOpen: () => {}, addProjectOpen: false, setAddProjectOpen: () => {},
  newSession: async () => {}, canCreate: true, showChat: () => {}, returnToChat: () => {},
};

/** Selects a session the way the app does, by the path the row carries. */
let select: (path: string) => void = () => {};
let mainPath = "";
function SelectProbe() {
  const aui = useAui();
  const items = useAuiState((s) => s.threads.threadItems);
  const main = useAuiState((s) => s.threads.mainThreadId);
  useEffect(() => {
    select = (path) => {
      const item = items.find((candidate) => (candidate.externalId ?? candidate.remoteId) === path);
      if (item) aui.threads.item({ id: item.id }).switchTo();
    };
    mainPath = items.find((candidate) => candidate.id === main)?.externalId ?? "";
  });
  return null;
}

function Fixture({ store, children }: { store: StateStore; children: ReactNode }) {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return (
    <LaserStoreProvider store={store}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <ShellContext.Provider value={shell}>
            {children}
            <SelectProbe />
          </ShellContext.Provider>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    </LaserStoreProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
const seed = (): AppState => {
  let state = reduce(initialState, { type: "agents/loaded", snapshot: snapshot() });
  state = reduce(state, { type: "sessions", sessions });
  state = { ...state, connection: "open" };
  for (const r of runs) state = reduce(state, { type: "agents/run", run: r });
  return state;
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionsList.reset();
  sessionFolds.reset();
  localStorage.clear();
  store = createStateStore(seed());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (node: ReactNode = <SessionsPanel variant="panel" />) => act(async () => root.render(<Fixture store={store}>{node}</Fixture>));
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"]')];
const rowNamed = (text: string) => rows().find((row) => row.querySelector('[data-slot="aui_thread-list-item-title"]')?.textContent?.includes(text));
/** Just the row names, independent of the compact state marks. */
const names = () => rows().map((row) => row.querySelector('[data-slot="aui_thread-list-item-title"]')?.textContent);
const branchOf = (text: string) => rowNamed(text)?.closest<HTMLElement>('[data-slot="session-branch"]');
/** A branch's own disclosure, not one of its descendants'. */
const foldOf = (text: string) => branchOf(text)!.querySelector<HTMLButtonElement>(':scope > div > [data-slot="session-fold"]')!;
const finishedFoldOf = (text: string) =>
  branchOf(text)!.querySelector<HTMLButtonElement>('[data-slot="session-children"] > [data-slot="finished-sessions"] > [data-slot="finished-fold"]');
const foldStatusOf = (text: string) => foldOf(text).querySelector<HTMLElement>('[data-slot="session-fold-status"]');

describe("sub-sessions fold", () => {
  it("opens a parent with live work, keeps the settled ones behind a second fold, and counts both without opening either", async () => {
    await mount();

    // Live children, in start order, directly under the parent.
    const parent = foldOf("Ship the release");
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(parent.getAttribute("aria-label")).toBe("Hide the 6 agents under Ship the release. 6 agents under this session: 2 working, 1 needs you, 3 finished, 1 of them failed");
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Working");
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-state"]')).toBeNull();
    expect(rowNamed("bravo")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Needs you");
    expect(rowNamed("bravo")?.querySelector('[data-slot="run-state"]')).toBeNull();
    // Done, but with a working child: the whole branch stays with the living.
    expect(rowNamed("echo")).toBeDefined();
    expect(rowNamed("foxtrot")).toBeDefined();

    // Settled ones are behind the second fold and genuinely not rendered.
    expect(rowNamed("charlie")).toBeUndefined();
    expect(rowNamed("delta")).toBeUndefined();
    const finished = finishedFoldOf("Ship the release")!;
    expect(finished.textContent).toContain("2 finished");
    expect(finished.querySelector('[data-slot="finished-failed"]')?.textContent).toContain("1 failed");
    expect(finished.getAttribute("aria-expanded")).toBe("false");
    // Several branches can read "2 finished" at once, so the name says whose,
    // and says the failure out loud rather than only in red.
    expect(finished.getAttribute("aria-label")).toBe("Show the 2 finished agents under Ship the release, 1 failed");

    // No width-taking tag: the disclosure mark carries the most important
    // descendant state, and its own name/title spells out every count.
    expect(rowNamed("Ship the release")?.querySelector('[data-slot="session-children-chip"]')).toBeNull();
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");
    expect(parent.getAttribute("title")).toBe("6 agents under this session: 2 working, 1 needs you, 3 finished, 1 of them failed");
    expect(rowNamed("Ship the release")?.querySelector('[data-slot="aui_thread-list-item-trigger"]')?.getAttribute("title")).toContain("6 agents under this session: 2 working, 1 needs you, 3 finished, 1 of them failed");

    // Open it: the settled rows arrive, dimmed — except the failed one.
    await act(async () => finished.click());
    expect(finished.getAttribute("aria-expanded")).toBe("true");
    expect(finished.getAttribute("aria-label")).toBe("Hide the 2 finished agents under Ship the release, 1 failed");
    expect(rowNamed("charlie")?.getAttribute("data-dimmed")).toBe("true");
    expect(rowNamed("delta")?.getAttribute("data-run-status")).toBe("failed");
    expect(rowNamed("delta")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Failed");
    expect(rowNamed("delta")?.querySelector('[data-slot="run-state"]')).toBeNull();
    expect(rowNamed("delta")?.getAttribute("data-dimmed")).toBeNull();
  });

  // M13-T45: a child paused on a question is live and asking — it stays with
  // the living; its accessible dot pulses and the parent disclosure inherits it.
  it("keeps a child that is asking a question among the living and communicates it without a tag", async () => {
    await mount();
    const question = { id: "ui-1", kind: "select" as const, title: "Which token store?", options: ["cookie", "header"], askedAt: at(7) };
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "needs_input", question, updatedAt: at(7) } }));
    const alpha = rowNamed("alpha")!;
    expect(alpha.getAttribute("data-run-status")).toBe("needs_input");
    expect(alpha.querySelector('[data-slot="run-state"]')).toBeNull();
    const dot = alpha.querySelector('[data-slot="run-dot"]')!;
    expect(dot.getAttribute("aria-label")).toBe("Asking");
    expect(dot.className).toContain("animate-attention");
    expect(alpha.getAttribute("data-dimmed")).toBeNull();
    // Not folded away: the finished fold still holds only the two settled ones.
    expect(finishedFoldOf("Ship the release")?.textContent).toContain("2 finished");
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");
    expect(foldOf("Ship the release").getAttribute("title")).toBe("6 agents under this session: 1 working, 2 needs you, 3 finished, 1 of them failed");
    // Answered: the child dot returns to the working sweep; the parent's
    // attention mark remains because bravo still needs the person.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "running", updatedAt: at(8) } }));
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Working");
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");
  });

  it("rolls descendant attention into one compact disclosure mark", async () => {
    await mount();
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");

    // An error outranks simultaneous working children even when the failed run
    // is itself the parent of a still-running descendant (so its branch is live).
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[3]!, status: "completed", updatedAt: at(8) } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[4]!, status: "failed", updatedAt: at(8) } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[1]!, status: "completed", updatedAt: at(8) } }));
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("danger");

    // With that live-branch error gone, working wins; queued-only work is the muted wait.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[4]!, status: "completed", updatedAt: at(9) } }));
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("live");
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "queued", updatedAt: at(10) } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[5]!, status: "queued", updatedAt: at(10) } }));
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("muted");

    // Finished-only branches retain their fold summary, but need no state mark.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "completed", updatedAt: at(11) } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[5]!, status: "completed", updatedAt: at(11) } }));
    expect(foldStatusOf("Ship the release")).toBeNull();
    expect(foldOf("Ship the release").getAttribute("title")).toContain("6 finished");
  });

  it("keeps a settled child's unread session mark alongside its terminal run mark", async () => {
    await act(async () => store.dispatch({
      type: "sessions",
      sessions: sessions.map((session) => session.path === CHARLIE ? { ...session, attention: "finished_unread" as const } : session),
    }));
    await mount();
    const finished = finishedFoldOf("Ship the release")!;
    await act(async () => finished.click());
    const charlie = rowNamed("charlie")!;
    expect(charlie.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Done");
    expect(charlie.querySelector('[data-slot="status-dot"]')?.getAttribute("aria-label")).toBe("Finished, unread");
  });

  it("gives a childless row no disclosure or descendant-state mark", async () => {
    await mount();
    const quiet = branchOf("Quiet session")!;
    expect(quiet.querySelector('[data-slot="session-fold"]')).toBeNull();
    expect(quiet.querySelector('[data-slot="session-fold-status"]')).toBeNull();
    expect(quiet.querySelector('[data-slot="session-children"]')).toBeNull();
  });

  it("lands a settled parent on the finished summary rather than on an empty list", async () => {
    // Everything under the parent has settled: its fold is quiet by default,
    // and opening it shows what happened rather than nothing.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "cancelled" } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[1]!, status: "completed" } }));
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[5]!, status: "completed" } }));
    await mount();

    const parent = foldOf("Ship the release");
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("danger");
    expect(rowNamed("alpha")).toBeUndefined();

    await act(async () => parent.click());
    const finished = finishedFoldOf("Ship the release")!;
    expect(finished.textContent).toContain("6 finished");
    expect(names()).toEqual(["Ship the release", "Quiet session"]);
  });

  it("folds by pointer and by keyboard, hides the rows for real, and remembers the choice", async () => {
    await mount();
    const parent = foldOf("Ship the release");

    // Pointer.
    await act(async () => parent.click());
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(branchOf("Ship the release")!.querySelector('[data-slot="session-children"]')).toBeNull();
    expect(names()).toEqual(["Ship the release", "Quiet session"]);
    expect(parent.getAttribute("aria-label")).toBe("Show the 6 agents under Ship the release. 6 agents under this session: 2 working, 1 needs you, 3 finished, 1 of them failed");

    // What it says it controls is really there, really empty, and really hidden.
    const controlled = document.getElementById(parent.getAttribute("aria-controls")!)!;
    expect(controlled.hasAttribute("hidden")).toBe(true);
    expect(controlled.querySelectorAll('[data-slot="aui_thread-list-item"]')).toHaveLength(0);

    // Keyboard: a real button, focusable, activated by the click Enter and
    // Space produce, and it keeps focus across the toggle.
    expect(parent.tagName).toBe("BUTTON");
    parent.focus();
    expect(document.activeElement).toBe(parent);
    await act(async () => parent.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(parent);
    expect(rowNamed("alpha")).toBeDefined();

    // Remembered, per parent, across a remount.
    await act(async () => foldOf("Ship the release").click());
    expect(JSON.parse(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)!)).toEqual({ [`c:${ROOT}`]: false });
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a closed branch closed when new work starts under it, and never closes one that was open", async () => {
    await mount();
    await act(async () => foldOf("Ship the release").click());
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("false");

    // A default must not argue with a choice: new live work updates the folded
    // disclosure's summary and mark; it does not reopen the branch.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[2]!, status: "running", updatedAt: at(9) } }));
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("false");
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");

    // And the reverse: a run ending never collapses the branch under the
    // person — the child moves into the finished fold, the branch stays.
    await act(async () => foldOf("Ship the release").click());
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "completed", updatedAt: at(9) } }));
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("true");
    expect(rowNamed("alpha")).toBeUndefined();
    expect(finishedFoldOf("Ship the release")!.textContent).toContain("2 finished");
  });

  it("reveals the branch that holds the session being opened, and folding it keeps the selection", async () => {
    await mount();
    expect(finishedFoldOf("Ship the release")!.getAttribute("aria-expanded")).toBe("false");

    // Opening a settled child (from the map, a link, or a reload) opens every
    // fold between it and the top, so the person can see where they are.
    await act(async () => select(CHARLIE));
    expect(mainPath).toBe(CHARLIE);
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("true");
    expect(finishedFoldOf("Ship the release")!.getAttribute("aria-expanded")).toBe("true");
    expect(rowNamed("charlie")?.getAttribute("data-active")).toBe("true");
    // The open session stays legible inside the dimmed fold.
    expect(rowNamed("charlie")?.getAttribute("data-dimmed")).toBeNull();

    // Folding the branch is a view change, never a navigation.
    await act(async () => foldOf("Ship the release").click());
    expect(rowNamed("charlie")).toBeUndefined();
    expect(mainPath).toBe(CHARLIE);
  });

  it("never folds a search away: a query flattens the tree and every match is a row", async () => {
    // `ThreadList`'s own query path (docs: a match that hides under a
    // non-matching parent is a match you cannot see).
    await mount(<ThreadList projects={["/one"]} query="charlie" />);
    expect(names()).toEqual(["charlie"]);
    expect(container.querySelector('[data-slot="session-fold"]')).toBeNull();
    expect(container.querySelector('[data-slot="finished-fold"]')).toBeNull();
  });
});
