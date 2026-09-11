import { describe, expect, it } from "vitest";
import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import {
  codeProjectForSession,
  creationTargetForDestination,
  destinationSessionForTab,
  initialMainDestination,
} from "../../src/runtime/main-destination.js";

const item = (path: string, cwd: string, modifiedAt: string, agent?: SessionSummary["agent"]): SessionSummary => ({
  path,
  id: path,
  cwd,
  messageCount: 1,
  createdAt: modifiedAt,
  modifiedAt,
  ...(agent ? { agent } : {}),
});

const CHAT = item("/chat/one", "/private/chat/one", "2026-09-10T00:00:00Z", { agentName: "chat", kind: "chat" });
const CODE = item("/code/new", "/project", "2026-09-11T00:00:00Z");
const OLD_CODE = item("/code/old", "/project", "2026-09-09T00:00:00Z");

describe("main destination model", () => {
  it("chooses a valid remembered row before newest and never crosses tabs", () => {
    const source = { sessions: [CHAT, CODE, OLD_CODE], views: {}, workspaces: { chat: "/private/chat" } };
    expect(destinationSessionForTab("code", OLD_CODE.path, source)?.path).toBe(OLD_CODE.path);
    expect(destinationSessionForTab("code", CHAT.path, source)?.path).toBe(CODE.path);
    expect(destinationSessionForTab("chat", CODE.path, source)?.path).toBe(CHAT.path);
    expect(destinationSessionForTab("chat", undefined, { ...source, archived: (path: string) => path === CHAT.path })).toBeUndefined();
  });

  it("creates Chat only from its workspace and Code only from Code memory", () => {
    const chat = { ...initialMainDestination, tab: "chat" as const, phase: "ready" as const, intent: 3 };
    expect(creationTargetForDestination(chat, "/private/chat")).toEqual({ cwd: "/private/chat", agentName: "chat", intent: 3 });
    expect(creationTargetForDestination(chat, undefined)).toBeUndefined();
    const code = { ...chat, tab: "code" as const, codeProject: "/project" };
    expect(creationTargetForDestination(code, "/private/chat")).toEqual({ cwd: "/project", intent: 3 });
    expect(creationTargetForDestination({ ...code, codeProject: undefined }, "/private/chat")).toBeUndefined();
  });

  it("resolves children to the root project and lets Beam retain Code memory", () => {
    const root = item("/project/root", "/project", "2026-09-09T00:00:00Z");
    const child = item("/project/.worktrees/child/session", "/project/.worktrees/child", "2026-09-10T00:00:00Z", {
      agentName: "worker",
      kind: "child",
      parentPath: root.path,
      rootPath: root.path,
      runId: "run",
      subagentName: "child",
    });
    const beam = item("/beam/session", "/private/beam", "2026-09-10T00:00:00Z", { agentName: "beam", kind: "beam" });
    expect(codeProjectForSession(child, [root, child], {}, "/other")).toBe("/project");
    expect(codeProjectForSession(beam, [beam], {}, "/project")).toBe("/project");

    const detached = { ...child, agent: { ...child.agent!, parentPath: "/gone", rootPath: "/gone" } };
    const run: AgentRun = {
      runId: "run",
      sessionId: "child",
      sessionPath: detached.path,
      rootSessionPath: "/gone",
      parent: { sessionId: "gone", sessionPath: "/gone" },
      subagentName: "child",
      agentName: "worker",
      projectCwd: "/actual-project",
      depth: 1,
      status: "completed",
      startedAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-10T00:00:00Z",
      endedAt: "2026-09-10T00:00:00Z",
    };
    expect(codeProjectForSession(detached, [detached], { run }, "/other")).toBe("/actual-project");
  });
});
