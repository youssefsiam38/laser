import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@lasercode/protocol";
import { sessionGroups } from "../../src/components/shell/session-groups.js";
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

  it("never lists their directories as projects in the rail", () => {
    const archive = createArchiveStore(null);
    expect(visibleProjectCwds([project("/p")], [oldBeam, newBeam, oldChat, work], {}, archive, { exclude: [workspaces.beam, workspaces.chat] })).toEqual(["/p"]);
  });
});
