/**
 * M13-T3 · the worker's definitions cache: built-in fallbacks before the first
 * sync, the host's snapshot afterwards, missing built-ins re-seeded, listeners.
 */
import { DEFAULT_AGENT_NAME, PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { DefinitionsCache, fallbackSnapshot, isStartable } from "../../src/agents/definitions.js";

describe("DefinitionsCache", () => {
  it("answers with built-in fallbacks until the host syncs", () => {
    const cache = new DefinitionsCache({ beamSkill: { name: "x-beam", path: "/skills/x-beam/SKILL.md", scope: "global" }, webSearch: true });
    expect(cache.isSynced).toBe(false);
    const fallback = cache.defaultAgent();
    expect(fallback).toMatchObject({ name: DEFAULT_AGENT_NAME, kind: "custom", engineInstructions: true, supportsSubagents: true, allowedAgents: [DEFAULT_AGENT_NAME] });
    const beam = cache.definition("beam")!;
    expect(beam).toMatchObject({ kind: "builtin", scopedSkills: true, skills: [{ name: "x-beam" }] });
    // Tools are not part of a definition (D-144).
    expect(beam).not.toHaveProperty("tools");
    expect(beam.instructions).toContain(PRODUCT_DISPLAY_NAME);
    expect(cache.definition("chat")).toMatchObject({ kind: "builtin" });
    expect(cache.definition("namer")).toMatchObject({ kind: "builtin" });
    expect(cache.policy()).toEqual({ maxDepth: 3, foregroundCommandSeconds: 120 });
    expect(cache.namerModel()).toBeNull();
    expect(cache.beamModel()).toBeNull();
    for (const name of ["beam", "chat", "namer"]) expect(isStartable(cache.definition(name)!)).toBe(false);
    expect(isStartable(fallback)).toBe(true);
  });

  it("takes the host's snapshot, re-seeds missing built-ins and notifies listeners", () => {
    const cache = new DefinitionsCache();
    const seen: number[] = [];
    const off = cache.onChange((snapshot) => seen.push(snapshot.revision));
    const base = fallbackSnapshot();
    const custom = { ...base.agents[0]!, name: "lead", supportsSubagents: true, allowedAgents: ["default"] };
    cache.sync({ ...base, revision: 7, agents: [base.agents[0]!, custom], defaultAgent: "lead", policy: { maxDepth: 2, foregroundCommandSeconds: 30 }, beam: { model: { provider: "p", id: "m" }, suggested: null, needsChoice: false }, namer: { status: "ready", model: { provider: "p", id: "n" }, candidates: [] } });
    expect(cache.isSynced).toBe(true);
    expect(cache.defaultAgent().name).toBe("lead");
    expect(cache.definition("beam")?.model).toEqual({ provider: "p", id: "m" });
    expect(cache.definition("chat")).toBeDefined();
    expect(cache.namerModel()).toEqual({ provider: "p", id: "n" });
    expect(cache.policy()).toEqual({ maxDepth: 2, foregroundCommandSeconds: 30 });
    expect(seen).toEqual([7]);
    off();
    cache.sync({ ...base, revision: 8 });
    expect(seen).toEqual([7]);
    // An unknown default falls back to the shipped default rather than nothing.
    cache.sync({ ...base, revision: 9, defaultAgent: "gone" });
    expect(cache.defaultAgent().name).toBe(DEFAULT_AGENT_NAME);
  });
});
