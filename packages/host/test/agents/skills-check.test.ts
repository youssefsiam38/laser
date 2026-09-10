/**
 * The periodic skill check: a deleted scoped skill becomes one warning that
 * names the agent, the field and the skill, keeps its first-seen time across
 * ticks, and goes away when the file comes back.
 */
import { PRODUCT_NAME, type AgentDefinition, type AgentWarning } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsCheck } from "../../src/agents/skills-check.js";
import { AgentStore } from "../../src/agents/store.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-skills-`))));
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function agent(name: string, patch: Partial<AgentDefinition>): AgentDefinition {
  return {
    name,
    kind: "custom",
    description: "",
    instructions: "x",
    engineInstructions: false,
    model: null,
    thinkingLevel: null,
    tools: [],
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    runTimeoutMinutes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("SkillsCheck", () => {
  it("warns about a scoped skill whose file is gone, keeps `since`, and clears when it returns", () => {
    const skillDir = join(dir, "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# review\n");
    const agents = [agent("reviewer", { scopedSkills: true, skills: [{ name: "review", path: skillPath, scope: "global" }] })];
    const reports: AgentWarning[][] = [];
    let clock = 0;
    const check = new SkillsCheck({
      agents: () => agents,
      report: (warnings) => reports.push(warnings),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    });

    check.run();
    expect(reports.at(-1)).toEqual([]);

    unlinkSync(skillPath);
    check.run();
    expect(reports.at(-1)).toEqual([
      {
        agentName: "reviewer",
        field: "skills",
        target: "review",
        message: `Skill "review" is no longer at ${skillPath}. Choose it again or remove it from this agent.`,
        since: "2026-01-01T00:00:00.000Z",
      },
    ]);
    check.run();
    expect(reports.at(-1)![0]!.since).toBe("2026-01-01T00:00:00.000Z"); // stable across ticks

    writeFileSync(skillPath, "# review\n");
    check.run();
    expect(reports.at(-1)).toEqual([]);

    // Gone again: a fresh problem gets a fresh `since`.
    unlinkSync(skillPath);
    check.run();
    expect(reports.at(-1)![0]!.since).toBe("2026-01-01T00:00:01.000Z");
  });

  it("warns about a child list naming a deleted agent, skips built-ins and unscoped agents", () => {
    const agents = [
      agent("lead", { supportsSubagents: true, allowedAgents: ["reviewer", "ghost"] }),
      agent("reviewer", { skills: [{ name: "nope", path: join(dir, "missing.md"), scope: "global" }] }),
      agent("beam", { kind: "builtin", scopedSkills: false, skills: [] }),
    ];
    const reports: AgentWarning[][] = [];
    new SkillsCheck({ agents: () => agents, report: (warnings) => reports.push(warnings) }).run();
    expect(reports[0]).toEqual([
      expect.objectContaining({ agentName: "lead", field: "allowedAgents", target: "ghost" }),
    ]);
  });

  it("runs on its interval, feeds the store, and never throws from the timer", () => {
    vi.useFakeTimers();
    const store = new AgentStore({ agentDir: join(dir, "agent"), workspaces: { beam: "/b", chat: "/c" } });
    store.save({
      name: "reviewer",
      description: "",
      instructions: "x",
      engineInstructions: false,
      model: null,
      thinkingLevel: null,
      tools: [],
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: true,
      skills: [{ name: "review", path: join(dir, "nowhere", "SKILL.md"), scope: "project" }],
      runTimeoutMinutes: null,
    });
    let calls = 0;
    const check = new SkillsCheck({
      agents: () => {
        calls++;
        if (calls === 2) throw new Error("disk hiccup");
        return store.snapshot().agents;
      },
      report: (warnings) => store.setWarnings(warnings),
      intervalMs: 1000,
    });
    check.start();
    expect(store.snapshot().warnings).toHaveLength(1);
    const revision = store.currentRevision;
    vi.advanceTimersByTime(1000); // the throwing tick
    expect(store.currentRevision).toBe(revision);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(3);
    expect(store.currentRevision).toBe(revision); // same warning, no new revision
    check.stop();
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(3);
  });
});
