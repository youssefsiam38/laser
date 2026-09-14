import { describe, expect, it } from "vitest";
import type { AgentRun, BackgroundTask } from "@lasercode/protocol";
import { shouldCheckLiveWork, summarizeLiveWork } from "../src/live-work.js";

const run = (status: AgentRun["status"]): AgentRun => ({ status } as AgentRun);
const task = (status: BackgroundTask["status"]): BackgroundTask => ({ status } as BackgroundTask);

describe("live work shown before host shutdown", () => {
  it("checks only operations that will stop a ready host", () => {
    expect(shouldCheckLiveWork({ state: "ready", startedByUs: true }, {})).toBe(true);
    expect(shouldCheckLiveWork({ state: "ready", startedByUs: false }, {})).toBe(false);
    expect(shouldCheckLiveWork({ state: "ready", startedByUs: false }, { relaunch: true })).toBe(true);
    expect(shouldCheckLiveWork({ state: "ready", startedByUs: false }, { install: true })).toBe(true);
    expect(shouldCheckLiveWork({ state: "failed", startedByUs: true }, {})).toBe(false);
    expect(shouldCheckLiveWork(undefined, { relaunch: true })).toBe(false);
  });

  it("counts every non-terminal agent state and only running commands", () => {
    const summary = summarizeLiveWork(
      [run("queued"), run("running"), run("needs_input"), run("completed"), run("blocked"), run("failed"), run("cancelled")],
      [task("running"), task("completed"), task("failed"), task("stopped")],
    );
    expect(summary).toEqual({
      agents: 3,
      commands: 1,
      total: 4,
      sentence: "3 agents are still working and 1 background command is still running.",
    });
  });

  it("uses singular wording and omits absent kinds", () => {
    expect(summarizeLiveWork([run("running")], [])).toEqual({
      agents: 1,
      commands: 0,
      total: 1,
      sentence: "1 agent is still working.",
    });
    expect(summarizeLiveWork([], [task("running")])).toEqual({
      agents: 0,
      commands: 1,
      total: 1,
      sentence: "1 background command is still running.",
    });
  });

  it("returns no warning sentence when everything has ended", () => {
    expect(summarizeLiveWork([run("completed")], [task("stopped")])).toEqual({ agents: 0, commands: 0, total: 0 });
  });
});
