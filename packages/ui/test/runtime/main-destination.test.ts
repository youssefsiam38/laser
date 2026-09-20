import { describe, expect, it } from "vitest";
import type { AgentRun, SessionSummary } from "@lasercode/protocol";

import {
  codeProjectForSession,
  creationTargetForDestination,
  destinationSessionForTab,
  isSessionInCodeProject,
  landingWorkspaceOf,
  type MainDestination,
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

  it("creates Chat only from its landing workspace and Code only from Code memory", () => {
    const chat = { phase: "ready-chat" as const, chat: { kind: "landing" as const }, rememberedCode: { kind: "project-landing" as const, project: "/project" }, intent: 3 };
    expect(creationTargetForDestination(chat, "/private/chat")).toEqual({ cwd: "/private/chat", agentName: "chat", intent: 3 });
    expect(creationTargetForDestination(chat, undefined)).toBeUndefined();
    const code = { phase: "ready-code" as const, code: { kind: "project-landing" as const, project: "/project" }, intent: 3 };
    expect(creationTargetForDestination(code, "/private/chat")).toEqual({ cwd: "/project", intent: 3 });
    expect(creationTargetForDestination({ ...code, code: { kind: "no-project-landing" as const } }, "/private/chat")).toBeUndefined();
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
    expect(isSessionInCodeProject(child, [root, child], {}, "/project")).toBe(true);
    expect(isSessionInCodeProject(beam, [beam], {}, "/project")).toBe(false);

    const parentless = { ...child, agent: { ...child.agent!, parentPath: "/gone", rootPath: "/gone" } };
    const run: AgentRun = {
      runId: "run",
      sessionId: "child",
      sessionPath: parentless.path,
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
    expect(codeProjectForSession(parentless, [parentless], { run }, "/other")).toBe("/actual-project");
  });

  /**
   * D-341: the landing draws its place from the destination alone, and knows
   * it in every phase — including while the host is still being asked, where
   * the target or the remembered destination already names the project.
   */
  it("names the landing's workspace from the destination in every phase, before the host answers", () => {
    const project = { kind: "project-landing" as const, project: "/project" };
    const remembered = { kind: "project-session" as const, project: "/remembered", path: "/remembered/s.jsonl" };
    const cases: [MainDestination, ReturnType<typeof landingWorkspaceOf>][] = [
      [{ phase: "ready-code", intent: 1, code: project }, { kind: "project", cwd: "/project" }],
      [{ phase: "ready-code", intent: 1, code: { kind: "project-session", project: "/project", path: "/project/new.jsonl" } }, { kind: "project", cwd: "/project" }],
      [{ phase: "ready-code", intent: 1, code: { kind: "beam-session", path: "/b", returnTo: project } }, { kind: "beam" }],
      [{ phase: "ready-code", intent: 1, code: { kind: "no-project-landing" } }, { kind: "none" }],
      [{ phase: "ready-chat", intent: 1, chat: { kind: "landing" }, rememberedCode: project }, { kind: "chat" }],
      [{ phase: "ready-chat", intent: 1, chat: { kind: "session", path: "/c" }, rememberedCode: project }, { kind: "chat" }],
      // Resolving: the target names the place first, memory stands in after.
      [{ phase: "resolving", intent: 1, target: { kind: "project", project: "/target" }, rememberedCode: remembered }, { kind: "project", cwd: "/target" }],
      [{ phase: "resolving", intent: 1, target: { kind: "startup-project", project: "/target" }, rememberedCode: remembered }, { kind: "project", cwd: "/target" }],
      [{ phase: "resolving", intent: 1, target: { kind: "code-tab", code: project }, rememberedCode: remembered }, { kind: "project", cwd: "/project" }],
      [{ phase: "resolving", intent: 1, target: { kind: "chat-tab" }, rememberedCode: remembered }, { kind: "chat" }],
      [{ phase: "resolving", intent: 1, target: { kind: "startup-code" }, rememberedCode: remembered }, { kind: "project", cwd: "/remembered" }],
      [{ phase: "resolving", intent: 1, target: { kind: "session", path: "/s", visibleTab: "code" }, rememberedCode: remembered }, { kind: "project", cwd: "/remembered" }],
      [{ phase: "resolving", intent: 1, target: { kind: "session", path: "/s", visibleTab: "chat" }, rememberedCode: remembered }, { kind: "chat" }],
      [{ phase: "unavailable", intent: 1, target: { kind: "project", project: "/target" }, rememberedCode: remembered, error: "gone" }, { kind: "project", cwd: "/target" }],
    ];
    for (const [destination, expected] of cases) expect(landingWorkspaceOf(destination), JSON.stringify(destination)).toEqual(expected);
  });
});
