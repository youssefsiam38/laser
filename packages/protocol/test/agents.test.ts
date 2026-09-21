import { describe, expect, it } from "vitest";
import {
  PROJECT_DIR_NAME,
  RETIRED_AGENT_NAMES,
  canReferenceAgent,
  effectiveAgents,
  isRetiredAgentName,
  sessionKindOf,
  type AgentDefinition,
} from "../src/index.js";

function agent(name: string, patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    kind: "custom",
    scope: "global",
    description: "",
    instructions: "Do it.",
    engineInstructions: false,
    excludeCoreInstructions: false,
    profileId: null,
    thinkingLevel: null,
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("agent scope helpers", () => {
  const global = agent("reviewer", { path: "/state/agents/reviewer.md" });
  const localPath = `/one/${PROJECT_DIR_NAME}/agents/reviewer.md`;
  const otherPath = `/two/${PROJECT_DIR_NAME}/agents/other.md`;
  const local = agent("reviewer", {
    scope: "project",
    projectCwd: "/one",
    path: localPath,
  });
  const other = agent("other", {
    scope: "project",
    projectCwd: "/two",
    path: otherPath,
  });
  const agents = [global, local, other];

  it("selects globals, with a same-named project definition shadowing global", () => {
    expect(effectiveAgents(agents).map((candidate) => candidate.path ?? candidate.name)).toEqual([
      "/state/agents/reviewer.md",
    ]);
    expect(effectiveAgents(agents, "/one").map((candidate) => candidate.path ?? candidate.name)).toEqual([localPath]);
    expect(effectiveAgents(agents, "/two").map((candidate) => candidate.path ?? candidate.name)).toEqual([
      "/state/agents/reviewer.md",
      otherPath,
    ]);
  });

  it("applies reference boundaries with string-only project comparison", () => {
    expect(canReferenceAgent(global, global)).toBe(true);
    expect(canReferenceAgent(global, local)).toBe(false);
    expect(canReferenceAgent(local, global)).toBe(true);
    expect(canReferenceAgent(local, local)).toBe(true);
    expect(canReferenceAgent(local, other)).toBe(false);
    expect(canReferenceAgent({ scope: "project", projectCwd: "/one/." }, local)).toBe(false);
  });
});

describe("session kinds", () => {
  it("reads a chat conversation out of its own record, including an old one", () => {
    expect(sessionKindOf("chat")).toBe("chat");
    // Written before M23; the record is history and is never rewritten.
    expect(sessionKindOf("beam")).toBe("chat");
    expect(sessionKindOf("root")).toBe("project");
    expect(sessionKindOf("child")).toBe("project");
    // Anything a future writer invents is a project session, never a chat.
    expect(sessionKindOf("something-else")).toBe("project");
  });

  it("still knows the names that were built-in agents, so a person's file can be fixed", () => {
    expect([...RETIRED_AGENT_NAMES]).toEqual(["beam", "chat", "namer"]);
    expect(isRetiredAgentName("namer")).toBe(true);
    expect(isRetiredAgentName("reviewer")).toBe(false);
  });
});
