import { describe, expect, it } from "vitest";
import { worktreeEnvironmentSchema, worktreeSetupSchema, type WorktreeEnvironment, type WorktreeSetup } from "../src/index.js";

describe("worktree environment and setup wire facts", () => {
  it("round-trips observed names without interpreting a stack", () => {
    const environment: WorktreeEnvironment = { path: "/project/child", branch: "agents/child", baseCommit: "abc123", parentCheckout: "/project", absentDirectories: ["build cache/", "unknown-language-output/"] };
    expect(worktreeEnvironmentSchema.parse(JSON.parse(JSON.stringify(environment)))).toEqual(environment);
    expect(worktreeEnvironmentSchema.safeParse({ ...environment, absentDirectories: Array(21).fill("dir/") }).success).toBe(false);
  });
  it("round-trips every asynchronous setup state", () => {
    const samples: WorktreeSetup[] = [
      { status: "not-present" },
      ...(["pending", "ok", "timed-out", "cancelled"] as const).map((status) => ({ status, logPath: "/child/setup.log" })),
      { status: "failed", exitCode: 2, logPath: "/child/setup.log" },
      { status: "failed", exitCode: null, logPath: "/child/setup.log" },
    ];
    for (const sample of samples) expect(worktreeSetupSchema.parse(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
    expect(worktreeSetupSchema.safeParse({ status: "failed", logPath: "/child/setup.log" }).success).toBe(false);
    expect(worktreeSetupSchema.safeParse({ status: "ok" }).success).toBe(false);
  });
});
