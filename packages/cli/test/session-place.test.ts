/**
 * What the tables call a conversation's place. A project session is its
 * directory; a plain Chat belongs to no project and says "Chat"
 * (`docs/plain-chat.md`, "What a person sees") rather than exposing the
 * private workspace directory it happens to run in.
 */
import { describe, expect, it } from "vitest";
import type { SessionAgentInfo, SessionSummary } from "@lasercode/protocol";
import { sessionPlace } from "../src/format.js";

const session = (cwd: string, agent?: SessionAgentInfo): SessionSummary => ({
  id: "s1",
  path: `${cwd}/s1.jsonl`,
  cwd,
  createdAt: "2026-09-05T00:00:00.000Z",
  modifiedAt: "2026-09-05T00:00:00.000Z",
  messageCount: 1,
  ...(agent ? { agent } : {}),
});

describe("a session's place", () => {
  it("names a Chat rather than its private workspace directory", () => {
    expect(sessionPlace(session("/state/workspaces/chat/session-a1b2", { kind: "chat", sessionKind: "chat" }))).toBe("Chat");
  });

  it("reads a conversation recorded before M23 as the Chat it is now", () => {
    // The stored record still says `beam` and is never rewritten; the CLI has
    // to read it, not reprint it.
    expect(sessionPlace(session("/state/workspaces/beam/session-a1b2", { agentName: "beam", kind: "chat", sessionKind: "chat" }))).toBe("Chat");
  });

  it("keeps a project session on its directory, agent or not", () => {
    expect(sessionPlace(session("/work/repo", { agentName: "reviewer", kind: "root", sessionKind: "project" }))).toBe("/work/repo");
    expect(sessionPlace(session("/work/repo", { agentName: "reviewer", kind: "child", sessionKind: "project" }))).toBe("/work/repo");
    // No record at all (an unwritten session the host cannot attribute yet):
    // the directory is all there is, and it is still the honest answer.
    expect(sessionPlace(session("/work/repo"))).toBe("/work/repo");
  });
});
