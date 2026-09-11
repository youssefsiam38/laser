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

// One parent with every state under it at once: two working, one blocked, one
// done, one failed, and one that is itself blocked but still has a working
// child — the branch that must not be filed away as finished.
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
  childRun("echo", ECHO, "blocked", 5),
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
/** Every activity indicator a row wears, in DOM order. One row, one mark (M15-T4). */
const marksOf = (text: string) =>
  [...rowNamed(text)!.querySelectorAll<HTMLElement>('[data-slot="run-dot"], [data-slot="status-dot"], [data-slot="session-working"]')];

describe("sub-sessions fold", () => {
  it("opens a parent with live work, keeps the settled ones behind a second fold, and counts both without opening either", async () => {
    await mount();

    // Live children, in start order, directly under the parent.
    const parent = foldOf("Ship the release");
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(parent.getAttribute("aria-label")).toBe("Hide the 6 agents under Ship the release. 6 agents under this session: 2 working, 4 finished, 1 of them failed");
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Working");
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-state"]')).toBeNull();
    // Blocked is terminal, so it is hidden with the other finished rows.
    expect(rowNamed("bravo")).toBeUndefined();
    // Blocked, but with a working child: the whole branch stays with the living.
    expect(rowNamed("echo")).toBeDefined();
    expect(rowNamed("foxtrot")).toBeDefined();

    // Settled ones are behind the second fold and genuinely not rendered.
    expect(rowNamed("charlie")).toBeUndefined();
    expect(rowNamed("delta")).toBeUndefined();
    const finished = finishedFoldOf("Ship the release")!;
    expect(finished.textContent).toContain("3 finished");
    expect(finished.querySelector('[data-slot="finished-failed"]')?.textContent).toContain("1 failed");
    expect(finished.getAttribute("aria-expanded")).toBe("false");
    // Several branches can read "3 finished" at once, so the name says whose,
    // and says the failure out loud rather than only in red.
    expect(finished.getAttribute("aria-label")).toBe("Show the 3 finished agents under Ship the release, 1 failed");

    // No width-taking tag, and no descendant state on the parent: a failure
    // below is counted in the disclosure's own name/title, not worn by a row
    // that did not fail (M15-T4).
    expect(rowNamed("Ship the release")?.querySelector('[data-slot="session-children-chip"]')).toBeNull();
    expect(foldStatusOf("Ship the release")).toBeNull();
    expect(parent.getAttribute("title")).toBe("6 agents under this session: 2 working, 4 finished, 1 of them failed");
    expect(rowNamed("Ship the release")?.querySelector('[data-slot="aui_thread-list-item-trigger"]')?.getAttribute("title")).toContain("6 agents under this session: 2 working, 4 finished, 1 of them failed");

    // Open it: the settled rows arrive, dimmed — except the failed one.
    await act(async () => finished.click());
    expect(finished.getAttribute("aria-expanded")).toBe("true");
    expect(finished.getAttribute("aria-label")).toBe("Hide the 3 finished agents under Ship the release, 1 failed");
    expect(rowNamed("bravo")?.getAttribute("data-dimmed")).toBe("true");
    expect(rowNamed("bravo")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Blocked");
    expect(rowNamed("bravo")?.querySelector('[data-slot="run-dot"]')?.className).not.toContain("animate-attention");
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
    // Not folded away: the finished fold still holds the three terminal siblings.
    expect(finishedFoldOf("Ship the release")?.textContent).toContain("3 finished");
    // The children are on screen wearing their own marks, so the parent says
    // nothing (M15-T4) — until the branch is folded and the question would be
    // hidden, which is the one state that must still reach the person.
    expect(foldStatusOf("Ship the release")).toBeNull();
    await act(async () => foldOf("Ship the release").click());
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("attention");
    expect(foldOf("Ship the release").getAttribute("title")).toBe("6 agents under this session: 1 working, 1 needs you, 4 finished, 1 of them failed");
    await act(async () => foldOf("Ship the release").click());
    // Answered: the child dot returns to the working sweep, and the folded
    // branch falls back to the failure it is still hiding — never to the
    // working child, which is one disclosure away.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "running", updatedAt: at(8) } }));
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Working");
    await act(async () => foldOf("Ship the release").click());
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("danger");
  });

  it("returns a resumed session to the live fold and does not brand it with an older failure", async () => {
    await mount();
    // The session's own run fails; a resume is a new run in the same session.
    // A session never holds two runs that can act at once (the harness ends
    // one before it starts the next, and a successor waits as `queued`), so
    // the older failure is the session's earlier run, ended, not a sibling.
    const failed: AgentRun = { ...runs[0]!, status: "failed", updatedAt: at(12), endedAt: at(12), error: "Provider disconnected." };
    const resumed = childRun("alpha-resumed", ALPHA, "running", 13);

    await act(async () => store.dispatch({ type: "agents/run", run: failed }));
    await act(async () => store.dispatch({ type: "agents/run", run: resumed }));
    const active = rowNamed("alpha")!;
    expect(active.getAttribute("data-run-status")).toBe("running");
    expect(active.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Working");
    expect(active.getAttribute("data-dimmed")).toBeNull();

    // The same resumed run ends normally. Its older failure remains in the run
    // registry, but the session now stands on this canonical newest outcome.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...resumed, status: "completed", updatedAt: at(14), endedAt: at(14), result: { status: "completed", message: "Recovered." } } }));
    expect(rowNamed("alpha")).toBeUndefined();
    const finished = finishedFoldOf("Ship the release")!;
    await act(async () => finished.click());
    expect(rowNamed("alpha")?.getAttribute("data-run-status")).toBe("completed");
    expect(rowNamed("alpha")?.querySelector('[data-slot="run-dot"]')?.getAttribute("aria-label")).toBe("Done");
  });

  // M15-T4: a folded branch keeps exactly one descendant signal — a question.
  // Everything else a descendant is doing stays with the descendant.
  it("marks a folded branch for a question or a failure, never for work below it", async () => {
    await mount();
    await act(async () => foldOf("Ship the release").click());
    // A failure is hidden two folds deep in there, so the disclosure keeps it
    // — still, not pulsing: nothing is happening (D-186).
    const failure = foldStatusOf("Ship the release")!;
    expect(failure.getAttribute("data-tone")).toBe("danger");
    expect(failure.className).not.toContain("animate-attention");
    expect(failure.style.getPropertyValue("--dot")).toBe("var(--danger)");
    expect(foldOf("Ship the release").getAttribute("title")).toBe("6 agents under this session: 2 working, 4 finished, 1 of them failed");

    // With the failure gone, working and waiting children below say nothing
    // for the parent: that work is one disclosure away, on the rows doing it.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[3]!, status: "completed", updatedAt: at(9) } }));
    expect(foldStatusOf("Ship the release")).toBeNull();
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "queued", updatedAt: at(9) } }));
    expect(foldStatusOf("Ship the release")).toBeNull();

    // A child paused on a question: the mark appears, pulsing, and the counts
    // stay in the accessible name so the reason is spoken too.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[5]!, status: "needs_input", updatedAt: at(10) } }));
    const mark = foldStatusOf("Ship the release")!;
    expect(mark.getAttribute("data-tone")).toBe("attention");
    expect(mark.className).toContain("motion-safe:animate-attention");
    expect(foldOf("Ship the release").getAttribute("aria-label")).toContain("1 needs you");

    // Opened, the asking grandchild is reachable, so the parent stops speaking
    // for it — but the child that still hides it keeps the mark.
    await act(async () => foldOf("Ship the release").click());
    expect(foldStatusOf("Ship the release")).toBeNull();
    expect(foldOf("echo").getAttribute("aria-expanded")).toBe("true");
    await act(async () => foldOf("echo").click());
    expect(foldStatusOf("echo")?.getAttribute("data-tone")).toBe("attention");
  });

  it("gives a settled child one mark: the session's own unread state, not a second dot", async () => {
    await act(async () => store.dispatch({
      type: "sessions",
      sessions: sessions.map((session) => session.path === CHARLIE ? { ...session, attention: "finished_unread" as const } : session),
    }));
    await mount();
    const finished = finishedFoldOf("Ship the release")!;
    await act(async () => finished.click());
    // One indicator, before the name: the unread session outranks "Done",
    // which the finished fold already counts (M15-T4).
    expect(marksOf("charlie").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Finished, unread"]);
    // A settled child with nothing else to say still shows its run's outcome,
    // so a failure inside the fold is findable.
    expect(marksOf("delta").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Failed"]);
  });

  // A run that has just failed almost always leaves its session unread, and
  // `finished_unread` is drawn in the live colour: letting unread win there
  // would paint a failure green until someone happened to open it.
  it("keeps the failure mark on a failed child that is also unread", async () => {
    await act(async () => store.dispatch({
      type: "sessions",
      sessions: sessions.map((session) => session.path === DELTA ? { ...session, attention: "finished_unread" as const } : session),
    }));
    await mount();
    await act(async () => finishedFoldOf("Ship the release")!.click());
    const delta = rowNamed("delta")!;
    expect(marksOf("delta").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Failed"]);
    expect(marksOf("delta")[0]!.style.getPropertyValue("--dot")).toBe("var(--danger)");
    // And it keeps its ink inside the dimmed fold, as a failure always has.
    expect(delta.getAttribute("data-dimmed")).toBeNull();

    // A child that failed and *is* waiting for the person still says so: a
    // live question outranks a finished failure.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[3]!, status: "needs_input", updatedAt: at(9) } }));
    expect(marksOf("delta").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Asking"]);
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
    // Two folds deep, one of them failed: the only trace is this mark.
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
    expect(parent.getAttribute("aria-label")).toBe("Show the 6 agents under Ship the release. 6 agents under this session: 2 working, 4 finished, 1 of them failed");

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
    // The new live work adds nothing to the disclosure; the hidden failure is
    // what it was already carrying.
    expect(foldStatusOf("Ship the release")?.getAttribute("data-tone")).toBe("danger");

    // And the reverse: a run ending never collapses the branch under the
    // person — the child moves into the finished fold, the branch stays.
    await act(async () => foldOf("Ship the release").click());
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "completed", updatedAt: at(9) } }));
    expect(foldOf("Ship the release").getAttribute("aria-expanded")).toBe("true");
    expect(rowNamed("alpha")).toBeUndefined();
    expect(finishedFoldOf("Ship the release")!.textContent).toContain("3 finished");
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

/**
 * M15-T4. One row, one activity indicator, before the name, saying what that
 * session is doing — never what something under it is doing, and never a
 * second mark at the row's end.
 */
describe("one indicator per row", () => {
  /** The catalog with the given sessions' attention set and every other one idle. */
  const withAttention = (overrides: Readonly<Record<string, SessionSummary["attention"]>>): SessionSummary[] =>
    sessions.map((session) => {
      const attention = overrides[session.path];
      if (attention !== undefined) return { ...session, attention };
      const { attention: _idle, ...rest } = session;
      return rest;
    });
  const setAttention = (overrides: Readonly<Record<string, SessionSummary["attention"]>>) =>
    act(async () => store.dispatch({ type: "sessions", sessions: withAttention(overrides) }));
  const labelsOf = (text: string) => marksOf(text).map((mark) => mark.getAttribute("aria-label"));

  it("gives a working session one mark before its name and nothing at the row's end", async () => {
    await setAttention({ [QUIET]: "working" });
    await mount();
    const row = rowNamed("Quiet session")!;
    const marks = marksOf("Quiet session");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("aria-label")).toBe("Working");
    expect(marks[0]!.getAttribute("data-status")).toBe("working");
    // Before the name, not after it.
    const title = row.querySelector('[data-slot="aui_thread-list-item-title"]')!;
    expect(marks[0]!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The trailing spinner is gone from the whole list, in every state.
    expect(container.querySelector('[data-slot="session-working"]')).toBeNull();
    // Unread, waiting and error keep the same single leading position.
    await setAttention({ [QUIET]: "waiting_for_input" });
    expect(labelsOf("Quiet session")).toEqual(["Waiting for you"]);
    await setAttention({ [QUIET]: "finished_unread" });
    expect(labelsOf("Quiet session")).toEqual(["Finished, unread"]);
    await setAttention({ [QUIET]: "error" });
    expect(labelsOf("Quiet session")).toEqual(["Error"]);
    await setAttention({});
    expect(labelsOf("Quiet session")).toEqual([]);
  });

  it("never makes a parent look busy because a child is", async () => {
    await setAttention({});
    // Nothing failed under this parent: the only hidden state is live work.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[3]!, status: "completed", updatedAt: at(9) } }));
    await mount();
    // alpha is running under it; the parent itself is doing nothing.
    expect(labelsOf("Ship the release")).toEqual([]);
    expect(foldStatusOf("Ship the release")).toBeNull();
    expect(labelsOf("alpha")).toEqual(["Working"]);

    // Folding the working child away does not move its state onto the parent.
    await act(async () => foldOf("Ship the release").click());
    expect(labelsOf("Ship the release")).toEqual([]);
    expect(foldStatusOf("Ship the release")).toBeNull();

    // The parent's own work is its own: it speaks for that, and only that.
    await setAttention({ [ROOT]: "working" });
    expect(labelsOf("Ship the release")).toEqual(["Working"]);
  });

  it("gives a child with a child of its own exactly one mark: its own", async () => {
    await setAttention({});
    await mount();
    // echo is paused, foxtrot is working under it. Each row says its own state.
    expect(labelsOf("echo")).toEqual(["Blocked"]);
    expect(labelsOf("foxtrot")).toEqual(["Working"]);
    expect(foldStatusOf("echo")).toBeNull();

    // A grandchild that starts working changes the grandchild's row, nothing above it.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[4]!, status: "running", updatedAt: at(9) } }));
    expect(labelsOf("echo")).toEqual(["Working"]);
    expect(labelsOf("Ship the release")).toEqual([]);
    await act(async () => foldOf("echo").click());
    expect(foldStatusOf("echo")).toBeNull();
  });

  it("keeps colour and accessible names when motion is switched off", async () => {
    await setAttention({ [QUIET]: "working" });
    await mount();
    const working = marksOf("Quiet session")[0]!;
    expect(working.getAttribute("aria-label")).toBe("Working");
    expect(working.style.getPropertyValue("--dot")).toBe("var(--live)");
    // The sweep is the only thing reduced motion loses.
    const sweep = working.querySelector("span")!;
    expect(sweep.className).toContain("motion-safe:animate-sweep");
    expect(sweep.className).toContain("motion-reduce:hidden");

    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "needs_input", updatedAt: at(9) } }));
    const asking = marksOf("alpha")[0]!;
    expect(asking.getAttribute("aria-label")).toBe("Asking");
    expect(asking.className).toContain("motion-safe:animate-attention");
    expect(asking.style.getPropertyValue("--dot")).toBe("var(--attention)");

    // Folded, the question's mark is the same motion-gated colour, and the
    // counts stay in words on the disclosure.
    await act(async () => foldOf("Ship the release").click());
    const folded = foldStatusOf("Ship the release")!;
    expect(folded.className).toContain("motion-safe:animate-attention");
    expect(folded.style.getPropertyValue("--dot")).toBe("var(--attention)");
    expect(foldOf("Ship the release").getAttribute("aria-label")).toContain("1 needs you");
  });
});
