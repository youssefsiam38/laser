import { describe, expect, it } from "vitest";

import { agentHeadline, headlineText, taskHeadline } from "../../src/fleet/row.js";
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
    expect(item.strip).toMatchObject({ kind: "task", command: "pnpm -r test", bytes: 189_000 });
    expect(item.headline).toBeUndefined();
  });
});
