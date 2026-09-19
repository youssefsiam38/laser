import { describe, expect, it } from "vitest";

import { agentHeadline, agentStrip, headlineText, stripText, taskHeadline, taskStrip, worktreeLabel } from "../../src/fleet/row.js";
import { buildFleet, flattenFleet } from "../../src/fleet/model.js";
import { run, summary } from "../agents/fixtures.js";
import type { BackgroundTask } from "@lasercode/protocol";

const ROOT = "/p/root.jsonl";
const NOW = Date.parse("2026-09-08T10:05:00.000Z");

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm -r test",
  title: "pnpm -r test",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 0,
  ...over,
});

describe("agentHeadline", () => {
  it("prefers live activity over the task brief", () => {
    const live = run({
      runId: "r1",
      sessionPath: "/p/a.jsonl",
      task: "Serve images as references in every surface",
      activity: { turns: 12, tools: 4, currentTool: "vitest", lastAt: "2026-09-08T10:04:00.000Z" },
    });
    const headline = agentHeadline(live, false, undefined);
    expect(headline).toMatchObject({ kind: "activity", verb: "Running", text: "vitest" });
    expect(headlineText(headline!)).toBe("Running vitest");
    expect(headlineText(headline!)).not.toContain("Serve images");
  });
  it("prefers a question when the run is asking", () => {
    const asking = run({
      runId: "r1",
      sessionPath: "/p/a.jsonl",
      status: "needs_input",
      task: "Migrate the token store",
      activity: { turns: 2, tools: 1, currentTool: "ask_person", lastAt: "2026-09-08T10:04:00.000Z" },
      question: { id: "q", kind: "select", title: "Which token store?", askedAt: "2026-09-08T10:04:00.000Z" },
    });
    expect(agentHeadline(asking, false, undefined)).toMatchObject({ kind: "question", text: "Which token store?" });
  });
  it("uses the result's first sentence when a run has finished", () => {
    const done = run({
      runId: "r1",
      sessionPath: "/p/a.jsonl",
      status: "completed",
      task: "Serve images as references",
      endedAt: "2026-09-08T10:04:00.000Z",
      result: { status: "completed", message: "Images are references now. Packed the cache after." },
    });
    expect(agentHeadline(done, true, undefined)).toMatchObject({
      kind: "result",
      text: "Images are references now.",
    });
  });
});

describe("taskHeadline", () => {
  it("uses the last output line while the command is going", () => {
    expect(taskHeadline(task({ id: "t1", sessionPath: ROOT, activity: "ready in 412 ms" }), undefined)).toMatchObject({
      kind: "output",
      text: "ready in 412 ms",
    });
  });
});

describe("stripText", () => {
  it("joins the agent strip and spells shared checkout once", () => {
    const strip = agentStrip(
      run({ runId: "r1", sessionPath: "/p/a.jsonl", worktree: null, activity: { turns: 12, tools: 1, lastAt: "2026-09-08T10:04:00.000Z" } }),
      "worker",
    );
    expect(worktreeLabel(strip.worktree)).toBe("shared checkout");
    expect(strip.worktree.reason).toBeUndefined();
    expect(stripText(strip)).toBe("worker · 12t · shared checkout");
  });
  it("attaches isolation.reason to the chip and stays silent when it is absent", () => {
    const reason = "This workspace holds 41 repositories, so an agent cannot be isolated from all of them; sharing your checkout.";
    const shared = agentStrip(
      run({
        runId: "r1",
        sessionPath: "/p/a.jsonl",
        worktree: null,
        isolation: { mode: "shared", shape: "workspace-of-repos", reason },
      }),
      "worker",
    );
    expect(shared.worktree).toMatchObject({ kind: "shared", reason });
    expect(stripText(shared)).toBe("worker · shared checkout");
    const isolated = agentStrip(
      run({
        runId: "r2",
        sessionPath: "/p/b.jsonl",
        worktree: { path: "/p/.worktrees/a", branch: "agents/a", baseCommit: "abc" },
        isolation: { mode: "worktree", shape: "repo", reason: "This agent works in its own worktree, isolated from your checkout." },
      }),
      "worker",
    );
    expect(isolated.worktree).toMatchObject({
      kind: "branch",
      branch: "agents/a",
      reason: "This agent works in its own worktree, isolated from your checkout.",
    });
    const blank = agentStrip(
      run({
        runId: "r3",
        sessionPath: "/p/c.jsonl",
        worktree: null,
        isolation: { mode: "shared", shape: "no-git", reason: "   " },
      }),
      "worker",
    );
    expect(blank.worktree).toEqual({ kind: "shared" });
  });
  // The command belongs to line 1, which has the width for it. Repeating it
  // here, shorter, was the strip saying nothing twice.
  it("says how a command stands, what it wrote and when it began — never the command again", () => {
    const strip = taskStrip(task({ id: "t1", sessionPath: ROOT, outputBytes: 2048 }));
    expect(strip).toMatchObject({ kind: "task", status: "running", failed: false, bytes: 2048 });
    expect(stripText(strip)).toContain("running");
    expect(stripText(strip)).toContain("KB");
    expect(stripText(strip)).not.toContain("pnpm -r test");
    expect(stripText(strip)).not.toMatch(/pid/i);
  });

  it("carries the exit code of a command that ended, and marks a non-zero one", () => {
    const ok = taskStrip(task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, outputBytes: 10 }));
    expect(ok).toMatchObject({ status: "exit 0", failed: false });
    const bad = taskStrip(task({ id: "t2", sessionPath: ROOT, status: "failed", exitCode: 2, outputBytes: 10 }));
    expect(bad).toMatchObject({ status: "exit 2", failed: true });
    // Killed or unable to run: there is no code to show, so it does not invent one.
    const broken = taskStrip(task({ id: "t3", sessionPath: ROOT, status: "failed", outputBytes: 0 }));
    expect(broken).toMatchObject({ status: "failed", failed: true });
    const stopped = taskStrip(task({ id: "t4", sessionPath: ROOT, status: "stopped", outputBytes: 0 }));
    expect(stopped).toMatchObject({ status: "stopped", failed: false });
  });
});

describe("buildFleet row projection", () => {
  it("never puts the task brief on the headline when activity differs", () => {
    const live = run({
      runId: "r1",
      sessionPath: "/p/child.jsonl",
      subagentName: "explorer",
      task: "Read the router and rewrite it",
      activity: { turns: 3, tools: 2, currentTool: "vitest", lastAt: "2026-09-08T10:04:00.000Z" },
    });
    const item = flattenFleet(
      buildFleet({
        sessions: [summary({ path: ROOT }), summary({ path: "/p/child.jsonl" })],
        runs: { r1: live },
        tasks: {},
        views: {},
        now: NOW,
      })[0]!.items,
    )[0]!;
    expect(item.subtitle).toBe("Read the router and rewrite it");
    expect(item.headline).toMatchObject({ verb: "Running", text: "vitest" });
    expect(item.strip).toMatchObject({ kind: "agent", agentName: "reviewer" });
    expect(item.initials).toBe("RE");
  });
  it("marks a run without a worktree as sharing the checkout", () => {
    const live = run({ runId: "r1", sessionPath: "/p/child.jsonl", worktree: null });
    const item = flattenFleet(
      buildFleet({ sessions: [summary({ path: ROOT })], runs: { r1: live }, tasks: {}, views: {}, now: NOW })[0]!.items,
    )[0]!;
    expect(item.strip).toMatchObject({ kind: "agent", worktree: { kind: "shared" } });
  });
  it("puts bytes and clock on a command strip, never an agent name", () => {
    const item = flattenFleet(
      buildFleet({
        sessions: [summary({ path: ROOT })],
        runs: {},
        tasks: { t1: task({ id: "t1", sessionPath: ROOT, outputBytes: 189_000 }) },
        views: {},
        now: NOW,
      })[0]!.items,
    )[0]!;
    expect(item.strip).toMatchObject({ kind: "task", status: "running", bytes: 189_000 });
    expect(item.strip).not.toHaveProperty("command");
    expect(item.headline).toBeUndefined();
  });
});
