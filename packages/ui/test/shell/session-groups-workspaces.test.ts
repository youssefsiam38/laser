import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@lasercode/protocol";
import { sessionGroups, workspaceKindOf } from "../../src/components/shell/session-groups.js";
import { createArchiveStore, visibleProjectCwds } from "../../src/runtime/threadList.js";
import { summary } from "../agents/fixtures.js";

const workspaces = { beam: "/state/workspaces/beam", chat: "/state/workspaces/chat" };
const project = (cwd: string): ProjectInfo => ({ cwd, name: cwd.slice(1), addedAt: "2026-09-08T00:00:00.000Z", trust: "not_required", pinned: false, sessionCount: 1 });

describe("Beam and Chat sessions from an older workspace layout", () => {
  const oldBeam = summary({ path: "/s/beam-old.jsonl", cwd: "/review/beam", agent: { agentName: "beam", kind: "beam" } });
  const newBeam = summary({ path: "/s/beam-new.jsonl", cwd: workspaces.beam, agent: { agentName: "beam", kind: "beam" } });
  const oldChat = summary({ path: "/s/chat-old.jsonl", cwd: "/review/chat", agent: { agentName: "chat", kind: "chat" } });
  const work = summary({ path: "/s/work.jsonl", cwd: "/p" });

  it("groups them by their record under the Beam group and the Chat tab, never as a directory of their own", () => {
    const code = sessionGroups(["/p"], [oldBeam, newBeam, oldChat, work], {}, {}, { tab: "code", workspaces });
    expect(code.map((g) => `${g.kind}:${g.cwd}`)).toEqual(["project:/p", `beam:${workspaces.beam}`]);
    expect(code[1]?.rows.map((r) => r.path).sort()).toEqual(["/s/beam-new.jsonl", "/s/beam-old.jsonl"]);
    const chat = sessionGroups(["/p"], [oldBeam, newBeam, oldChat, work], {}, {}, { tab: "chat", workspaces });
    expect(chat.map((g) => `${g.kind}:${g.cwd}`)).toEqual([`chat:${workspaces.chat}`]);
    expect(chat[0]?.rows.map((r) => r.path)).toEqual(["/s/chat-old.jsonl"]);
  });

  it("never lists built-in workspace descendants as projects, even before attribution arrives", () => {
    const archive = createArchiveStore(null);
    const privateBeam = summary({ path: "/s/beam-private.jsonl", cwd: `${workspaces.beam}/session-a1b2` });
    expect(
      visibleProjectCwds([project("/p"), project(privateBeam.cwd)], [oldBeam, newBeam, oldChat, privateBeam, work], {}, archive, {
        exclude: [workspaces.beam, workspaces.chat],
      }),
    ).toEqual(["/p"]);
    // A similarly named actual project is not a descendant of Chat.
    expect(visibleProjectCwds([project(`${workspaces.chat}ty`)], [], {}, archive, { exclude: [workspaces.chat] })).toEqual([`${workspaces.chat}ty`]);
  });

  it("recognises every private per-session directory as part of its built-in workspace", () => {
    expect(workspaceKindOf(`${workspaces.beam}/session-a1b2`, workspaces)).toBe("beam");
    expect(workspaceKindOf(`${workspaces.chat}/session-c3d4`, workspaces)).toBe("chat");
    expect(workspaceKindOf("/state/workspaces/chatty/session-c3d4", workspaces)).toBeUndefined();
  });

  it("groups private descendants correctly before their agent metadata arrives", () => {
    const privateBeam = summary({ path: "/s/beam-private.jsonl", cwd: `${workspaces.beam}/session-a1b2` });
    const privateChat = summary({ path: "/s/chat-private.jsonl", cwd: `${workspaces.chat}/session-c3d4` });

    expect(sessionGroups([], [privateBeam, privateChat], {}, {}, { tab: "code", workspaces })).toMatchObject([
      { cwd: workspaces.beam, name: "Beam", kind: "beam", rows: [{ path: privateBeam.path }] },
    ]);
    expect(sessionGroups([], [privateBeam, privateChat], {}, {}, { tab: "chat", workspaces })).toMatchObject([
      { cwd: workspaces.chat, name: "Chat", kind: "chat", rows: [{ path: privateChat.path }] },
    ]);
  });
});
