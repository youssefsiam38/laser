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
import { ENGINE_BUILTIN_TOOLS, filterSkills, parseSessionAgentRecord, readSessionAgentRecord, rootRecord, rootRole } from "../../src/agents/session-config.js";

describe("ENGINE_BUILTIN_TOOLS", () => {
  it("is every engine tool, in the engine's order: no definition narrows it", () => {
    expect(ENGINE_BUILTIN_TOOLS).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    // Tools left the definition (D-144); nothing here reads one.
    for (const definition of [fallbackDefaultAgent(), fallbackBeamAgent({ model: null }), fallbackChatAgent()]) {
      expect(definition).not.toHaveProperty("tools");
    }
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

describe("workspace sessions whose folder is gone", () => {
  it("reads the header cwd, recreates a Beam or Chat workspace, and leaves a project session to the engine", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ensureWorkspaceSessionCwd, readSessionHeaderCwd } = await import("../../src/agents/session-config.js");
    const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-workspace-cwd-`));
    try {
      const workspace = join(base, "old-layout", "beam");
      const path = join(base, "beam.jsonl");
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T10:00:00.000Z", cwd: workspace })}\n`);
      expect(await readSessionHeaderCwd(path)).toBe(workspace);
      expect(await readSessionHeaderCwd(join(base, "missing.jsonl"))).toBeUndefined();

      expect(existsSync(workspace)).toBe(false);
      await ensureWorkspaceSessionCwd("beam", workspace, path);
      expect(existsSync(workspace)).toBe(true);
      rmSync(workspace, { recursive: true, force: true });
      await ensureWorkspaceSessionCwd("chat", workspace, path);
      expect(existsSync(workspace)).toBe(true);

      // A project session is never recreated: that directory is the person's.
      rmSync(workspace, { recursive: true, force: true });
      await ensureWorkspaceSessionCwd("root", workspace, path);
      await ensureWorkspaceSessionCwd("child", workspace, path);
      expect(existsSync(workspace)).toBe(false);

      // Unwritable: refused in words, naming the folder and the way out.
      mkdirSync(join(base, "file-parent"));
      writeFileSync(join(base, "file-parent", "blocker"), "x");
      const blocked = join(base, "blocked.jsonl");
      writeFileSync(blocked, `${JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-09-08T10:00:00.000Z", cwd: join(base, "file-parent", "blocker", "beam") })}\n`);
      await expect(ensureWorkspaceSessionCwd("beam", join(base, "file-parent", "blocker", "beam"), blocked)).rejects.toThrow(/Beam's workspace folder .*blocker\/beam is missing and could not be recreated \(.*\)\. Start a new Beam chat/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
