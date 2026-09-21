import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@lasercode/protocol";
import { sessionGroups, workspaceKindOf } from "../../src/components/shell/session-groups.js";
import { createArchiveStore, visibleProjectCwds } from "../../src/runtime/threadList.js";
import { agentInfo, summary } from "../agents/fixtures.js";

const workspaces = { chat: "/state/workspaces/chat" };
const project = (cwd: string): ProjectInfo => ({ cwd, name: cwd.slice(1), addedAt: "2026-09-08T00:00:00.000Z", trust: "not_required", pinned: false, sessionCount: 1 });

/**
 * Chat conversations, including the ones recorded before M23 (`docs/plain-chat.md`,
 * "Migration"): a stored `beam` record and an older workspace directory both
 * list under Chat, and neither ever becomes a project of its own.
 */
describe("Chat sessions, including pre-M23 records and workspace layouts", () => {
  const legacyBeam = summary({ path: "/s/beam-old.jsonl", cwd: "/review/beam", agent: agentInfo({ agentName: "beam", kind: "beam" }) });
  const oldChat = summary({ path: "/s/chat-old.jsonl", cwd: "/review/chat", agent: agentInfo({ kind: "chat" }) });
  const newChat = summary({ path: "/s/chat-new.jsonl", cwd: workspaces.chat, agent: agentInfo({ kind: "chat" }) });
  const work = summary({ path: "/s/work.jsonl", cwd: "/p" });

  it("lists every Chat record in the Chat tab by its kind, never as a directory of its own", () => {
    const sessions = [legacyBeam, oldChat, newChat, work];
    const code = sessionGroups(["/p"], sessions, {}, {}, { tab: "code", workspaces });
    // The Code tab is the projects, and only the projects: no workspace group.
    expect(code.map((g) => `${g.kind}:${g.cwd}`)).toEqual(["project:/p"]);
    const chat = sessionGroups(["/p"], sessions, {}, {}, { tab: "chat", workspaces });
    expect(chat.map((g) => `${g.kind}:${g.cwd}`)).toEqual([`chat:${workspaces.chat}`]);
    expect(chat[0]?.rows.map((r) => r.path).sort()).toEqual(["/s/beam-old.jsonl", "/s/chat-new.jsonl", "/s/chat-old.jsonl"]);
  });

  it("never lists Chat workspace descendants as projects, even before attribution arrives", () => {
    const archive = createArchiveStore(null);
    const privateChat = summary({ path: "/s/chat-private.jsonl", cwd: `${workspaces.chat}/session-a1b2` });
    expect(
      visibleProjectCwds([project("/p"), project(privateChat.cwd)], [legacyBeam, oldChat, newChat, privateChat, work], {}, archive, {
        exclude: [workspaces.chat],
      }),
    ).toEqual(["/p"]);
    // A similarly named actual project is not a descendant of Chat.
    expect(visibleProjectCwds([project(`${workspaces.chat}ty`)], [], {}, archive, { exclude: [workspaces.chat] })).toEqual([`${workspaces.chat}ty`]);
  });

  it("recognises every private per-session directory as part of the Chat workspace", () => {
    // The one shared rule (`isChatWorkspaceCwd`, M23 review S1): containment
    // over the roots the host sends, the retired pre-M23 directory included,
    // and a trailing separator says nothing about which directory this is.
    expect(workspaceKindOf(workspaces.chat, workspaces)).toBe("chat");
    expect(workspaceKindOf(`${workspaces.chat}/session-c3d4`, workspaces)).toBe("chat");
    expect(workspaceKindOf(`${workspaces.chat}/session-c3d4/`, workspaces)).toBe("chat");
    expect(workspaceKindOf("/state/workspaces/beam/session-aaa", workspaces)).toBe("chat");
    expect(workspaceKindOf("/state/workspaces/chatty/session-c3d4", workspaces)).toBeUndefined();
    expect(workspaceKindOf("/state/workspaces/beamer", workspaces)).toBeUndefined();
    expect(workspaceKindOf("/p", workspaces)).toBeUndefined();
    expect(workspaceKindOf(undefined, workspaces)).toBeUndefined();
    expect(workspaceKindOf(`${workspaces.chat}/session-c3d4`, {})).toBeUndefined();
  });

  it("groups private descendants correctly before their agent metadata arrives", () => {
    const privateChat = summary({ path: "/s/chat-private.jsonl", cwd: `${workspaces.chat}/session-c3d4` });
    const projectSession = summary({ path: "/s/work.jsonl", cwd: "/p" });

    expect(sessionGroups([], [privateChat, projectSession], {}, {}, { tab: "chat", workspaces })).toMatchObject([
      { cwd: workspaces.chat, name: "Chat", kind: "chat", rows: [{ path: privateChat.path }] },
    ]);
    expect(sessionGroups([], [privateChat, projectSession], {}, {}, { tab: "code", workspaces })).toMatchObject([
      { cwd: "/p", kind: "project", rows: [{ path: projectSession.path }] },
    ]);
  });
});
