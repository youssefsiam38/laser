import { PROJECT_AGENTS_DIR } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import {
  agentForWarning,
  checkRange,
  deletability,
  describeStarts,
  fileWarningIsVisible,
  isFirstRun,
  missingSkills,
  namerSummary,
  orderAgents,
  parseModelChoice,
  sameDefinitionInput,
  sectionOfField,
  shapeAgentName,
  startableAgents,
  thinkingLevelsFor,
  visibleAgentWarnings,
} from "../../../src/components/agents/page/model.js";
import { agentDefinitionInputOf } from "../../../src/agents/index.js";
import { agent, snapshot } from "../fixtures.js";

describe("agents page model", () => {
  it("orders your agents first (the default on top) and the built-ins in their fixed order", () => {
    const snap = snapshot({ agents: [agent({ name: "zeta" }), agent({ name: "namer", kind: "builtin" }), agent({ name: "alpha" }), agent({ name: "beam", kind: "builtin" }), agent({ name: "default" }), agent({ name: "chat", kind: "builtin" })] });
    const { custom, builtin } = orderAgents(snap);
    expect(custom.map((a) => a.name)).toEqual(["default", "alpha", "zeta"]);
    expect(builtin.map((a) => a.name)).toEqual(["beam", "chat", "namer"]);
    expect(orderAgents(snapshot({ ...snap, defaultAgent: "zeta" })).custom.map((a) => a.name)).toEqual(["zeta", "default", "alpha"]);
    expect(isFirstRun(snapshot({ agents: [agent({ name: "default" })] }))).toBe(true);
    expect(isFirstRun(snap)).toBe(false);
  });

  it("offers definitions from the owner's scope, including itself, and never another project", () => {
    const snap = snapshot({
      agents: [
        ...snapshot().agents,
        agent({ name: "project-reviewer", scope: "project", projectCwd: "/p" }),
        agent({ name: "other-project", scope: "project", projectCwd: "/q" }),
      ],
    });
    expect(startableAgents(snap, { scope: "global" }).map((a) => a.name)).toEqual(["default", "reviewer"]);
    expect(startableAgents(snap, { scope: "project", projectCwd: "/p" }).map((a) => a.name)).toEqual(["default", "project-reviewer", "reviewer"]);
  });

  it("routes issue and warning fields to their editor section", () => {
    expect(sectionOfField("skills[2]")).toBe("skills");
    expect(sectionOfField("scopedSkills")).toBe("skills");
    expect(sectionOfField("allowedAgents")).toBe("allowedAgents");
    expect(sectionOfField("supportsSubagents")).toBe("allowedAgents");
    expect(sectionOfField("engineInstructions")).toBe("instructions");
    expect(sectionOfField("excludeCoreInstructions")).toBe("instructions");
    expect(sectionOfField("file")).toBe("file");
    expect(sectionOfField("scope")).toBe("file");
    expect(sectionOfField("projectCwd")).toBe("file");
    expect(sectionOfField("model")).toBe("model");
    expect(sectionOfField("name")).toBe("name");
    expect(sectionOfField("something-else")).toBe("name");
  });

  it("filters file warnings to the open project and resolves only a warning with a loaded definition", () => {
    const loaded = agent({ name: "reviewer", path: `/p/${PROJECT_AGENTS_DIR}/reviewer.md`, scope: "project", projectCwd: "/p" });
    const projectWarning = { agentName: "reviewer", field: "file" as const, target: loaded.path, message: "Could not parse this file.", since: "2026-09-08T00:00:00.000Z" };
    const broken = { agentName: "broken", field: "file" as const, target: `/p/${PROJECT_AGENTS_DIR}/broken.md`, message: "Could not parse this file.", since: "2026-09-08T00:00:00.000Z" };
    const other = { ...broken, agentName: "other", target: `/q/${PROJECT_AGENTS_DIR}/other.md` };
    const global = { ...broken, agentName: "global-broken", target: "/state/agents/global-broken.md" };
    const snap = snapshot({ agents: [...snapshot().agents, loaded], warnings: [projectWarning, broken, other, global] });
    expect(fileWarningIsVisible(projectWarning, "/p")).toBe(true);
    expect(fileWarningIsVisible(other, "/p")).toBe(false);
    expect(visibleAgentWarnings(snap, "/p")).toEqual([projectWarning, broken, global]);
    expect(visibleAgentWarnings(snap, undefined)).toEqual([global]);
    expect(agentForWarning(snap, projectWarning, "/p")).toBe(loaded);
    expect(agentForWarning(snap, broken, "/p")).toBeUndefined();
  });

  it("refuses to delete the default agent and built-ins, with the reason", () => {
    const snap = snapshot();
    expect(deletability(agent({ name: "default" }), snap)).toEqual({ ok: false, reason: expect.stringContaining("default") });
    expect(deletability(agent({ name: "beam", kind: "builtin" }), snap).ok).toBe(false);
    expect(deletability(agent({ name: "reviewer" }), snap)).toEqual({ ok: true });
    expect(deletability(agent({ name: "default" }), { defaultAgent: "reviewer" })).toEqual({ ok: true });
  });

  it("finds the chosen skills the engine no longer discovers", () => {
    const chosen = [
      { name: "deploy", path: "/p/skills/deploy/SKILL.md", scope: "project" as const },
      { name: "review", path: "/home/u/skills/review/SKILL.md", scope: "global" as const },
    ];
    const listing = { skills: [chosen[1]!], roots: [] };
    expect(missingSkills(chosen, listing).map((s) => s.name)).toEqual(["deploy"]);
    expect(missingSkills(chosen, undefined)).toEqual([]);
  });

  it("says Namer's state in words", () => {
    expect(namerSummary({ status: "unqualified", model: null, candidates: [] }).title).toBe("Not qualified yet");
    expect(namerSummary({ status: "qualifying", model: null, candidates: [] }).title).toBe("Qualifying…");
    const ready = namerSummary({
      status: "ready",
      model: { provider: "openai", id: "gpt-mini" },
      candidates: [{ model: { provider: "openai", id: "gpt-mini" }, latencyMs: 412, valid: true }],
    });
    expect(ready.title).toBe("openai/gpt-mini");
    expect(ready.detail).toBe("412 ms on the check");
    expect(namerSummary({ status: "unavailable", model: null, candidates: [], reason: "No provider is connected." })).toEqual({ status: "unavailable", title: "Unavailable", detail: "No provider is connected." });
  });

  it("shapes a typed name into an agent_name and parses model choices", () => {
    expect(shapeAgentName("Code Reviewer!")).toBe("code-reviewer");
    expect(shapeAgentName("a".repeat(50))).toHaveLength(40);
    expect(parseModelChoice("openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
    expect(parseModelChoice("openrouter/openai/gpt-5")).toEqual({ provider: "openrouter", id: "openai/gpt-5" });
    expect(parseModelChoice("nope")).toBeUndefined();
  });

  it("checks whole numbers within a range and compares definitions structurally", () => {
    expect(checkRange("3", { min: 1, max: 6 }, "levels")).toEqual({ value: 3 });
    expect(checkRange("", { min: 1, max: 6 }, "levels")).toEqual({ error: "Enter a number." });
    expect(checkRange("2.5", { min: 1, max: 6 }, "levels")).toEqual({ error: "Whole numbers only." });
    expect(checkRange("9", { min: 1, max: 6 }, "levels")).toEqual({ error: "Between 1 and 6 levels." });
    const a = agentDefinitionInputOf(agent({ name: "x", description: "Reviews a diff" }));
    expect(sameDefinitionInput(a, agentDefinitionInputOf(agent({ name: "x", description: "Reviews a diff" })))).toBe(true);
    expect(sameDefinitionInput(a, { ...a, description: "Something else" })).toBe(false);
    expect(sameDefinitionInput(a, { ...a, excludeCoreInstructions: true })).toBe(false);
    expect(sameDefinitionInput(a, { ...a, scope: "project", projectCwd: "/p" })).toBe(false);
    expect(describeStarts({ supportsSubagents: true, allowedAgents: ["a", "b"] })).toBe("May start a, b");
  });

  it("offers only the thinking levels the chosen model accepts", () => {
    const catalog = [{ provider: "openai", id: "m", thinkingLevels: ["off", "low"] as const, enabled: true }];
    expect(thinkingLevelsFor({ provider: "openai", id: "m" }, catalog as never)).toEqual(["off", "low"]);
    expect(thinkingLevelsFor(null, catalog as never)).toHaveLength(7);
    expect(thinkingLevelsFor({ provider: "openai", id: "unknown" }, catalog as never)).toHaveLength(7);
  });
});
