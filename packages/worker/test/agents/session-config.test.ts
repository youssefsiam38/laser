/**
 * M13-T3 · per-agent session configuration, the pure half: tool filtering,
 * skill scoping (the Beam skill only for Beam), roles and record recovery.
 */
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackBeamAgent, fallbackChatAgent, fallbackDefaultAgent } from "../../src/agents/definitions.js";
import { engineToolsFor, excludedEngineTools, filterSkills, parseSessionAgentRecord, readSessionAgentRecord, rootRecord, rootRole, wantsWebSearch } from "../../src/agents/session-config.js";

describe("engineToolsFor", () => {
  it("keeps only the engine's built-in tools, in the engine's order", () => {
    expect(engineToolsFor({ tools: ["write", "read", "web_search", "bash", "nonsense"] })).toEqual(["read", "bash", "write"]);
    expect(engineToolsFor(fallbackDefaultAgent())).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(engineToolsFor(fallbackChatAgent({ webSearch: true }))).toEqual([]);
    expect(excludedEngineTools({ tools: ["read", "grep", "web_search"] })).toEqual(["bash", "edit", "write", "find", "ls"]);
    expect(excludedEngineTools(fallbackDefaultAgent())).toEqual([]);
    expect(wantsWebSearch(fallbackChatAgent({ webSearch: true }))).toBe(true);
    // The default set lists web search; it only registers while the feature is on.
    expect(wantsWebSearch(fallbackDefaultAgent())).toBe(true);
    expect(wantsWebSearch({ tools: ["read", "bash"] })).toBe(false);
  });
});

describe("filterSkills", () => {
  const beamSkillName = `${PRODUCT_NAME}-beam`;
  const skills = [{ name: "alpha" }, { name: "beta" }, { name: beamSkillName }];
  it("offers the Beam skill only to Beam", () => {
    const beam = fallbackBeamAgent({ model: null, beamSkill: { name: beamSkillName, path: "/x", scope: "global" } });
    expect(filterSkills(skills, { definition: fallbackDefaultAgent(), role: { kind: "root" }, beamSkillName }).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(filterSkills(skills, { definition: beam, role: { kind: "beam" }, beamSkillName }).map((s) => s.name)).toEqual([beamSkillName]);
    // A misconfigured Beam definition still cannot leak the skill to a child.
    expect(filterSkills(skills, { definition: { scopedSkills: false, skills: [] }, role: { kind: "child" }, beamSkillName })).toHaveLength(2);
  });
  it("keeps only the listed skills when scoped", () => {
    const scoped = { scopedSkills: true, skills: [{ name: "beta", path: "/b", scope: "project" as const }, { name: "missing", path: "/m", scope: "project" as const }] };
    expect(filterSkills(skills, { definition: scoped, role: { kind: "root" }, beamSkillName }).map((s) => s.name)).toEqual(["beta"]);
    expect(filterSkills(skills, { definition: { scopedSkills: false, skills: [] }, role: { kind: "root" } })).toHaveLength(3);
  });
});

describe("roles and records", () => {
  it("derives the built-in kinds from the agent name", () => {
    expect(rootRole("default")).toEqual({ agentName: "default", kind: "root", depth: 0 });
    expect(rootRole("beam")).toEqual({ agentName: "beam", kind: "beam", depth: 0 });
    expect(rootRole("chat")).toEqual({ agentName: "chat", kind: "chat", depth: 0 });
    expect(rootRecord("beam")).toEqual({ agentName: "beam", kind: "beam" });
  });
  it("parses a record strictly", () => {
    expect(parseSessionAgentRecord({ agentName: "worker", kind: "child", subagentName: "w", parentPath: "/p", runId: "run_1", worktree: { path: "/w", branch: "agents/w", baseCommit: "abc" }, junk: 1 })).toEqual({ agentName: "worker", kind: "child", subagentName: "w", parentPath: "/p", runId: "run_1", worktree: { path: "/w", branch: "agents/w", baseCommit: "abc" } });
    expect(parseSessionAgentRecord({ agentName: "x", kind: "weird" })).toBeUndefined();
    expect(parseSessionAgentRecord({ kind: "root" })).toBeUndefined();
    expect(parseSessionAgentRecord("nope")).toBeUndefined();
  });
});

describe("readSessionAgentRecord", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-record-`));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("finds the record among the first lines and ignores files without one", async () => {
    const path = join(base, "s.jsonl");
    const lines = [
      { type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "t" },
      { type: "custom", customType: "goal-state", id: "e1", data: { goal: null } },
      { type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, id: "e2", data: { agentName: "beam", kind: "beam" } },
      { type: "message", id: "e3", message: { role: "user", content: "hi" } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await readSessionAgentRecord(path)).toEqual({ agentName: "beam", kind: "beam" });
    writeFileSync(path, JSON.stringify(lines[0]) + "\n" + JSON.stringify(lines[3]) + "\n");
    expect(await readSessionAgentRecord(path)).toBeUndefined();
    expect(await readSessionAgentRecord(join(base, "missing.jsonl"))).toBeUndefined();
  });

  it("survives a truncated line at the scan boundary", async () => {
    const path = join(base, "big.jsonl");
    const header = JSON.stringify({ type: "session", id: "s", cwd: "/r" });
    const filler = JSON.stringify({ type: "message", id: "m", message: { role: "user", content: "x".repeat(70_000) } });
    writeFileSync(path, `${header}\n${filler}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } })}\n`);
    // Beyond the window: not found, never guessed.
    expect(await readSessionAgentRecord(path)).toBeUndefined();
  });
});
