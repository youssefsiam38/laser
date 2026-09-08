// @vitest-environment happy-dom
/**
 * The sessions panel since the agents leap: Chat | Code tabs, the Beam group,
 * children nested under their parent on a lineage rail, the End agent row
 * action and the parent's children chip. Interaction tests through the DOM
 * over a real store (`LaserStoreProvider`) and a real remote thread list.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import type { SessionSummary } from "@lasercode/protocol";

import { SessionsPanel } from "../../src/components/shell/SessionsPanel.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { SESSIONS_TAB_STORAGE_KEY, sessionsList } from "../../src/components/shell/session-groups.js";
import { clearEndAgentRequest, useEndAgentRequest } from "../../src/components/agents/end-agent.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { toThreadMetadata } from "../../src/runtime/threadList.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { run, snapshot, summary } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({
  projects: ["/one", "/two"],
  currentProject: "/one",
  setCurrentProject: vi.fn(),
  actions: { toast: vi.fn(), removeProject: vi.fn(), newSession: vi.fn(async () => "/state/chat/new.jsonl"), openSession: vi.fn(async () => undefined) },
  archive: { add: vi.fn(), has: () => false },
  client: { request: vi.fn(async () => ({ hits: [], unreadable: 0 })) },
}));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

const ROOT = "/one/root.jsonl";
const CHILD = "/one/.worktrees/explorer/child.jsonl";
const GRANDCHILD = "/one/.worktrees/digger/grandchild.jsonl";
const DETACHED = "/one/.worktrees/orphan/orphan.jsonl";
const sessions: SessionSummary[] = [
  summary({ path: ROOT, cwd: "/one", name: "Ship the release", modifiedAt: "2026-09-08T03:00:00Z", attention: "working" }),
  summary({ path: "/one/older.jsonl", cwd: "/one", name: "Older work", modifiedAt: "2026-09-07T03:00:00Z" }),
  summary({ path: CHILD, cwd: "/one/.worktrees/explorer", name: "Counting files", modifiedAt: "2026-09-08T03:05:00Z", agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: ROOT, rootPath: ROOT, runId: "r1" } }),
  summary({ path: GRANDCHILD, cwd: "/one/.worktrees/digger", modifiedAt: "2026-09-08T03:06:00Z", agent: { agentName: "reviewer", kind: "child", subagentName: "digger", parentPath: CHILD, rootPath: ROOT, runId: "r2" } }),
  summary({ path: DETACHED, cwd: "/one/.worktrees/orphan", name: "Orphan", modifiedAt: "2026-09-08T02:00:00Z", agent: { agentName: "default", kind: "child", subagentName: "orphan", parentPath: "/one/gone.jsonl", rootPath: "/one/gone.jsonl", runId: "r3" } }),
  summary({ path: "/two/plain.jsonl", cwd: "/two", name: "Plain session", modifiedAt: "2026-09-06T03:00:00Z" }),
  summary({ path: "/state/beam/b1.jsonl", cwd: "/state/beam", name: "Why is the dock empty", modifiedAt: "2026-09-08T01:00:00Z", agent: { agentName: "beam", kind: "beam" } }),
  summary({ path: "/state/chat/c1.jsonl", cwd: "/state/chat", name: "Recipe ideas", modifiedAt: "2026-09-08T04:00:00Z", agent: { agentName: "chat", kind: "chat" } }),
  summary({ path: "/state/chat/c2.jsonl", cwd: "/state/chat", name: "Older chat", modifiedAt: "2026-09-05T04:00:00Z", agent: { agentName: "chat", kind: "chat" } }),
];
const runs = [
  run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", agentName: "default", projectCwd: "/one", rootSessionPath: ROOT, parent: { sessionPath: ROOT, sessionId: "root" }, status: "running", startedAt: "2026-09-08T03:04:00Z", updatedAt: "2026-09-08T03:04:00Z" }),
  run({ runId: "r2", sessionPath: GRANDCHILD, subagentName: "digger", projectCwd: "/one", rootSessionPath: ROOT, depth: 2, parent: { sessionPath: CHILD, sessionId: "child", runId: "r1" }, status: "completed", startedAt: "2026-09-08T03:05:30Z", updatedAt: "2026-09-08T03:06:00Z" }),
  run({ runId: "r3", sessionPath: DETACHED, subagentName: "orphan", agentName: "default", projectCwd: "/one", rootSessionPath: "/one/gone.jsonl", parent: { sessionPath: "/one/gone.jsonl", sessionId: "gone" }, status: "queued", startedAt: "2026-09-08T01:30:00Z", updatedAt: "2026-09-08T01:30:00Z" }),
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
  newSession: async () => {}, canCreate: true,
};
let endRequest: ReturnType<typeof useEndAgentRequest>;
function EndProbe() { endRequest = useEndAgentRequest(); return null; }
function Fixture({ store }: { store: StateStore }) {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return (
    <LaserStoreProvider store={store}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <ShellContext.Provider value={shell}>
            <SessionsPanel variant="panel" />
            <EndProbe />
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
  localStorage.clear();
  sessionsList.reset();
  clearEndAgentRequest();
  store = createStateStore(seed());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-popper-content-wrapper]").forEach((n) => n.remove());
});

const mount = async (node: ReactNode = <Fixture store={store} />) => act(async () => root.render(node));
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"]')];
const rowTitled = (text: string) => rows().find((row) => row.textContent?.includes(text));
const tab = (kind: "chat" | "code") => container.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${kind}"]`)!;
const openMenu = async (label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(trigger, label).not.toBeNull();
  await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return document.querySelector<HTMLElement>('[data-slot="aui_thread-list-item-more-content"]');
};

describe("sessions panel tabs", () => {
  it("opens on Code, switches to a flat Chat list on click and by keyboard, and remembers the choice", async () => {
    await mount();
    expect(tab("code").getAttribute("aria-selected")).toBe("true");
    expect(rowTitled("Ship the release")).toBeDefined();
    expect(rowTitled("Recipe ideas")).toBeUndefined();
    expect(container.querySelector('[data-slot="new-session"]')).not.toBeNull();

    await act(async () => tab("chat").click());
    expect(tab("chat").getAttribute("aria-selected")).toBe("true");
    expect(localStorage.getItem(SESSIONS_TAB_STORAGE_KEY)).toBe("chat");
    expect(container.querySelector('[data-slot="aui_thread-list-root"]')?.getAttribute("data-tab")).toBe("chat");
    // Flat, newest first, no folder header and no project rows.
    expect(rows().map((row) => row.textContent)).toEqual(["Recipe ideas", "Older chat"]);
    expect(container.querySelector('section[data-cwd] button[aria-controls$="-list"]')).toBeNull();
    expect(container.querySelector('[data-slot="new-chat"]')).not.toBeNull();
    expect(container.querySelector('input[type="search"]')?.getAttribute("placeholder")).toBe("Search chats");

    // The choice survives a remount.
    await act(async () => root.unmount());
    root = createRoot(container);
    sessionsList.reset();
    (sessionsList as unknown as { setTab(tab: "chat" | "code"): void }).setTab(localStorage.getItem(SESSIONS_TAB_STORAGE_KEY) === "chat" ? "chat" : "code");
    await mount();
    expect(tab("chat").getAttribute("aria-selected")).toBe("true");

    // Arrow keys move between the segments.
    tab("chat").focus();
    await act(async () => tab("chat").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(tab("code").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("code"));
    expect(rowTitled("Ship the release")).toBeDefined();
  });

  it("starts a new chat with the Chat agent in the Chat workspace", async () => {
    await mount();
    await act(async () => tab("chat").click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="new-chat"]')!.click());
    expect(stable.actions.newSession).toHaveBeenCalledWith("/state/chat", { agentName: "chat" });
  });
});

describe("Beam and children in the Code tab", () => {
  it("lists Beam as a spark-marked group after the projects and marks its rows", async () => {
    await mount();
    const groups = [...container.querySelectorAll<HTMLElement>("section[data-cwd]")];
    expect(groups.map((g) => g.dataset["kind"])).toEqual(["project", "project", "beam"]);
    const beam = groups.at(-1)!;
    expect(beam.querySelector('[data-slot="beam-mark"]')).not.toBeNull();
    expect(beam.querySelector('[aria-label^="New session in"]')).toBeNull();
    expect(beam.querySelector('[data-slot="beam-row-mark"]')).not.toBeNull();
    expect(container.querySelector('[data-cwd="/one"] [data-slot="beam-row-mark"]')).toBeNull();
  });

  it("nests a child under its parent on a lineage rail with its run status, and detaches an orphan", async () => {
    await mount();
    const parent = rowTitled("Ship the release")!;
    const branch = parent.closest('[data-slot="session-branch"]')!;
    const rail = branch.querySelector('[data-slot="session-children"]')!;
    expect(rail.className).toContain("border-s");
    const child = rail.querySelector<HTMLElement>('[data-slot="aui_thread-list-item"][data-child]')!;
    expect(child.querySelector('[data-slot="subagent-name"]')?.textContent).toBe("explorer");
    expect(child.textContent).toContain("Counting files");
    expect(child.querySelector('[data-slot="run-dot"]')?.getAttribute("data-run-status")).toBe("running");
    expect(child.querySelector('[data-slot="run-state"]')?.textContent).toBe("Working");
    // One step per depth: the grandchild sits inside the child's own rail.
    const innerRail = rail.querySelector('[data-slot="session-children"]')!;
    const grandchild = innerRail.querySelector('[data-slot="aui_thread-list-item"][data-child]')!;
    expect(grandchild.querySelector('[data-slot="subagent-name"]')?.textContent).toBe("digger");
    expect(grandchild.querySelector('[data-slot="run-state"]')).toBeNull();
    // The parent counts what is under it, running first.
    expect(parent.querySelector('[data-slot="session-children-chip"]')?.textContent).toBe("1 running");
    expect(child.querySelector('[data-slot="session-children-chip"]')?.textContent).toBe("1 agent");
    // A child whose parent is gone sits under Detached, in its project's group.
    const detached = container.querySelector('[data-cwd="/one"] [data-slot="detached-sessions"]')!;
    expect(detached.textContent).toContain("Detached");
    expect(detached.querySelector('[data-slot="subagent-name"]')?.textContent).toBe("orphan");
    expect(detached.querySelector('[aria-label="Why detached?"]')).not.toBeNull();
    // The worktree directories never become groups of their own.
    expect(container.querySelector('[data-cwd="/one/.worktrees/explorer"]')).toBeNull();
  });

  it("offers End agent only while the child's run is going, and asks the shared dialog with the run id", async () => {
    await mount();
    let menu = await openMenu("Actions for explorer");
    expect(menu?.textContent).toContain("Open");
    const end = menu?.querySelector<HTMLElement>('[data-slot="end-agent-item"]');
    expect(end).not.toBeNull();
    await act(async () => end!.click());
    expect(endRequest?.runId).toBe("r1");
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    // The run ends: the item goes, the chip and the state word settle.
    await act(async () => store.dispatch({ type: "agents/run", run: { ...runs[0]!, status: "completed", updatedAt: "2026-09-08T03:30:00Z", endedAt: "2026-09-08T03:30:00Z" } }));
    expect(rowTitled("Ship the release")?.querySelector('[data-slot="session-children-chip"]')?.textContent).toBe("1 agent");
    expect(rowTitled("Counting files")?.querySelector('[data-slot="run-state"]')).toBeNull();
    menu = await openMenu("Actions for explorer");
    expect(menu?.querySelector('[data-slot="end-agent-item"]')).toBeNull();
    expect(menu?.textContent).toContain("Copy path");
    expect(menu?.textContent).not.toContain("Pin chat");
  });
});
