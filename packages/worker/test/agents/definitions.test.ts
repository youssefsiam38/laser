/**
 * M13-T3 · the worker's definitions cache: the shipped default before the
 * first sync, the host's snapshot afterwards, listeners.
 *
 * M23: there are no built-in agents to re-seed. A name that used to be one is
 * a name nothing answers to, and nothing may start it (`docs/plain-chat.md`).
 */
import { DEFAULT_AGENT_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionsCache, fallbackSnapshot, isStartable } from "../../src/agents/definitions.js";

describe("DefinitionsCache", () => {
  it("answers with the shipped default until the host syncs, and knows no built-ins", () => {
    const cache = new DefinitionsCache();
    expect(cache.isSynced).toBe(false);
    const fallback = cache.defaultAgent();
    expect(fallback).toMatchObject({ name: DEFAULT_AGENT_NAME, kind: "custom", engineInstructions: true, supportsSubagents: true, allowedAgents: [DEFAULT_AGENT_NAME] });
    // Tools are not part of a definition (D-144).
    expect(fallback).not.toHaveProperty("tools");
    expect(cache.snapshot().agents.map((agent) => agent.name)).toEqual([DEFAULT_AGENT_NAME]);
    for (const name of ["beam", "chat", "namer"]) expect(cache.definition(name)).toBeUndefined();
    expect(cache.policy()).toEqual({ maxDepth: 3, foregroundCommandSeconds: 120 });
    expect(isStartable(fallback)).toBe(true);
    // Even if a snapshot ever named one, nothing may start it.
    expect(isStartable({ ...fallback, name: "namer" })).toBe(false);
  });

  it("filters project scopes by real path and lets the local project shadow a global definition", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-definitions-"));
    try {
      const project = join(root, "project");
      const other = join(root, "other");
      const alias = join(root, "project-alias");
      mkdirSync(project);
      mkdirSync(other);
      symlinkSync(project, alias, "dir");

      const base = fallbackSnapshot();
      const global = { ...base.agents[0]!, name: "reviewer", description: "global", scope: "global" as const };
      const local = { ...global, description: "project", scope: "project" as const, projectCwd: alias };
      const foreign = { ...global, name: "foreign", scope: "project" as const, projectCwd: other };
      const cache = new DefinitionsCache(alias);
      cache.sync({ ...base, agents: [...base.agents, global, foreign, local] });

      expect(cache.definition("reviewer")).toMatchObject({ description: "project", scope: "project", projectCwd: project });
      expect(cache.definition("foreign")).toBeUndefined();
      expect(cache.snapshot().agents.filter(agent => agent.name === "reviewer")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the host's snapshot exactly as it is, and notifies listeners", () => {
    const cache = new DefinitionsCache();
    const seen: number[] = [];
    const off = cache.onChange((snapshot) => seen.push(snapshot.revision));
    const base = fallbackSnapshot();
    const custom = { ...base.agents[0]!, name: "lead", supportsSubagents: true, allowedAgents: ["default"] };
    cache.sync({
      ...base,
      revision: 7,
      agents: [base.agents[0]!, custom],
      defaultAgent: "lead",
      policy: { maxDepth: 2, foregroundCommandSeconds: 30 },
    });
    expect(cache.isSynced).toBe(true);
    expect(cache.defaultAgent().name).toBe("lead");
    // Nothing synthesises a definition the host did not send.
    expect(cache.snapshot().agents.map((agent) => agent.name).sort()).toEqual([DEFAULT_AGENT_NAME, "lead"]);
    expect(cache.policy()).toEqual({ maxDepth: 2, foregroundCommandSeconds: 30 });
    expect(seen).toEqual([7]);
    cache.sync({ ...base, revision: 8, agents: [custom], defaultAgent: "lead", renamedAgents: { worker: "lead" } });
    expect(cache.definition("worker")?.name).toBe("lead");
    off();
    cache.sync({ ...base, revision: 9 });
    expect(seen).toEqual([7, 8]);

    // An unknown default falls back to the shipped default rather than nothing.
    cache.sync({ ...base, revision: 10, defaultAgent: "gone" });
    expect(cache.defaultAgent().name).toBe(DEFAULT_AGENT_NAME);
  });
});
