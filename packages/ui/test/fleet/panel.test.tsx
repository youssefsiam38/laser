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
import type { BackgroundTask } from "@lasercode/protocol";

import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { resetFleetState, revealInFleet } from "../../src/fleet/fleet-state.js";
import { run, summary, view } from "../agents/fixtures.js";

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
      output: vi.fn(async () => ({ id: "t1", from: 0, bytes: 11, chunk: "ready in 412 ms", eof: true })),
    },
  },
  endAgent: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserState: (selector: (s: unknown) => unknown) => selector(fixture.state),
  useLaserStable: () => ({ actions: fixture.actions }),
}));
vi.mock("@/components/agents/end-agent", () => ({ requestEndAgent: fixture.endAgent }));
vi.mock("@/agents/worktree", () => ({ requestRemoveWorktree: fixture.removeWorktree }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetFleetState();
  fixture.state.current = ROOT;
  fixture.state.sessions = [summary({ path: ROOT, name: "Root session" }), summary({ path: CHILD })];
  fixture.state.open = { [ROOT]: view({ path: ROOT }) };
  fixture.state.agents.runs = {};
  fixture.state.tasks.tasks = {};
  for (const spy of [fixture.actions.openSession, fixture.actions.tasks.stop, fixture.actions.tasks.output, fixture.endAgent, fixture.removeWorktree]) spy.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (): Promise<void> => {
  await act(async () => root.render(<TooltipProvider><FleetPanel variant="panel" /></TooltipProvider>));
};
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')];
const rowFor = (title: string): HTMLElement => rows().find((row) => row.textContent?.includes(title))!;
const terminalBlock = (title: string): HTMLElement => rowFor(title).querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
/** Work that has ended is folded away; open the fold to read it. */
const openFinished = async (): Promise<void> => {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Finished"))!.click());
};

describe("the fleet column", () => {
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
    // unseen. The row's own one-line summary stays, which is the point of it.
    expect(rowFor("explorer").querySelector("dl")).toBeNull();
    expect(rowFor("explorer").textContent).toContain("Read the router");
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
    expect(fixture.removeWorktree).toHaveBeenCalledWith(CHILD, "explorer");
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
    expect(row.textContent).toContain("Blocked");
    expect(row.textContent).toContain("The schema owner must choose.");
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
    expect(row.textContent).toContain("Asking");
    expect(row.textContent).toContain("Which token store?");
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
    expect(container.textContent).toContain("explorer");
    expect(clear()).toBeUndefined();
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
    expect(container.textContent).toContain("explorer");
    expect(container.textContent).not.toContain("reviewer");
    expect(container.textContent).not.toContain("pnpm vite dev");
    // The header counts this session, not the project.
    expect(summaryLine()).toBe("1 going");
    // Nothing is marked: the root is the header, not a row.
    expect(container.querySelector('[data-current]')).toBeNull();

    fixture.state.current = OTHER;
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Other session");
    expect(container.textContent).toContain("reviewer");
    expect(container.textContent).toContain("pnpm vite dev");
    expect(container.textContent).not.toContain("explorer");
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
    expect(here!.textContent).toContain("explorer");
    expect(here!.textContent).toContain("reading");
    expect(container.textContent).not.toContain("reviewer");
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
      expect(container.querySelector('[data-slot="fleet-row"][data-current="true"]')?.textContent).toContain("stray");
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
      expect(container.textContent).toContain("explorer");
    });
  });
});
