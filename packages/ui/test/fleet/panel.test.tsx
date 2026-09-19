// @vitest-environment happy-dom
/**
 * The fleet column, as a person meets it: two kinds of work in one list, a row
 * that opens in place, "Open chat" that navigates, Stop that ends a task, and
 * an empty state that is a real state.
 *
 * Since M13-T51 the column is the open session's tree, so the second half
 * covers scope: two roots and only the open one's work, a child open with its
 * root's tree around it, no session open, and work whose session was deleted.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { humanizeLabel, type BackgroundTask } from "@lasercode/protocol";

import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { resetFleetState, revealInFleet } from "../../src/fleet/fleet-state.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { run, summary, view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

const ROOT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";
const OTHER = "/p/other.jsonl";
const OTHER_CHILD = "/p/other-child.jsonl";
const GONE = "/p/gone.jsonl";
const GONE_CHILD = "/p/gone-child.jsonl";

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm vite dev --host",
  title: "pnpm vite dev --host",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 11,
  activity: "ready in 412 ms",
  ...over,
});

const child = run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router" });
const otherChild = run({ runId: "r2", sessionPath: OTHER_CHILD, subagentName: "reviewer", task: "Review the diff", rootSessionPath: OTHER, parent: { sessionPath: OTHER, sessionId: "other" } });
const strayChild = run({ runId: "r3", sessionPath: GONE_CHILD, subagentName: "stray", task: "Keep going", rootSessionPath: GONE, parent: { sessionPath: GONE, sessionId: "gone" } });

const fixture = vi.hoisted(() => ({
  state: {
    current: "/p/root.jsonl" as string | undefined,
    sessions: [] as unknown[],
    sessionsLoaded: true,
    open: {} as Record<string, unknown>,
    agents: { runs: {} as Record<string, unknown> },
    tasks: { tasks: {} as Record<string, unknown>, listed: [] as string[] },
  },
  actions: {
    openSession: vi.fn(async () => undefined),
    toast: vi.fn(),
    tasks: {
      stop: vi.fn(async () => undefined),
      list: vi.fn(async () => undefined),
      output: vi.fn(async (_path = "", _id = "", from = 0) => ({ id: "t1", from, bytes: 11, chunk: "ready in 412 ms", eof: true })),
    },
  },
  endAgent: vi.fn(),
  removeWorktree: vi.fn(),
  request: vi.fn(),
  openChanges: vi.fn(),
}));

vi.mock("@/source-control/store.js", () => ({
  openChanges: (...args: unknown[]) => fixture.openChanges(...args),
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserState: (selector: (s: unknown) => unknown) => selector(fixture.state),
  useLaserStable: () => ({ actions: fixture.actions, client: { request: fixture.request } }),
}));
vi.mock("@/components/agents/end-agent", () => ({ requestEndAgent: fixture.endAgent }));
vi.mock("@/agents/worktree", () => ({ requestRemoveWorktree: fixture.removeWorktree }));

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetFleetState();
  fixture.state.current = ROOT;
  fixture.state.sessions = [summary({ path: ROOT, name: "Root session" }), summary({ path: CHILD })];
  fixture.state.open = { [ROOT]: view({ path: ROOT }) };
  fixture.state.agents.runs = {};
  fixture.state.tasks.tasks = {};
  for (const spy of [fixture.actions.openSession, fixture.actions.tasks.stop, fixture.actions.tasks.output, fixture.endAgent, fixture.removeWorktree, fixture.request, fixture.openChanges]) spy.mockClear();
  store = createStateStore({ ...initialState, environment: testDescriptor() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (): Promise<void> => {
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><FleetPanel variant="panel" /></TooltipProvider></LaserStoreProvider>));
};
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')];
const rowFor = (title: string): HTMLElement => rows().find((row) => row.textContent?.includes(humanizeLabel(title)))!;
const section = (name: "active" | "finished", within: ParentNode = container): HTMLElement =>
  within.querySelector<HTMLElement>(`[data-slot="fleet-group"][data-section="${name}"]`)!;
const rowIn = (within: ParentNode, title: string): HTMLElement =>
  [...within.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')].find((row) => row.textContent?.includes(humanizeLabel(title)))!;
const terminalBlock = (title: string): HTMLElement => rowFor(title).querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
/** Work that has ended is folded away; open the fold to read it. */
const openFinished = async (): Promise<void> => {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Finished"))!.click());
};

describe("the fleet column", () => {
  it("keeps fleet reads but hides every denied stop and worktree mutation", async () => {
    store.dispatch({ type: "environment", environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] }) });
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    expect(container.textContent).toContain("Explorer");
    expect(container.textContent).toContain("pnpm vite dev");
    for (const row of rows()) await act(async () => row.querySelector<HTMLButtonElement>("button")?.click());
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/End agent|Stop command|Remove worktree/);
    expect(fixture.actions.tasks.stop).not.toHaveBeenCalled();
    expect(fixture.endAgent).not.toHaveBeenCalled();
    expect(fixture.removeWorktree).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("draws an empty state that says what would fill it", async () => {
    await render();
    expect(container.textContent).toContain("Nothing is running here");
    expect(container.textContent).toContain("appear here");
    expect(container.textContent).toContain("nothing here yet");
    expect(rows()).toHaveLength(0);
  });

  it("lists agent runs and background commands together, under their session", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Root session");
    const kinds = rows().map((row) => [row.getAttribute("data-kind"), row.querySelector("span")?.parentElement?.textContent]);
    expect(kinds.map(([kind]) => kind)).toEqual(["agent", "task"]);
    // The command is inside the agent's branch: it is that agent's command.
    expect(rowFor("explorer").parentElement?.querySelector('[data-slot="fleet-row"][data-kind="task"]')).not.toBeNull();
    // A live row says what it is doing, in the work's own words.
    expect(rowFor("pnpm vite dev").textContent).toContain("ready in 412 ms");
    expect(container.textContent).toContain("2 going");
  });

  it("moves an ended command to Finished immediately under a context copy of its still-working agent", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    expect(rowIn(section("active"), "explorer").getAttribute("data-context")).toBeNull();
    expect(rowIn(section("active"), "pnpm vite dev")).toBeDefined();
    expect(container.querySelector('[data-slot="fleet-clear-finished"]')).toBeNull();

    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:04:00.000Z" }),
    };
    await render();
    const active = section("active");
    expect(rowIn(active, "explorer")).toBeDefined();
    expect([...active.querySelectorAll('[data-slot="fleet-row"]')]).toHaveLength(1);
    expect(container.querySelector('[data-slot="subagent-list"]')?.textContent).toContain("Finished1");

    await openFinished();
    const finished = section("finished");
    const context = rowIn(finished, "explorer");
    expect(context.getAttribute("data-context")).toBe("true");
    expect(context.getAttribute("data-state")).toBe("running");
    expect(context.getAttribute("data-attention")).toBe("finished_unread");
    expect(context.querySelector('[data-slot="status-dot"]')?.getAttribute("aria-label")).toMatch(/below/);
    expect(context.textContent).toContain("context");
    expect(context.textContent).toContain("Parent of work shown here.");
    expect(context.textContent).not.toContain("ready in 412 ms");
    expect(rowIn(finished, "pnpm vite dev").getAttribute("data-context")).toBeNull();
    // The duplicated ancestor is context only: exactly one terminal item is counted.
    expect(container.querySelector('[data-slot="subagent-list"]')?.textContent).toContain("Finished1");
  });

  it("scopes disclosure to one projected copy of a duplicated agent key", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:04:00.000Z" }),
    };
    await render();
    await openFinished();
    const activeAgent = rowIn(section("active"), "explorer");
    const finishedContext = rowIn(section("finished"), "explorer");

    await act(async () => activeAgent.querySelector("button")!.click());
    expect(activeAgent.getAttribute("data-expanded")).toBe("true");
    expect(finishedContext.getAttribute("data-expanded")).toBeNull();
    await act(async () => finishedContext.querySelector("button")!.click());
    expect(activeAgent.getAttribute("data-expanded")).toBeNull();
    expect(finishedContext.getAttribute("data-expanded")).toBe("true");
    expect([...finishedContext.querySelectorAll("dt")].map((field) => field.textContent)).not.toContain("Elapsed");
    expect(container.querySelectorAll('[data-slot="fleet-row"][data-expanded="true"]')).toHaveLength(1);
  });

  it("follows an expanded actual row to Finished when it becomes terminal and leaves context behind", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    const activeAgent = rowIn(section("active"), "explorer");
    await act(async () => activeAgent.querySelector("button")!.click());
    expect(activeAgent.getAttribute("data-expanded")).toBe("true");

    fixture.state.agents.runs = {
      r1: { ...child, status: "completed", endedAt: "2026-09-08T10:04:00.000Z" },
    };
    await render();
    const activeContext = rowIn(section("active"), "explorer");
    const finishedAgent = rowIn(section("finished"), "explorer");
    expect(activeContext.getAttribute("data-context")).toBe("true");
    expect(activeContext.getAttribute("data-expanded")).toBeNull();
    expect(rowIn(section("active"), "pnpm vite dev")).toBeDefined();
    expect(finishedAgent.getAttribute("data-context")).toBeNull();
    expect(finishedAgent.getAttribute("data-expanded")).toBe("true");
    expect(container.querySelectorAll('[data-slot="fleet-row"][data-expanded="true"]')).toHaveLength(1);
  });

  it("opens one row at a time, in place, and closes it again", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    expect(rowFor("explorer").getAttribute("data-expanded")).toBeNull();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").getAttribute("data-expanded")).toBe("true");
    expect(rowFor("explorer").textContent).toContain("Read the router");
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").getAttribute("data-expanded")).toBeNull();
    // Collapsed really hides: the detail is gone from the DOM, not merely
    // unseen. Line 2 is never the task brief — a run with no activity says nothing there.
    expect(rowFor("explorer").querySelector("dl")).toBeNull();
    expect(rowFor("explorer").textContent).not.toContain("Read the router");
  });

  it("names the branch of an agent that has a worktree", async () => {
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", worktree: { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc" }, cwd: "/p/.worktrees/explorer-1" }),
    };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").textContent).toContain("Worktree");
    expect(rowFor("explorer").textContent).toContain("agents/explorer-1");
  });

  // M13-T42: the parent owns merging and removing a child's worktree. A parent
  // that crashed or was cancelled never does, so a person can clear it here —
  // without deleting the conversation.
  it("never offers to remove the worktree an agent is still working in", async () => {
    const worktree = { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc" };
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", worktree, cwd: worktree.path }),
    };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    // Ending it is the question here, not removing the files under its feet.
    const labels = [...rowFor("explorer").querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((text) => text.includes("Remove worktree"))).toBe(false);
    expect(labels.some((text) => text.includes("End agent"))).toBe(true);
  });

  it("offers to clear a finished agent's leftover worktree without deleting its session", async () => {
    const worktree = { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc" };
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", worktree, cwd: worktree.path, status: "completed", endedAt: "2026-09-08T10:05:00.000Z" }),
    };
    await render();
    await openFinished();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    const remove = [...rowFor("explorer").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Remove worktree"))!;
    expect(remove).toBeDefined();
    await act(async () => remove.click());
    expect(fixture.removeWorktree).toHaveBeenCalledWith(CHILD, "Explorer");
  });

  // M16-T48 / review #49: what these two buttons do not say in their own
  // words used to live in a native `title`, which never opened for the
  // keyboard and never opened for a finger.
  it("explains its two least obvious buttons in the app's tooltip, reachable by focus", async () => {
    const worktree = { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc" };
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", worktree, cwd: worktree.path, status: "completed", endedAt: "2026-09-08T10:05:00.000Z" }),
    };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    await openFinished();

    const tooltips = () => [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((n) => n.textContent ?? "").join(" ");
    const focusIn = async (row: string, label: string) => {
      await act(async () => rowFor(row).querySelector("button")!.click());
      const button = [...rowFor(row).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label))!;
      expect(button.getAttribute("title")).toBeNull();
      await act(async () => button.focus());
      const text = tooltips();
      await act(async () => button.blur());
      return text;
    };

    expect(await focusIn("pnpm vite dev", "Open its session")).toContain("The session whose agent ran this command");
    expect(await focusIn("explorer", "Remove worktree")).toContain("Its parent owns this worktree");
  });

  it("says a removed worktree is removed rather than offering a path that is gone", async () => {
    fixture.state.agents.runs = {
      r1: run({
        runId: "r1",
        sessionPath: CHILD,
        subagentName: "explorer",
        task: "Read the router",
        status: "completed",
        endedAt: "2026-09-08T10:05:00.000Z",
        worktree: { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc", removedAt: "2026-09-08T11:00:00.000Z" },
      }),
    };
    await render();
    await openFinished();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").textContent).toContain("agents/explorer-1");
    expect(rowFor("explorer").textContent).toContain("Removed.");
    expect(rowFor("explorer").textContent).not.toContain("/p/.worktrees/explorer-1");
    expect([...rowFor("explorer").querySelectorAll("button")].some((b) => b.textContent?.includes("Remove worktree"))).toBe(false);
  });

  it("names the directory of an agent that has none, instead of an empty branch row", async () => {
    fixture.state.agents.runs = { r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", cwd: "/p" }) };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").textContent).not.toContain("Worktree");
    expect(rowFor("explorer").textContent).toContain("Working in");
    expect(rowFor("explorer").textContent).toContain("Shares its parent’s checkout");
  });

  it("says nothing at all for a run recorded before runs carried a directory", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").querySelector("dl")).not.toBeNull();
    expect(rowFor("explorer").textContent).not.toContain("Worktree");
    expect(rowFor("explorer").textContent).not.toContain("Working in");
  });

  it("folds a blocked run into neutral Finished history with no attention count or pulse", async () => {
    fixture.state.agents.runs = {
      r1: {
        ...child,
        status: "blocked",
        endedAt: "2026-09-08T10:04:00.000Z",
        result: { status: "blocked", message: "The schema owner must choose." },
      },
    };
    await render();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("Nothing is in progress.");
    expect(container.querySelector('[data-slot="fleet-summary"]')?.textContent).toBe("all finished");
    expect(container.textContent).not.toContain("needs you");
    await openFinished();
    const row = rowFor("explorer");
    expect(row.getAttribute("data-state")).toBe("blocked");
    expect(row.querySelector('[data-slot="fleet-headline"]')?.textContent).toContain("The schema owner must choose.");
    expect(row.querySelector('[data-slot="status-dot"]')?.getAttribute("data-status")).toBe("idle");
    expect(row.querySelector('[data-slot="status-dot"]')?.className).not.toContain("animate-attention");
  });

  // M13-T45: a child paused on a question is live and asking — the row says
  // so, the question is its one line, and the detail carries it whole.
  it("shows an agent paused on a question as Asking, with the question and its choices, and still offers to end it", async () => {
    fixture.state.agents.runs = {
      r1: {
        ...child,
        status: "needs_input",
        activity: { turns: 2, tools: 3, currentTool: "ask_person", lastAt: "2026-09-08T10:04:00.000Z" },
        question: { id: "ui-1", kind: "select", title: "Which token store?", detail: undefined, options: ["cookie", "header"], askedAt: "2026-09-08T10:04:00.000Z" },
      },
    };
    await render();
    const row = rowFor("explorer");
    expect(row.getAttribute("data-state")).toBe("needs_input");
    expect(row.querySelector('[data-slot="status-dot"]')?.getAttribute("data-status")).toBe("waiting_for_input");
    expect(row.querySelector('[data-slot="status-dot"]')?.getAttribute("aria-label")).toBe("Asking");
    expect(row.querySelector('[data-slot="fleet-headline"]')?.textContent).toContain("Which token store?");
    expect(row.querySelector('[data-slot="fleet-answer"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="fleet-open-chat"]')).not.toBeNull();
    expect(row.textContent).not.toContain("Running ask_person");
    expect(container.textContent).toContain("1 needs you");
    await act(async () => row.querySelector("button")!.click());
    const question = row.querySelector('[data-slot="fleet-question"]');
    expect(question?.textContent).toBe("Which token store?");
    expect(row.querySelector("dl")?.textContent).toContain("Choices: cookie · header");
    expect(row.querySelector("dl")?.textContent).toContain("Answer it in its chat, or its parent can.");
    // Nothing has ended: no "Ended" row, and End agent is still offered.
    expect(row.querySelector("dl")?.textContent).not.toContain("Ended");
    expect([...row.querySelectorAll<HTMLButtonElement>("button")].some((b) => b.textContent?.includes("End agent"))).toBe(true);
  });

  it("navigates to a run's chat and asks the one End agent question", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    const buttons = [...rowFor("explorer").querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => buttons.find((b) => b.textContent?.includes("Open chat"))!.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
    await act(async () => buttons.find((b) => b.textContent?.includes("End agent"))!.click());
    expect(fixture.endAgent).toHaveBeenCalledWith("r1");
  });

  it("does not promise a command a chat it has not got", async () => {
    fixture.state.agents.runs = { r1: child };
    // The child's command: its session is the child's, which is not the chat
    // being read, so there is somewhere to go (a command in the open session
    // says so instead — see the M13-T51 tests below).
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    // One row opens at a time, so each kind is asked its own question.
    const labels = async (name: string) => {
      await act(async () => rowFor(name).querySelector("button")!.click());
      return [...rowFor(name).querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");
    };
    // An agent has a chat of its own; a command only has the session whose
    // agent ran it, and the two must never converge on one label again.
    expect((await labels("explorer")).some((text) => text.includes("Open chat"))).toBe(true);
    expect((await labels("pnpm vite dev")).some((text) => text.includes("Open chat"))).toBe(false);
    const open = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Open its session"),
    )!;
    await act(async () => open.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
  });

  it("says a command in the open session has nowhere else to go", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const labels = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");
    expect(labels.some((text) => text.includes("Open its session"))).toBe(false);
    expect(rowFor("pnpm vite dev").querySelector('[data-slot="fleet-here"]')?.textContent).toBe("Its session is the chat you are reading.");
    expect(labels.some((text) => text.includes("Stop"))).toBe(true);
  });

  it("draws no way in when the work's session is gone from the catalog", async () => {
    fixture.state.sessions = [summary({ path: CHILD })];
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const labels = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");
    // A button that navigates nowhere is the defect this column inherited from
    // the panels (M13-T25). Stop still shows: it does not need the session.
    expect(labels.some((text) => text.includes("Open its session"))).toBe(false);
    expect(labels.some((text) => text.includes("Stop"))).toBe(true);
  });

  it("puts finished work away without touching what is still going", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: ROOT }),
      t2: task({ id: "t2", sessionPath: ROOT, command: "pnpm build", title: "pnpm build", status: "completed", endedAt: "2026-09-08T10:05:00.000Z", exitCode: 0 }),
    };
    await render();
    const clear = () => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="fleet-clear-finished"]')][0];
    expect(clear()).toBeTruthy();
    await act(async () => clear()!.click());
    // The finished command is out of sight; the running one and the agent are
    // untouched, and nothing was deleted — this is a per-viewer "I have read
    // these", not a destructive control.
    expect(container.textContent).not.toContain("pnpm build");
    expect(container.textContent).toContain("pnpm vite dev");
    expect(container.textContent).toContain("Explorer");
    expect(clear()).toBeUndefined();
  });

  it("clears an expanded context descendant without letting a newer finish revive that disclosure", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      old: task({ id: "old", sessionPath: CHILD, command: "pnpm old", title: "pnpm old", status: "completed", endedAt: "2000-01-01T00:00:00.000Z", exitCode: 0 }),
    };
    await render();
    await openFinished();
    const oldContext = rowIn(section("finished"), "explorer");
    await act(async () => oldContext.querySelector("button")!.click());
    expect(oldContext.getAttribute("data-expanded")).toBe("true");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-clear-finished"]')!.click());
    expect(container.textContent).toContain("Explorer");
    expect(container.textContent).not.toContain("pnpm old");
    expect(container.querySelector('[data-slot="fleet-clear-finished"]')).toBeNull();
    expect(container.querySelector('[data-slot="fleet-row"][data-expanded="true"]')).toBeNull();

    fixture.state.tasks.tasks = {
      ...fixture.state.tasks.tasks,
      fresh: task({ id: "fresh", sessionPath: CHILD, command: "pnpm fresh", title: "pnpm fresh", status: "completed", endedAt: "2099-01-01T00:00:00.000Z", exitCode: 0 }),
    };
    await render();
    expect(container.querySelector('[data-slot="subagent-list"]')?.textContent).toContain("Finished1");
    // The person's Finished fold choice persists, but the old row choice does not.
    const finished = section("finished");
    expect(finished.textContent).not.toContain("pnpm old");
    expect(rowIn(finished, "explorer").getAttribute("data-context")).toBe("true");
    expect(rowIn(finished, "explorer").getAttribute("data-expanded")).toBeNull();
    expect(rowIn(finished, "pnpm fresh").getAttribute("data-expanded")).toBeNull();
  });

  it("keeps work that ended after the clear, and work whose end it does not know", async () => {
    fixture.state.tasks.tasks = {
      old: task({ id: "old", sessionPath: ROOT, command: "pnpm build", title: "pnpm build", status: "completed", endedAt: "2026-09-08T10:00:00.000Z", exitCode: 0 }),
      // Ends after any mark Clear can write, so it is new work, not cleared work.
      fresh: task({ id: "fresh", sessionPath: ROOT, command: "pnpm lint", title: "pnpm lint", status: "completed", endedAt: "2099-01-01T00:00:00.000Z", exitCode: 0 }),
      // No end at all: not knowing when something finished is not a reason to hide it.
      unknown: task({ id: "unknown", sessionPath: ROOT, command: "pnpm docs", title: "pnpm docs", status: "completed", exitCode: 0 }),
    };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-clear-finished"]')!.click());
    // Two survive the clear, and the fold has to be opened to read them.
    expect(container.querySelector('[data-slot="subagent-list"]')!.textContent).toContain("Finished2");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Finished"))!.click());
    expect(container.textContent).not.toContain("pnpm build");
    expect(container.textContent).toContain("pnpm lint");
    expect(container.textContent).toContain("pnpm docs");
  });

  it("offers no Clear when nothing has finished", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    // A control that would do nothing is not drawn.
    expect(container.querySelector('[data-slot="fleet-clear-finished"]')).toBeNull();
  });

  it("stops a background command, and offers no Stop once it has ended", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const stop = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Stop"))!;
    await act(async () => stop.click());
    expect(fixture.actions.tasks.stop).toHaveBeenCalledWith(ROOT, "t1");
    // Its output arrives through the ranged read, never a panel ref.
    expect(fixture.actions.tasks.output).toHaveBeenCalledWith(ROOT, "t1", 0);
    // The output is the terminal block — the same element the transcript's
    // `bash` row draws (M13-T60) — following a live command's tail.
    const block = terminalBlock("pnpm vite dev");
    expect(block.querySelector("pre")?.textContent).toContain("ready in 412 ms");
    expect(block.querySelector("pre")?.getAttribute("data-follow")).toBe("true");
    expect(block.querySelector('[data-slot="terminal-truncated-head"]')).toBeNull();
  });

  it("folds finished work away, and offers no Stop once a command has ended", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) };
    await render();
    expect(container.textContent).toContain("Nothing is in progress.");
    expect(rows()).toHaveLength(0);
    await act(async () => [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes("Finished"))!.click());
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    expect([...rowFor("pnpm vite dev").querySelectorAll("button")].some((b) => b.textContent?.includes("Stop"))).toBe(false);
    // The exit code is the block's header, and a finished block does not follow.
    const block = terminalBlock("pnpm vite dev");
    expect(block.getAttribute("data-exit")).toBe("0");
    expect(block.textContent).toContain("exit 0");
    expect(block.querySelector("pre")?.getAttribute("data-follow")).toBeNull();
  });

  // M13-T60: the command and its exit code are said once, by the terminal
  // block's header, so the detail's own list no longer repeats them.
  it("lets the terminal block say the command and the exit code, and keeps no field for either", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "failed", exitCode: 1, endedAt: "2026-09-08T10:01:00.000Z", terminalReason: "exit code 1" }) };
    await render();
    await openFinished();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const row = rowFor("pnpm vite dev");
    const labels = [...row.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).not.toContain("Command");
    expect(labels).not.toContain("Exit code");
    expect(labels).toContain("Ended");
    expect(labels).toContain("Output");
    const block = terminalBlock("pnpm vite dev");
    expect(block.textContent).toContain("pnpm vite dev --host");
    expect(block.textContent).toContain("exit 1");
    expect(block.getAttribute("data-exit")).toBe("1");
  });

  it("says when the block is the tail of a longer output, and reads colour escapes as colour", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, outputBytes: 400_000 }) };
    fixture.actions.tasks.output.mockImplementationOnce(async (_path: string, _id: string, from: number) => ({
      id: "t1",
      from,
      bytes: 400_000,
      chunk: "\u001b[32m→\u001b[0m  Local: http://localhost:5173/",
      eof: true,
    }));
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const block = terminalBlock("pnpm vite dev");
    expect(block.querySelector('[data-slot="terminal-truncated-head"]')?.textContent).toBe("Showing the end of the output.");
    expect(block.querySelector("pre")?.textContent).not.toContain("\u001b");
    expect(block.querySelector("pre")?.textContent).toContain("Local: http://localhost:5173/");
  });

  it("draws a finished command that printed nothing as the block with no output", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, outputBytes: 0, endedAt: "2026-09-08T10:01:00.000Z" }) };
    fixture.actions.tasks.output.mockImplementationOnce(async () => ({ id: "t1", from: 0, bytes: 0, chunk: "", eof: true }));
    await render();
    await openFinished();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const block = terminalBlock("pnpm vite dev");
    expect(block.textContent).toContain("pnpm vite dev --host");
    expect(block.textContent).toContain("exit 0");
    expect(block.textContent).toContain("no output");
  });

  it("opens the row something else asked for, including one inside the finished fold", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) };
    await render();
    await act(async () => revealInFleet("task:t1", { sheet: false }));
    await act(async () => {});
    expect(rowFor("pnpm vite dev").getAttribute("data-expanded")).toBe("true");
  });

  it("follows an external reveal issued immediately before a task crosses into Finished", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    await act(async () => revealInFleet("task:t1", { sheet: false }));
    await act(async () => {});
    expect(rowIn(section("active"), "pnpm vite dev").getAttribute("data-expanded")).toBe("true");

    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }),
    };
    await render();
    const finished = section("finished");
    expect(rowIn(finished, "pnpm vite dev").getAttribute("data-expanded")).toBe("true");
    expect(rowIn(finished, "explorer").getAttribute("data-expanded")).toBeNull();
    expect(rowIn(section("active"), "explorer").getAttribute("data-expanded")).toBeNull();
  });

  it("resolves a terminal task reveal to Finished rather than its duplicated live ancestor", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }),
    };
    await render();
    await act(async () => revealInFleet("task:t1", { sheet: false }));
    await act(async () => {});
    const finished = section("finished");
    expect(rowIn(finished, "pnpm vite dev").getAttribute("data-expanded")).toBe("true");
    expect(rowIn(finished, "explorer").getAttribute("data-expanded")).toBeNull();
    expect(rowIn(section("active"), "explorer").getAttribute("data-expanded")).toBeNull();
  });

});

describe("the fleet is one session's tree (M13-T51)", () => {
  const twoRoots = () => {
    fixture.state.sessions = [
      summary({ path: ROOT, name: "Root session" }),
      summary({ path: CHILD, agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: ROOT, rootPath: ROOT } }),
      summary({ path: OTHER, name: "Other session" }),
      summary({ path: OTHER_CHILD, agent: { agentName: "default", kind: "child", subagentName: "reviewer", parentPath: OTHER, rootPath: OTHER } }),
    ];
    fixture.state.agents.runs = { r1: child, r2: otherChild };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: OTHER }) };
  };
  const summaryLine = (): string => container.querySelector('[data-slot="fleet-summary"]')?.textContent ?? "";

  it("shows only the open session's tree, and the tree follows the session", async () => {
    twoRoots();
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Root session");
    expect(rows().map((row) => row.textContent)).toHaveLength(1);
    expect(container.textContent).toContain("Explorer");
    expect(container.textContent).not.toContain("Reviewer");
    expect(container.textContent).not.toContain("pnpm vite dev");
    // The header counts this session, not the project.
    expect(summaryLine()).toBe("1 going");
    // Nothing is marked: the root is the header, not a row.
    expect(container.querySelector('[data-current]')).toBeNull();

    fixture.state.current = OTHER;
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Other session");
    expect(container.textContent).toContain("Reviewer");
    expect(container.textContent).toContain("pnpm vite dev");
    expect(container.textContent).not.toContain("Explorer");
    expect(summaryLine()).toBe("2 going");
  });

  it("shows a session with no work of its own as empty, even while another session is busy", async () => {
    twoRoots();
    fixture.state.sessions = [...fixture.state.sessions, summary({ path: "/p/quiet.jsonl", name: "Quiet" })];
    fixture.state.current = "/p/quiet.jsonl";
    await render();
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('[data-slot="fleet-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("Another session’s work is in that session’s fleet");
    expect(summaryLine()).toBe("nothing here yet");
    expect(container.querySelector('[aria-label="Work is in progress"]')).toBeNull();
  });

  it("shows a child's root tree with the child marked as the one being read, and no way to open where you are", async () => {
    twoRoots();
    fixture.state.current = CHILD;
    fixture.state.open = { [CHILD]: view({ path: CHILD }) };
    await render();
    // The root's tree, not the child's own.
    expect(container.querySelector("h4")?.textContent).toBe("Root session");
    const here = container.querySelector<HTMLElement>('[data-slot="fleet-row"][data-current="true"]');
    expect(here).not.toBeNull();
    expect(here!.textContent).toContain("Explorer");
    expect(here!.textContent).toContain("reading");
    expect(container.textContent).not.toContain("Reviewer");
    await act(async () => here!.querySelector("button")!.click());
    const labels = [...here!.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((text) => text.includes("Open chat"))).toBe(false);
    expect(here!.querySelector('[data-slot="fleet-here"]')?.textContent).toBe("This is the chat you are reading.");
    // Ending it is still offered: being read is not being finished.
    expect(labels.some((text) => text.includes("End agent"))).toBe(true);
  });

  it("finds a child's root from its own state before the catalog has a row for it", async () => {
    fixture.state.sessions = [summary({ path: ROOT, name: "Root session" })];
    fixture.state.agents.runs = { r1: child };
    fixture.state.current = CHILD;
    const opened = view({ path: CHILD });
    fixture.state.open = { [CHILD]: { ...opened, state: { ...opened.state, agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: ROOT, rootPath: ROOT } } } };
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Root session");
    expect(container.querySelector('[data-slot="fleet-row"][data-current="true"]')).not.toBeNull();
  });

  it("says what it would show when no session is open, rather than claiming nothing is running", async () => {
    twoRoots();
    fixture.state.current = undefined;
    await render();
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('[data-slot="fleet-no-session"]')).not.toBeNull();
    expect(container.textContent).toContain("No session is open");
    expect(container.textContent).toContain("Open a session from the sidebar");
    expect(container.textContent).not.toContain("Nothing is running");
    expect(summaryLine()).toBe("no session open");
  });

  describe("work whose session was deleted", () => {
    const withStray = () => {
      twoRoots();
      // GONE is not in the catalog, and the catalog has loaded: it was deleted.
      fixture.state.sessions = [...fixture.state.sessions, summary({ path: GONE_CHILD, agent: { agentName: "default", kind: "child", subagentName: "stray", parentPath: GONE, rootPath: GONE } })];
      fixture.state.agents.runs = { ...fixture.state.agents.runs, r3: strayChild };
      fixture.state.tasks.tasks = { ...fixture.state.tasks.tasks, t9: task({ id: "t9", sessionPath: GONE, command: "pnpm watch", title: "pnpm watch" }) };
    };
    const strays = () => container.querySelector<HTMLElement>('[data-slot="fleet-strays"]');
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-strays-toggle"]')!;

    it("is one named, counted line at the bottom of every session's fleet, kept out of the session's own counts", async () => {
      withStray();
      await render();
      expect(strays()).not.toBeNull();
      expect(toggle().textContent).toContain("2 pieces of work from a deleted session");
      expect(toggle().textContent).toContain("still going, and still costing");
      // Closed by default: the rows are not in the DOM until asked for.
      expect(rows()).toHaveLength(1);
      expect(summaryLine()).toBe("1 going");
      // The same line in a session with nothing of its own, and with none open.
      fixture.state.current = "/p/quiet.jsonl";
      fixture.state.sessions = [...fixture.state.sessions, summary({ path: "/p/quiet.jsonl" })];
      await render();
      expect(container.querySelector('[data-slot="fleet-empty"]')).not.toBeNull();
      expect(strays()).not.toBeNull();
      fixture.state.current = undefined;
      await render();
      expect(container.querySelector('[data-slot="fleet-no-session"]')).not.toBeNull();
      expect(strays()).not.toBeNull();
    });

    it("labels and counts the active stray section", async () => {
      withStray();
      await render();
      await act(async () => toggle().click());
      const header = strays()?.querySelector('[data-slot="fleet-section-header"]');
      expect(header?.textContent).toContain("In progress");
      expect(header?.textContent).toMatch(/2/);
    });

    it("opens into the same rows, says the session is deleted, and still stops the work", async () => {
      withStray();
      await render();
      await act(async () => toggle().click());
      const group = strays()!.querySelector('[data-slot="fleet-group"]');
      expect(group?.getAttribute("data-deleted")).toBe("true");
      expect(group?.textContent).toContain("session deleted");
      expect(rowFor("stray")).toBeDefined();
      expect(rowFor("pnpm watch")).toBeDefined();
      await act(async () => rowFor("pnpm watch").querySelector("button")!.click());
      const labels = [...rowFor("pnpm watch").querySelectorAll<HTMLButtonElement>("button")];
      // No session to open; Stop does not need one.
      expect(labels.some((b) => b.textContent?.includes("Open its session"))).toBe(false);
      await act(async () => labels.find((b) => b.textContent?.includes("Stop"))!.click());
      expect(fixture.actions.tasks.stop).toHaveBeenCalledWith(GONE, "t9");
      // The child's own chat still exists and still opens.
      await act(async () => rowFor("stray").querySelector("button")!.click());
      const open = [...rowFor("stray").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Open chat"))!;
      await act(async () => open.click());
      expect(fixture.actions.openSession).toHaveBeenCalledWith(GONE_CHILD);
    });

    it("follows an externally revealed actual stray to Finished when it leaves active context behind", async () => {
      withStray();
      fixture.state.tasks.tasks = {
        ...fixture.state.tasks.tasks,
        nested: task({ id: "nested", sessionPath: GONE_CHILD, command: "pnpm nested", title: "pnpm nested" }),
      };
      await render();
      await act(async () => revealInFleet(`agent:${GONE_CHILD}`, { sheet: false }));
      await act(async () => {});
      const activeAgent = rowIn(section("active", strays()!), "stray");
      expect(activeAgent.getAttribute("data-expanded")).toBe("true");

      fixture.state.agents.runs = {
        ...fixture.state.agents.runs,
        r3: { ...strayChild, status: "completed", endedAt: "2026-09-08T10:04:00.000Z" },
      };
      await render();
      const activeContext = rowIn(section("active", strays()!), "stray");
      const finishedAgent = rowIn(section("finished", strays()!), "stray");
      expect(activeContext.getAttribute("data-context")).toBe("true");
      expect(activeContext.getAttribute("data-expanded")).toBeNull();
      expect(rowIn(section("active", strays()!), "pnpm nested")).toBeDefined();
      expect(finishedAgent.getAttribute("data-context")).toBeNull();
      expect(finishedAgent.getAttribute("data-expanded")).toBe("true");
      expect(strays()!.querySelectorAll('[data-slot="fleet-row"][data-expanded="true"]')).toHaveLength(1);
    });

    it("clears expanded stray context without letting a newer finish revive that disclosure", async () => {
      withStray();
      fixture.state.tasks.tasks = {
        ...fixture.state.tasks.tasks,
        old: task({ id: "old", sessionPath: GONE_CHILD, command: "pnpm old", title: "pnpm old", status: "completed", endedAt: "2000-01-01T00:00:00.000Z", exitCode: 0 }),
      };
      await render();
      // Two live records plus one terminal record; the repeated agent context is not counted.
      expect(toggle().textContent).toContain("3 pieces of work from a deleted session");
      await act(async () => toggle().click());
      expect(rowIn(section("active", strays()!), "stray").getAttribute("data-context")).toBeNull();
      await act(async () => [...strays()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Finished"))!.click());
      const finished = section("finished", strays()!);
      const oldContext = rowIn(finished, "stray");
      expect(oldContext.getAttribute("data-context")).toBe("true");
      expect(rowIn(finished, "pnpm old")).toBeDefined();
      await act(async () => oldContext.querySelector("button")!.click());
      expect(oldContext.getAttribute("data-expanded")).toBe("true");

      await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-strays-clear"]')!.click());
      expect(toggle().textContent).toContain("2 pieces of work from a deleted session");
      expect(strays()!.textContent).not.toContain("pnpm old");
      expect(strays()!.querySelector('[data-slot="fleet-row"][data-expanded="true"]')).toBeNull();

      fixture.state.tasks.tasks = {
        ...fixture.state.tasks.tasks,
        fresh: task({ id: "fresh", sessionPath: GONE_CHILD, command: "pnpm fresh", title: "pnpm fresh", status: "completed", endedAt: "2099-01-01T00:00:00.000Z", exitCode: 0 }),
      };
      await render();
      expect(toggle().textContent).toContain("3 pieces of work from a deleted session");
      const freshFinished = section("finished", strays()!);
      expect(freshFinished.textContent).toContain("pnpm fresh");
      expect(freshFinished.textContent).not.toContain("pnpm old");
      expect(rowIn(freshFinished, "stray").getAttribute("data-expanded")).toBeNull();
      expect(rowIn(freshFinished, "pnpm fresh").getAttribute("data-expanded")).toBeNull();
    });

    it("is not drawn before the catalog has loaded: an empty list is not a deletion", async () => {
      withStray();
      fixture.state.sessions = [];
      fixture.state.sessionsLoaded = false;
      try {
        await render();
        expect(strays()).toBeNull();
      } finally {
        fixture.state.sessionsLoaded = true;
      }
    });

    it("is the tree itself when the deleted session's child is the one being read", async () => {
      withStray();
      fixture.state.current = GONE_CHILD;
      fixture.state.open = { [GONE_CHILD]: view({ path: GONE_CHILD }) };
      await render();
      expect(strays()).toBeNull();
      const group = container.querySelector('[data-slot="fleet-group"]');
      expect(group?.getAttribute("data-deleted")).toBe("true");
      expect(container.querySelector('[data-slot="fleet-row"][data-current="true"]')?.textContent).toContain("Stray");
    });

    it("is put away by Clear once it has finished, and offers its own Clear when the tree has none", async () => {
      twoRoots();
      fixture.state.agents.runs = { ...fixture.state.agents.runs, r3: { ...strayChild, status: "completed", endedAt: "2026-09-08T10:05:00.000Z" } };
      await render();
      expect(toggle().textContent).toContain("1 piece of work from a deleted session");
      expect(toggle().textContent).toContain("Finished. Clear puts it away.");
      // The tree has nothing finished, so its Clear is not drawn; the line has one.
      expect(container.querySelector('[data-slot="fleet-clear-finished"]')).toBeNull();
      const clear = container.querySelector<HTMLButtonElement>('[data-slot="fleet-strays-clear"]')!;
      expect(clear).not.toBeNull();
      await act(async () => clear.click());
      expect(strays()).toBeNull();
      // The tree's live work is untouched.
      expect(container.textContent).toContain("Explorer");
    });
  });
});

describe("the fleet row (leap §3)", () => {
  /** jsdom does not activate buttons from the keyboard. Honour preventDefault. */
  const pressKey = async (el: HTMLElement, key: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(event);
      if (!event.defaultPrevented && (key === "Enter" || key === " ")) el.click();
    });
    return event;
  };

  it("renders live activity on line 2, never the task brief", async () => {
    fixture.state.agents.runs = {
      r1: run({
        runId: "r1",
        sessionPath: CHILD,
        subagentName: "explorer",
        task: "Serve images as references in every surface",
        activity: { turns: 12, tools: 4, currentTool: "vitest", lastAt: "2026-09-08T10:04:00.000Z" },
        model: { provider: "anthropic", id: "claude-opus-4", name: "opus-4" },
      }),
    };
    await render();
    const row = rowFor("explorer");
    const headline = row.querySelector('[data-slot="fleet-headline"]');
    expect(headline?.textContent).toContain("Running");
    expect(headline?.textContent).toContain("vitest");
    expect(headline?.textContent).not.toContain("Serve images");
    expect(row.textContent).not.toContain("Serve images as references");
    expect(row.querySelector('[data-slot="fleet-strip"]')?.textContent).toContain("reviewer");
    expect(row.querySelector('[data-slot="fleet-strip"]')?.textContent).toContain("opus-4");
    expect(row.querySelector('[data-slot="fleet-strip"]')?.textContent).toContain("12t");
    expect(row.querySelector('[data-slot="fleet-worktree-chip"]')?.getAttribute("data-mode")).toBe("shared");
    expect(row.querySelector('[data-slot="fleet-elapsed"]')?.textContent).toMatch(/m|s/);
  });

  it("distinguishes an agent tile from a command tile without reading a word", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    const agent = rowFor("explorer").querySelector('[data-slot="fleet-kind-tile"]');
    const command = rowFor("pnpm vite dev").querySelector('[data-slot="fleet-kind-tile"]');
    expect(agent?.getAttribute("data-shape")).toBe("round");
    expect(command?.getAttribute("data-shape")).toBe("square");
    expect(agent?.className).toContain("rounded-lg");
    expect(command?.className).toContain("rounded-none");
    expect(command?.className).toContain("font-mono");
    expect(rowFor("explorer").querySelector('[data-slot="fleet-name"]')?.className).not.toContain("typed");
    expect(rowFor("pnpm vite dev").querySelector('[data-slot="fleet-name"]')?.className).toContain("typed");
  });

  it("nests a command one indent under its agent with a rail", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    const branch = rowFor("explorer").closest('[data-slot="fleet-branch"]');
    const nested = branch?.querySelector(':scope > ul');
    expect(nested?.getAttribute("aria-label")).toContain("Explorer");
    expect(nested?.className).toContain("border-s");
    expect(nested?.querySelector('[data-slot="fleet-row"][data-kind="task"]')).not.toBeNull();
  });

  it("filters Going, Asking and Ended, each with a count", async () => {
    fixture.state.agents.runs = {
      r1: child,
      r2: {
        ...child,
        runId: "r2",
        sessionPath: "/p/asking.jsonl",
        subagentName: "reviewer",
        status: "needs_input",
        question: { id: "q", kind: "confirm", title: "Overwrite?", askedAt: "2026-09-08T10:04:00.000Z" },
      },
      r3: {
        ...child,
        runId: "r3",
        sessionPath: "/p/done.jsonl",
        subagentName: "writer",
        status: "completed",
        endedAt: "2026-09-08T10:01:00.000Z",
      },
    };
    await render();
    const going = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-going"]')!;
    const asking = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-asking"]')!;
    const ended = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-ended"]')!;
    expect(going.textContent).toMatch(/Going\s*1/);
    expect(asking.textContent).toMatch(/Asking\s*1/);
    expect(ended.textContent).toMatch(/Ended\s*1/);
    expect(going.getAttribute("aria-pressed")).toBe("true");

    await act(async () => going.click());
    expect(going.getAttribute("aria-pressed")).toBe("false");
    expect(rowFor("explorer")).toBeUndefined();
    expect(rowFor("reviewer")).toBeDefined();

    await act(async () => asking.click());
    expect(container.textContent).toContain("Nothing matches these filters.");
    expect(ended.getAttribute("aria-pressed")).toBe("true");
    await openFinished();
    expect(rowFor("writer")).toBeDefined();
    await act(async () => ended.click());
    expect(ended.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[data-slot="fleet-group"][data-section="finished"]')).toBeNull();
  });

  it("filters by kind and keeps the counts on the chips", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    const agents = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-agents"]')!;
    const commands = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-commands"]')!;
    expect(agents.textContent).toMatch(/Agents\s*1/);
    expect(commands.textContent).toMatch(/Commands\s*1/);
    await act(async () => agents.click());
    expect(agents.getAttribute("aria-checked")).toBe("true");
    expect(rowFor("explorer")).toBeDefined();
    expect(rowFor("pnpm vite dev")).toBeUndefined();
    await act(async () => commands.click());
    expect(rowFor("explorer")).toBeUndefined();
    expect(rowFor("pnpm vite dev")).toBeDefined();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-all"]')!.click());
    expect(rowFor("explorer")).toBeDefined();
    expect(rowFor("pnpm vite dev")).toBeDefined();
  });

  it("puts Answer and Open on an asking row, and Enter never answers", async () => {
    fixture.state.agents.runs = {
      r1: {
        ...child,
        status: "needs_input",
        question: { id: "ui-1", kind: "select", title: "Which token store?", askedAt: "2026-09-08T10:04:00.000Z" },
      },
    };
    await render();
    const row = rowFor("explorer");
    const expand = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const answer = row.querySelector<HTMLButtonElement>('[data-slot="fleet-answer"]')!;
    const open = row.querySelector<HTMLButtonElement>('[data-slot="fleet-open-chat"]')!;
    expect(answer.textContent).toContain("Answer");
    expect(open.textContent).toContain("Open");
    expect(expand.getAttribute("aria-label")?.startsWith("Asking")).toBe(true);

    expand.focus();
    const expandEnter = await pressKey(expand, "Enter");
    expect(expandEnter.defaultPrevented).toBe(false);
    expect(row.getAttribute("data-expanded")).toBe("true");
    expect(fixture.actions.openSession).not.toHaveBeenCalled();

    const expandEnterAgain = await pressKey(expand, "Enter");
    expect(expandEnterAgain.defaultPrevented).toBe(false);
    expect(row.getAttribute("data-expanded")).toBeNull();

    const expandSpace = await pressKey(expand, " ");
    expect(expandSpace.defaultPrevented).toBe(false);
    expect(row.getAttribute("data-expanded")).toBe("true");
    expect(fixture.actions.openSession).not.toHaveBeenCalled();

    await act(async () => expand.click());
    expect(row.getAttribute("data-expanded")).toBeNull();
    await act(async () => expand.click());
    expect(row.getAttribute("data-expanded")).toBe("true");

    const expanded = row.getAttribute("data-expanded");
    answer.focus();
    const answerEnter = await pressKey(answer, "Enter");
    expect(answerEnter.defaultPrevented).toBe(true);
    expect(fixture.actions.openSession).not.toHaveBeenCalled();
    expect(row.getAttribute("data-expanded")).toBe(expanded);

    const answerSpace = await pressKey(answer, " ");
    expect(answerSpace.defaultPrevented).toBe(false);
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
    fixture.actions.openSession.mockClear();
    await act(async () => answer.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
    fixture.actions.openSession.mockClear();
    await act(async () => open.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
  });

  it("omits Answer when this is the chat being read, and when the session is gone", async () => {
    const asking = {
      ...child,
      status: "needs_input" as const,
      question: { id: "ui-1", kind: "select" as const, title: "Which token store?", askedAt: "2026-09-08T10:04:00.000Z" },
    };
    fixture.state.agents.runs = { r1: asking };
    fixture.state.current = CHILD;
    await render();
    const here = rowFor("explorer");
    expect(here.querySelector('[data-slot="fleet-here"]')).not.toBeNull();
    expect(here.querySelector('[data-slot="fleet-answer"]')).toBeNull();
    expect(here.querySelector('[data-slot="fleet-open-chat"]')).toBeNull();

    fixture.state.current = ROOT;
    fixture.state.sessions = [summary({ path: ROOT, name: "Root session" })];
    await render();
    const gone = rowFor("explorer");
    expect(gone.querySelector('[data-slot="fleet-answer"]')).toBeNull();
    expect(gone.querySelector('[data-slot="fleet-open-chat"]')).toBeNull();
  });

  it("middle-truncates a path, keeps a branch suffix, and puts the full text in the tooltip and accessible name", async () => {
    const path = "packages/ui/src/components/fleet/FleetPanel.tsx";
    const branch = "agents/explorer-long-suffix-6a5fb144";
    fixture.state.agents.runs = {
      r1: run({
        runId: "r1",
        sessionPath: CHILD,
        subagentName: "explorer",
        task: "Read the router",
        activity: { turns: 1, tools: 1, currentTool: path, lastAt: "2026-09-08T10:04:00.000Z" },
        worktree: { path: "/p/.worktrees/explorer-1", branch, baseCommit: "abc" },
        cwd: "/p/.worktrees/explorer-1",
      }),
    };
    await render();
    const row = rowFor("explorer");
    const headline = row.querySelector('[data-slot="fleet-headline"]')!;
    expect(headline.querySelector(".shrink-0")?.textContent).toBe("Running");
    expect(headline.textContent).toContain("Running");
    expect(headline.textContent).not.toContain(path);
    expect(headline.textContent).toContain("FleetPanel.tsx");
    expect(headline.getAttribute("aria-label")).toBe(`Running ${path}`);
    const chip = row.querySelector('[data-slot="fleet-worktree-chip"]')!;
    expect(chip.textContent).toContain("6a5fb144");
    expect(chip.textContent).not.toBe(branch);
    expect(chip.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(branch);
    const expand = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(expand.getAttribute("aria-label")?.startsWith("Working")).toBe(true);
    expect(expand.getAttribute("aria-label")).toContain(path);
    expect(expand.getAttribute("aria-label")).toContain(branch);
    expect(expand.querySelector('[data-slot="hint"]')).toBeNull();
    expect(row.querySelector('[data-slot="fleet-worktree-chip"]')?.textContent).toContain("6a5fb144");
  });

  it("lets the model and turns shrink so a long strip keeps the branch suffix", async () => {
    const branch = "agents/explorer-long-suffix-6a5fb144";
    fixture.state.agents.runs = {
      r1: run({
        runId: "r1",
        sessionPath: CHILD,
        subagentName: "explorer",
        model: { provider: "anthropic", id: "claude-opus-4", name: "claude-opus-4" },
        activity: { turns: 12, tools: 1, currentTool: "vitest", lastAt: "2026-09-08T10:04:00.000Z" },
        worktree: { path: "/p/.worktrees/explorer-1", branch, baseCommit: "abc" },
      }),
    };
    await render();
    const strip = rowFor("explorer").querySelector('[data-slot="fleet-strip"]')!;
    const model = [...strip.querySelectorAll("span")].find((el) => el.textContent === "claude-opus-4");
    const turns = [...strip.querySelectorAll("span")].find((el) => el.textContent === "12t");
    expect(model?.className).toContain("min-w-0");
    expect(model?.className).not.toContain("shrink-0");
    expect(turns?.className).toContain("min-w-0");
    expect(turns?.className).not.toContain("shrink-0");
    const chip = strip.querySelector('[data-slot="fleet-worktree-chip"]')!;
    expect(chip.className).toContain("shrink-0");
    expect(chip.textContent).toContain("6a5fb144");
    expect(strip.getAttribute("aria-label")).toContain("claude-opus-4");
    expect(strip.getAttribute("aria-label")).toContain(branch);
  });

  it("puts command, bytes and clock on a command's developer strip", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, outputBytes: 189_000 }) };
    await render();
    const strip = rowFor("pnpm vite dev").querySelector('[data-slot="fleet-strip"]');
    expect(strip?.getAttribute("data-kind")).toBe("task");
    expect(strip?.textContent).toContain("pnpm vite dev --host");
    expect(strip?.textContent).toMatch(/KB|MB|B/);
    expect(strip?.getAttribute("aria-label")).toContain("pnpm vite dev --host");
  });

  it("groups by session with the project as secondary text and counts on the header", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    const header = container.querySelector('[data-slot="fleet-group"] header');
    expect(header?.querySelector("h4")?.textContent).toBe("Root session");
    expect(header?.textContent).toMatch(/p/i);
    expect(container.querySelector('[data-slot="fleet-group-counts"]')?.textContent?.trim()).toBe("1");
    expect(container.querySelector('[data-slot="fleet-group-counts"]')?.getAttribute("aria-label")).toBe("1 going");
  });

  it("compacts group counts so a mixed header can wrap at the column width", async () => {
    fixture.state.agents.runs = {
      r1: child,
      r2: {
        ...child,
        runId: "r2",
        sessionPath: "/p/asking.jsonl",
        subagentName: "reviewer",
        status: "needs_input",
        question: { id: "q", kind: "confirm", title: "Overwrite?", askedAt: "2026-09-08T10:04:00.000Z" },
      },
      r3: {
        ...child,
        runId: "r3",
        sessionPath: "/p/done.jsonl",
        subagentName: "writer",
        status: "completed",
        endedAt: "2026-09-08T10:01:00.000Z",
      },
    };
    await render();
    const header = container.querySelector('[data-slot="fleet-group"] header')!;
    expect(header.className).toMatch(/flex-wrap/);
    expect(header.className).toMatch(/overflow-x-hidden/);
    const counts = header.querySelector('[data-slot="fleet-group-counts"]')!;
    expect(counts.textContent?.trim()).toBe("2 · 1 · 1");
    expect(counts.getAttribute("aria-label")).toBe("2 going · 1 asking · 1 ended");
    expect(header.querySelector("h4")?.className).toMatch(/truncate/);
  });

  it("moves kind with arrow keys, Home and End, on one tab stop", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const all = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-all"]')!;
    const agents = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-agents"]')!;
    const commands = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-commands"]')!;
    expect(all.tabIndex).toBe(0);
    expect(agents.tabIndex).toBe(-1);
    expect(commands.tabIndex).toBe(-1);
    all.focus();
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(agents.getAttribute("aria-checked")).toBe("true");
    expect(agents.tabIndex).toBe(0);
    expect(all.tabIndex).toBe(-1);
    expect(rowFor("explorer")).toBeDefined();
    expect(rowFor("pnpm vite dev")).toBeUndefined();
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    });
    expect(commands.getAttribute("aria-checked")).toBe("true");
    expect(rowFor("pnpm vite dev")).toBeDefined();
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    });
    expect(all.getAttribute("aria-checked")).toBe("true");
    expect(rowFor("explorer")).toBeDefined();
    expect(rowFor("pnpm vite dev")).toBeDefined();
  });

  it("reveals a row that the current filter would hide", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-going"]')!.click());
    expect(rowFor("pnpm vite dev")).toBeUndefined();
    await act(async () => revealInFleet("task:t1", { sheet: false }));
    await act(async () => {});
    expect(rowFor("pnpm vite dev").getAttribute("data-expanded")).toBe("true");
    expect(container.querySelector('[data-slot="fleet-filter-going"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("says a kind-only miss is a filter miss, not an empty fleet", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-agents"]')!.click());
    expect(container.textContent).toContain("Nothing matches these filters.");
    expect(container.textContent).not.toContain("Nothing is in progress.");
  });

  it("keeps the filter across a remount of the panel", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-going"]')!.click());
    expect(rowFor("explorer")).toBeUndefined();
    await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><span /></TooltipProvider></LaserStoreProvider>));
    await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><FleetPanel variant="panel" /></TooltipProvider></LaserStoreProvider>));
    expect(container.querySelector('[data-slot="fleet-filter-going"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(rowFor("explorer")).toBeUndefined();
  });

  it("puts Changes on an agent row, not a command, and Enter from the row never opens it", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    const agent = rowFor("explorer");
    const command = rowFor("pnpm vite dev");
    const changes = agent.querySelector<HTMLButtonElement>('[data-slot="fleet-changes"]')!;
    expect(changes.textContent).toContain("Changes");
    expect(command.querySelector('[data-slot="fleet-changes"]')).toBeNull();

    const expand = agent.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expand.focus();
    const rowEnter = await pressKey(expand, "Enter");
    expect(rowEnter.defaultPrevented).toBe(false);
    expect(agent.getAttribute("data-expanded")).toBe("true");
    expect(fixture.openChanges).not.toHaveBeenCalled();

    changes.focus();
    expect(document.activeElement).toBe(changes);
    const changesEnter = await pressKey(changes, "Enter");
    expect(changesEnter.defaultPrevented).toBe(true);
    expect(fixture.openChanges).not.toHaveBeenCalled();
    expect(agent.getAttribute("data-expanded")).toBe("true");

    const changesSpace = await pressKey(changes, " ");
    expect(changesSpace.defaultPrevented).toBe(false);
    expect(fixture.openChanges).toHaveBeenCalledWith({
      scope: { kind: "agent", runId: "r1" },
      sessionKey: CHILD,
    });
    fixture.openChanges.mockClear();
    await act(async () => changes.click());
    expect(fixture.openChanges).toHaveBeenCalledWith({
      scope: { kind: "agent", runId: "r1" },
      sessionKey: CHILD,
    });
  });

  it("keeps Changes on a shared-checkout agent so the control is never dead", async () => {
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", worktree: null }),
    };
    await render();
    const changes = rowFor("explorer").querySelector<HTMLButtonElement>('[data-slot="fleet-changes"]');
    expect(changes).not.toBeNull();
    await act(async () => changes!.click());
    expect(fixture.openChanges).toHaveBeenCalledWith({
      scope: { kind: "agent", runId: "r1" },
      sessionKey: CHILD,
    });
  });

  it("shows the isolation reason on the worktree chip, and nothing when the field is absent", async () => {
    const tooltipText = () =>
      [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((node) => node.textContent).join(" ");
    const reason = "This workspace holds 41 repositories, so an agent cannot be isolated from all of them; sharing your checkout.";
    fixture.state.agents.runs = {
      r1: run({
        runId: "r1",
        sessionPath: CHILD,
        subagentName: "explorer",
        worktree: null,
        isolation: { mode: "shared", shape: "workspace-of-repos", reason },
      }),
    };
    await render();
    const row = rowFor("explorer");
    const expand = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(expand.querySelector('[data-slot="hint"]')).toBeNull();
    const hint = row.querySelector<HTMLElement>('[data-slot="fleet-worktree-chip"] [data-slot="hint"]')!;
    expect(hint.tabIndex).toBe(0);
    expect(tooltipText()).not.toContain("41 repositories");
    await act(async () => hint.focus());
    expect(tooltipText()).toContain(reason);
    await act(async () => hint.blur());
    expect(tooltipText()).not.toContain("41 repositories");
    await act(async () => {
      hint.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
      hint.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }));
      hint.click();
    });
    expect(tooltipText()).toContain(reason);

    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", worktree: null }),
    };
    await render();
    const silent = rowFor("explorer");
    expect(silent.querySelector('[data-slot="fleet-worktree-chip"] [data-slot="hint"]')).toBeNull();
    expect(silent.querySelector('[data-slot="fleet-worktree-chip"]')?.textContent).toContain("shared checkout");
    const silentExpand = silent.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => silentExpand.focus());
    expect(tooltipText()).not.toContain("41 repositories");
    expect(tooltipText().trim()).toBe("");
  });
});
