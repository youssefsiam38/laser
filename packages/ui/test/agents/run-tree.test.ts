import { describe, expect, it } from "vitest";
import { ancestryOf, buildAgentTree, rootOf, sameAgentTree, subtreePaths } from "../../src/agents/index.js";
import { run, sessionState, summary, view } from "./fixtures.js";

const ROOT = "/p/root.jsonl";

/** A root with two children (one ended) and one grandchild under the live child. */
function family() {
  const runs = [
    run({ runId: "r-a", sessionPath: "/p/a.jsonl", subagentName: "reviewer-1", startedAt: "2026-09-08T10:00:00.000Z" }),
    run({
      runId: "r-b",
      sessionPath: "/p/b.jsonl",
      agentName: "tester",
      subagentName: "tester-1",
      startedAt: "2026-09-08T10:01:00.000Z",
      status: "completed",
      endedAt: "2026-09-08T10:20:00.000Z",
      result: { status: "completed", message: "All green." },
    }),
    run({
      runId: "r-c",
      sessionPath: "/p/c.jsonl",
      agentName: "reader",
      subagentName: "reader-1",
      depth: 2,
      parent: { sessionPath: "/p/a.jsonl", sessionId: "/p/a.jsonl", runId: "r-a" },
      startedAt: "2026-09-08T10:02:00.000Z",
    }),
  ];
  const sessions = [
    summary({ path: ROOT, name: "Ship the feature", attention: "working" }),
    summary({ path: "/p/a.jsonl", agent: { agentName: "reviewer", kind: "child", subagentName: "reviewer-1", parentPath: ROOT, rootPath: ROOT } }),
    summary({ path: "/p/b.jsonl", firstMessage: "Run the suite", agent: { agentName: "tester", kind: "child", subagentName: "tester-1", parentPath: ROOT, rootPath: ROOT } }),
    // The grandchild is not in the catalog yet: its node comes from the run alone.
    summary({ path: "/q/other.jsonl", cwd: "/q" }),
  ];
  return { runs, sessions };
}

describe("buildAgentTree", () => {
  it("lays out depths, creation-ordered children and edges", () => {
    const { runs, sessions } = family();
    const tree = buildAgentTree({ rootPath: ROOT, sessions, runs });
    expect(tree.nodes.map((n) => [n.id, n.depth, n.parentPath])).toEqual([
      [ROOT, 0, undefined],
      ["/p/a.jsonl", 1, ROOT],
      ["/p/c.jsonl", 2, "/p/a.jsonl"],
      ["/p/b.jsonl", 1, ROOT],
    ]);
    expect(tree.edges).toEqual([
      { from: ROOT, to: "/p/a.jsonl" },
      { from: "/p/a.jsonl", to: "/p/c.jsonl" },
      { from: ROOT, to: "/p/b.jsonl" },
    ]);
    expect(tree.root.children).toEqual(["/p/a.jsonl", "/p/b.jsonl"]);
    expect(subtreePaths(tree)).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl", "/p/b.jsonl"]);
    expect(tree.byPath.get("/p/c.jsonl")?.parentPath).toBe("/p/a.jsonl");
    // Nothing from another tree leaks in.
    expect(tree.byPath.has("/q/other.jsonl")).toBe(false);
  });

  it("names and titles nodes from the catalog, the run, or the parent's name for it", () => {
    const { runs, sessions } = family();
    const tree = buildAgentTree({ rootPath: ROOT, sessions, runs, defaultAgent: "default" });
    expect(tree.root).toMatchObject({ title: "Ship the feature", agentName: "default", status: "working", tone: "live", ended: false, runs: [] });
    expect(tree.byPath.get("/p/a.jsonl")).toMatchObject({ title: "reviewer-1", agentName: "reviewer", subagentName: "reviewer-1", status: "running", tone: "live", ended: false });
    expect(tree.byPath.get("/p/b.jsonl")).toMatchObject({ title: "Run the suite", agentName: "tester", status: "completed", tone: "ok", ended: true });
    expect(tree.byPath.get("/p/c.jsonl")).toMatchObject({ title: "reader-1", agentName: "reader", subagentName: "reader-1", sessionId: "/p/c.jsonl", status: "running", ended: false });
    expect(tree.byPath.get("/p/a.jsonl")?.run?.runId).toBe("r-a");
    expect(tree.active).toBe(3);
  });

  it("keeps the newest run as the node's run and every run in creation order", () => {
    const { runs, sessions } = family();
    const again = run({ runId: "r-a2", sessionPath: "/p/a.jsonl", subagentName: "reviewer-1", startedAt: "2026-09-08T10:30:00.000Z", status: "blocked" });
    const tree = buildAgentTree({ rootPath: ROOT, sessions, runs: [again, ...runs] });
    const a = tree.byPath.get("/p/a.jsonl")!;
    expect(a.runs.map((r) => r.runId)).toEqual(["r-a", "r-a2"]);
    expect(a.run?.runId).toBe("r-a2");
    expect(a).toMatchObject({ status: "blocked", tone: "attention", ended: true });
  });

  it("derives the root's status from attention and the live view", () => {
    const { runs, sessions } = family();
    const waiting = buildAgentTree({ rootPath: ROOT, sessions: [{ ...sessions[0]!, attention: "waiting_for_input" }, ...sessions.slice(1)], runs });
    expect(waiting.root).toMatchObject({ status: "blocked", tone: "attention", ended: false });
    const errored = buildAgentTree({ rootPath: ROOT, sessions: [{ ...sessions[0]!, attention: "error" }, ...sessions.slice(1)], runs });
    expect(errored.root).toMatchObject({ status: "failed", tone: "danger", ended: false });
    const idle = buildAgentTree({ rootPath: ROOT, sessions: [{ ...sessions[0]!, attention: "idle" }, ...sessions.slice(1)], runs });
    expect(idle.root).toMatchObject({ status: "idle", tone: "muted", ended: false });
    // An open view's live state outranks the catalog: a pending dialog means "needs you".
    const live = buildAgentTree({
      rootPath: ROOT,
      sessions: [{ ...sessions[0]!, attention: "idle" }, ...sessions.slice(1)],
      runs,
      views: { [ROOT]: view({ path: ROOT, dialogs: [{ id: "d1", method: "confirm", title: "Allow?", message: "" } as never] }) },
    });
    expect(live.root.status).toBe("blocked");
  });

  it("keeps a catalog-attributed child whose run the registry lost, and folds it when idle", () => {
    // Creation order comes from the catalog's `createdAt` when no run says when a child started.
    const sessions = [
      summary({ path: ROOT, attention: "idle" }),
      summary({ path: "/p/lost.jsonl", attention: "idle", createdAt: "2026-09-08T09:01:00.000Z", agent: { agentName: "reviewer", kind: "child", subagentName: "reviewer-9", parentPath: ROOT, rootPath: ROOT, runStatus: "failed" } }),
      summary({ path: "/p/quiet.jsonl", attention: "idle", createdAt: "2026-09-08T09:02:00.000Z", parentPath: ROOT }),
      summary({ path: "/p/busy.jsonl", attention: "working", createdAt: "2026-09-08T09:03:00.000Z", parentPath: ROOT }),
    ];
    const tree = buildAgentTree({ rootPath: ROOT, sessions, runs: [] });
    expect(tree.nodes.map((n) => n.id)).toEqual([ROOT, "/p/lost.jsonl", "/p/quiet.jsonl", "/p/busy.jsonl"]);
    expect(tree.byPath.get("/p/lost.jsonl")).toMatchObject({ status: "failed", ended: true, title: "reviewer-9" });
    expect(tree.byPath.get("/p/quiet.jsonl")).toMatchObject({ status: "idle", ended: true });
    expect(tree.byPath.get("/p/busy.jsonl")).toMatchObject({ status: "working", ended: false });
    expect(tree.active).toBe(2);
  });

  it("attaches a child whose parent is missing to the root rather than dropping it", () => {
    const orphan = run({ runId: "r-o", sessionPath: "/p/o.jsonl", depth: 3, parent: { sessionPath: "/p/gone.jsonl", sessionId: "gone" } });
    const tree = buildAgentTree({ rootPath: ROOT, sessions: [summary({ path: ROOT })], runs: [orphan] });
    expect(tree.byPath.get("/p/o.jsonl")).toMatchObject({ depth: 1, parentPath: ROOT });
    expect(tree.edges).toEqual([{ from: ROOT, to: "/p/o.jsonl" }]);
  });

  it("stands a root the catalog has not scanned on its open view", () => {
    const views = { [ROOT]: view({ path: ROOT, running: true, state: sessionState({ path: ROOT, name: "Fresh", agent: { agentName: "reviewer", kind: "root" } }) }) };
    const tree = buildAgentTree({ rootPath: ROOT, sessions: [], runs: [], views });
    expect(tree.root).toMatchObject({ title: "Fresh", agentName: "reviewer", status: "working", sessionId: ROOT });
  });

  it("compares trees structurally so a rebuild without change keeps identity", () => {
    const { runs, sessions } = family();
    const a = buildAgentTree({ rootPath: ROOT, sessions, runs });
    const b = buildAgentTree({ rootPath: ROOT, sessions: [...sessions], runs: [...runs] });
    expect(a).not.toBe(b);
    expect(sameAgentTree(a, b)).toBe(true);
    const moved = buildAgentTree({ rootPath: ROOT, sessions, runs: runs.map((r) => (r.runId === "r-c" ? { ...r, status: "completed" as const } : r)) });
    expect(sameAgentTree(a, moved)).toBe(false);
    const renamed = buildAgentTree({ rootPath: ROOT, sessions: sessions.map((s) => (s.path === "/p/a.jsonl" ? { ...s, name: "Reviewing" } : s)), runs });
    expect(sameAgentTree(a, renamed)).toBe(false);
  });
});

describe("ancestry", () => {
  it("resolves any session in the tree to its root, through runs or catalog rows", () => {
    const { runs, sessions } = family();
    expect(ancestryOf(runs, sessions, "/p/c.jsonl")).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl"]);
    expect(ancestryOf(runs, sessions, "/p/b.jsonl")).toEqual([ROOT, "/p/b.jsonl"]);
    expect(ancestryOf(runs, sessions, ROOT)).toEqual([ROOT]);
    expect(rootOf(runs, sessions, "/p/c.jsonl")).toBe(ROOT);
    // Catalog-only child, no run: the row's own attribution leads home.
    expect(rootOf([], sessions, "/p/a.jsonl")).toBe(ROOT);
    // A legacy `parentPath` chain works too.
    expect(rootOf([], [summary({ path: "/p/x.jsonl", parentPath: "/p/y.jsonl" }), summary({ path: "/p/y.jsonl", parentPath: ROOT })], "/p/x.jsonl")).toBe(ROOT);
    // Nobody knows the session: it is its own root.
    expect(rootOf(runs, sessions, "/q/other.jsonl")).toBe("/q/other.jsonl");
    // A run whose parent row is missing still knows its root.
    const cut = run({ runId: "r-cut", sessionPath: "/p/cut.jsonl", parent: null, rootSessionPath: ROOT });
    expect(ancestryOf([cut], [], "/p/cut.jsonl")).toEqual([ROOT, "/p/cut.jsonl"]);
  });

  it("never loops on a malformed parent cycle", () => {
    const a = summary({ path: "/p/a", parentPath: "/p/b" });
    const b = summary({ path: "/p/b", parentPath: "/p/a" });
    expect(ancestryOf([], [a, b], "/p/a")).toEqual(["/p/b", "/p/a"]);
    const tree = buildAgentTree({ rootPath: "/p/b", sessions: [a, b], runs: [] });
    expect(tree.nodes.map((n) => n.id)).toEqual(["/p/b", "/p/a"]);
  });
});
