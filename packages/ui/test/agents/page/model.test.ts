import { PROJECT_AGENTS_DIR } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import {
  agentForWarning,
  agentsInScope,
  checkRange,
  deletability,
  describeStarts,
  fileWarningIsVisible,
  isFirstRun,
  missingSkills,
  namerSummary,
  parseModelChoice,
  sameDefinitionInput,
  sameSelection,
  selectionOfAgent,
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
    const { custom, builtin } = agentsInScope(snap, "global");
    expect(custom.map((a) => a.name)).toEqual(["default", "alpha", "zeta"]);
    expect(builtin.map((a) => a.name)).toEqual(["beam", "chat", "namer"]);
    expect(agentsInScope(snapshot({ ...snap, defaultAgent: "zeta" }), "global").custom.map((a) => a.name)).toEqual(["zeta", "default", "alpha"]);
    expect(isFirstRun(snapshot({ agents: [agent({ name: "default" })] }), "global")).toBe(true);
    expect(isFirstRun(snap, "global")).toBe(false);
  });

  it("projects Global, Project and Effective from one exact scope model", () => {
    const snap = snapshot({
      agents: [
        ...snapshot().agents,
        agent({ name: "reviewer", scope: "project", projectCwd: "/p", description: "Project shadow" }),
        agent({ name: "project-only", scope: "project", projectCwd: "/p" }),
        agent({ name: "other-project", scope: "project", projectCwd: "/q" }),
      ],
    });
    expect(agentsInScope(snap, "global").custom.map((candidate) => `${candidate.scope}:${candidate.name}`)).toEqual([
      "global:default",
      "global:reviewer",
    ]);
    expect(agentsInScope(snap, "global").builtin.map((candidate) => candidate.name)).toEqual(["beam", "chat", "namer"]);
    expect(agentsInScope(snap, "project", "/p").custom.map((candidate) => `${candidate.scope}:${candidate.name}`)).toEqual([
      "project:project-only",
      "project:reviewer",
      "global:default",
      "global:reviewer",
    ]);
    expect(agentsInScope(snap, "project", "/p").builtin).toEqual([]);
    expect(agentsInScope(snap, "effective", "/p").custom.map((candidate) => `${candidate.scope}:${candidate.name}`)).toEqual([
      "global:default",
      "project:project-only",
      "project:reviewer",
    ]);
    expect(agentsInScope(snap, "effective", "/p").builtin).toEqual([]);
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

  it("keys warnings by definition path and filters broken files to the open project", () => {
    const loaded = agent({ name: "reviewer", path: `/p/${PROJECT_AGENTS_DIR}/reviewer.md`, scope: "project", projectCwd: "/p" });
    const foreign = agent({ name: "other-project", path: `/q/${PROJECT_AGENTS_DIR}/other-project.md`, scope: "project", projectCwd: "/q" });
    const projectWarning = { agentName: "reviewer", field: "file" as const, path: loaded.path, target: loaded.path, message: "Could not parse this file.", since: "2026-09-08T00:00:00.000Z" };
    const broken = { agentName: "broken", field: "file" as const, path: `/p/${PROJECT_AGENTS_DIR}/broken.md`, target: `/p/${PROJECT_AGENTS_DIR}/broken.md`, message: "Could not parse this file.", since: "2026-09-08T00:00:00.000Z" };
    const other = { ...broken, agentName: "other", path: `/q/${PROJECT_AGENTS_DIR}/other.md`, target: `/q/${PROJECT_AGENTS_DIR}/other.md` };
    const global = { ...broken, agentName: "global-broken", path: "/state/agents/global-broken.md", target: "/state/agents/global-broken.md" };
    const sameNameDifferentFile = { ...projectWarning, field: "model" as const, path: "/state/agents/reviewer.md", target: "missing-model" };
    const legacyWithoutPath = { ...projectWarning, field: "model" as const, path: undefined, target: "missing-model" };
    const snap = snapshot({ agents: [...snapshot().agents, loaded, foreign], warnings: [projectWarning, broken, other, global, sameNameDifferentFile] });
    expect(fileWarningIsVisible(projectWarning, snap, "project", "/p", ["/p", "/q"])).toBe(true);
    expect(fileWarningIsVisible(other, snap, "project", "/p", ["/p", "/q"])).toBe(false);
    expect(visibleAgentWarnings(snap, "project", "/p", ["/p", "/q"])).toEqual([projectWarning, broken, global, legacyWithoutPath].filter((warning) => snap.warnings.includes(warning)));
    expect(visibleAgentWarnings(snap, "global", undefined, ["/p", "/q"])).toEqual([global]);
    expect(agentForWarning(snap, projectWarning, "project", "/p")).toBe(loaded);
    expect(agentForWarning(snap, sameNameDifferentFile, "project", "/p")).toBeUndefined();
    expect(agentForWarning(snap, legacyWithoutPath, "project", "/p")).toBeUndefined();
    expect(agentForWarning(snap, broken, "project", "/p")).toBeUndefined();
  });

  it("keys selection and default protection by exact source location", () => {
    const snap = snapshot();
    const global = agent({ name: "default", scope: "global" });
    const project = agent({ name: "default", scope: "project", projectCwd: "/p" });
    expect(sameSelection(selectionOfAgent(global), selectionOfAgent(project))).toBe(false);
    expect(sameSelection(selectionOfAgent(project), { kind: "agent", name: "default", location: { scope: "project", projectCwd: "/p" } })).toBe(true);
    expect(deletability(global, snap)).toEqual({ ok: false, reason: expect.stringContaining("default") });
    expect(deletability(project, snap)).toEqual({ ok: true });
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
