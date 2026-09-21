import { describe, expect, it } from "vitest";
import {
  PROJECT_DIR_NAME,
  RETIRED_AGENT_NAMES,
  canReferenceAgent,
  chatWorkspaceRoots,
  effectiveAgents,
  isChatWorkspaceCwd,
  isRetiredAgentName,
  isWithinWorkspaceRoot,
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

/**
 * The one directory rule every surface answers "is this a Chat conversation's
 * working directory" with (M23 review, S1; D-u). The host adds alias
 * resolution by passing its own containment test; the roots it checks, and
 * what counts as inside one, are decided here and nowhere else.
 */
describe("the Chat workspace directory rule", () => {
  const workspaces = { chat: "/state/workspaces/chat" };

  it("accepts the workspace root and every per-session folder under it", () => {
    expect(isChatWorkspaceCwd("/state/workspaces/chat", workspaces)).toBe(true);
    expect(isChatWorkspaceCwd("/state/workspaces/chat/session-c3d4", workspaces)).toBe(true);
    expect(isChatWorkspaceCwd("/state/workspaces/chat/session-c3d4/nested", workspaces)).toBe(true);
  });

  it("accepts the retired directory a pre-M23 conversation still names", () => {
    // Nothing moves those folders and nothing rewrites those headers
    // (`docs/plain-chat.md`, "Migration"): the rule is what makes them Chats.
    expect(chatWorkspaceRoots(workspaces)).toEqual(["/state/workspaces/chat", "/state/workspaces/beam"]);
    expect(isChatWorkspaceCwd("/state/workspaces/beam", workspaces)).toBe(true);
    expect(isChatWorkspaceCwd("/state/workspaces/beam/session-aaa", workspaces)).toBe(true);
  });

  it("refuses a sibling that merely starts with the same characters", () => {
    expect(isChatWorkspaceCwd("/state/workspaces/chatty", workspaces)).toBe(false);
    expect(isChatWorkspaceCwd("/state/workspaces/chatty/session-c3d4", workspaces)).toBe(false);
    expect(isChatWorkspaceCwd("/state/workspaces/beamer/session-aaa", workspaces)).toBe(false);
    expect(isChatWorkspaceCwd("/home/someone/work", workspaces)).toBe(false);
  });

  it("reads a trailing separator, on either side, as the same directory", () => {
    expect(isChatWorkspaceCwd("/state/workspaces/chat/", workspaces)).toBe(true);
    expect(isChatWorkspaceCwd("/state/workspaces/chat/session-c3d4/", workspaces)).toBe(true);
    expect(isChatWorkspaceCwd("/state/workspaces/chat/session-c3d4", { chat: "/state/workspaces/chat/" })).toBe(true);
    expect(isWithinWorkspaceRoot("C:\\state\\workspaces\\chat\\session-c3d4", "C:/state/workspaces/chat")).toBe(true);
  });

  it("says no rather than guessing while the snapshot has not arrived", () => {
    expect(chatWorkspaceRoots(undefined)).toEqual([]);
    expect(chatWorkspaceRoots({})).toEqual([]);
    expect(isChatWorkspaceCwd("/state/workspaces/chat", undefined)).toBe(false);
    expect(isChatWorkspaceCwd("/state/workspaces/chat", null)).toBe(false);
    expect(isChatWorkspaceCwd(undefined, workspaces)).toBe(false);
    expect(isChatWorkspaceCwd("", workspaces)).toBe(false);
  });

  it("lets a caller answer with its own containment, which is how the host resolves aliases", () => {
    // What `realpathSync` does on macOS, in one line: the same directory,
    // reached by two names, is one directory.
    const real = (path: string): string => (path.startsWith("/private/") ? path.slice("/private".length) : path);
    const resolving = (cwd: string, root: string): boolean => isWithinWorkspaceRoot(real(cwd), real(root));
    const aliased = { chat: "/var/state/workspaces/chat" };
    expect(isChatWorkspaceCwd("/private/var/state/workspaces/chat/session-aaa", aliased, resolving)).toBe(true);
    expect(isChatWorkspaceCwd("/private/var/state/workspaces/beam/session-aaa", aliased, resolving)).toBe(true);
    expect(isChatWorkspaceCwd("/private/var/state/workspaces/chatty", aliased, resolving)).toBe(false);
    // Without it, the plain rule cannot know the two names are one place.
    expect(isChatWorkspaceCwd("/private/var/state/workspaces/chat/session-aaa", aliased)).toBe(false);
  });
});
