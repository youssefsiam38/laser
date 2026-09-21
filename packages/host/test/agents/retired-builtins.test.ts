/**
 * M23-T3 · what a machine that ran the previous generation still holds, and
 * what happens to it (`docs/plain-chat.md`, "Migration"; D-347).
 *
 * Three things a person would notice if they were got wrong:
 *
 * 1. conversations kept under `<state>/workspaces/beam` are read as Chats
 *    where they are — nothing is moved, so their files stay in the directory
 *    their session header names (M23 review, B1);
 * 2. a session whose stored record names `beam` or `chat` reads as a Chat,
 *    without that record being rewritten;
 * 3. an agent file listing one of the removed names in `allowedAgents` keeps
 *    working, with a warning on that field and the name dropped.
 *
 * Opening one of those conversations through a real worker — the case the
 * move got wrong — is proved in `retired-workspace-open.e2e.test.ts`.
 */
import { GLOBAL_AGENTS_DIR_NAME, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../../src/catalog.js";
import { AgentStore } from "../../src/agents/store.js";
import { HostServer } from "../../src/server.js";
import { chatWorkspaceDir, isChatWorkspace, retiredBeamWorkspaceDir, workspacesDir } from "../../src/paths.js";

let base: string;
let stateDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-retired-builtins-`));
  stateDir = join(base, "state");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const root = () => workspacesDir(stateDir);
const beamDir = () => retiredBeamWorkspaceDir(root());
const chatDir = () => chatWorkspaceDir(stateDir);

function workspaceFolder(parent: string, name: string, contents = "kept"): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), contents);
  return dir;
}

describe("conversations kept in the retired workspace", () => {
  it("leaves every folder exactly where it is, at every host start, and creates nothing beside it", async () => {
    const kept = workspaceFolder(beamDir(), "session-aaa", "a conversation from before");
    // Two starts: "re-homed as Chat" is a mapping, not a move, so neither one
    // may touch a byte of this. A move would strand the person's files,
    // because nothing rewrites the session header that names this directory
    // — the engine would recreate it, empty, on the first open (B1).
    for (const pass of [1, 2]) {
      const host = new HostServer({
        agentDir: join(base, "agent"),
        sessionDir: join(base, "sessions"),
        stateDir,
        log: () => {},
      });
      try {
        expect(readFileSync(join(kept, "notes.md"), "utf8"), `pass ${pass}`).toBe("a conversation from before");
        expect(existsSync(join(chatDir(), "session-aaa")), `pass ${pass}`).toBe(false);
      } finally {
        await host.close();
      }
    }
  });

  it("reads the retired folder, and every folder in it, as the chat workspace", () => {
    // A conversation written before M23 still names the old directory, and
    // nothing rewrites it. It is a chat either way, and a reader that forgot
    // that would stop listing it and stop opening it.
    const workspaces = { chat: chatDir() };
    expect(isChatWorkspace(chatDir(), workspaces)).toBe(true);
    expect(isChatWorkspace(join(chatDir(), "session-aaa"), workspaces)).toBe(true);
    expect(isChatWorkspace(beamDir(), workspaces)).toBe(true);
    expect(isChatWorkspace(join(beamDir(), "session-aaa"), workspaces)).toBe(true);
    // The one shared rule is containment, not a shared prefix (S1).
    expect(isChatWorkspace(`${chatDir()}ty`, workspaces)).toBe(false);
    expect(isChatWorkspace(join(root(), "beamer", "session-aaa"), workspaces)).toBe(false);
    expect(isChatWorkspace(join(base, "project"), workspaces)).toBe(false);
  });
});

describe("a session whose record names a removed built-in", () => {
  it("reads as a chat, with no agent name, and its file is never rewritten", () => {
    const sessions = join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    const write = (name: string, cwd: string, record: unknown): string => {
      const path = join(sessions, name);
      const bytes =
        `${JSON.stringify({ type: "session", version: 3, id: name, cwd, timestamp: "2026-01-01T00:00:00.000Z" })}\n` +
        `${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: record })}\n`;
      writeFileSync(path, bytes);
      return path;
    };
    const beamSession = write("beam.jsonl", join(beamDir(), "session-aaa"), { agentName: "beam", kind: "beam" });
    const chatSession = write("chat.jsonl", join(chatDir(), "session-bbb"), { agentName: "chat", kind: "chat" });
    const projectSession = write("project.jsonl", join(base, "project"), { agentName: "reviewer", kind: "root" });
    const before = [beamSession, chatSession].map((path) => readFileSync(path, "utf8"));

    const catalog = new SessionCatalog(sessions);
    expect(catalog.get(beamSession)?.agent).toEqual({ kind: "chat", sessionKind: "chat" });
    expect(catalog.get(chatSession)?.agent).toEqual({ kind: "chat", sessionKind: "chat" });
    expect(catalog.get(projectSession)?.agent).toEqual({ agentName: "reviewer", kind: "root", sessionKind: "project" });
    // History is evidence: reading one changes nothing about it.
    expect([beamSession, chatSession].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});

describe("an agent file that lists a removed built-in as a child", () => {
  it("runs with the name dropped and warns on that field", async () => {
    const agents = join(stateDir, GLOBAL_AGENTS_DIR_NAME);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "lead.md"), [
      "---",
      "description: leads the work",
      "supportsSubagents: true",
      "allowedAgents:",
      "  - beam",
      "  - lead",
      "  - namer",
      "---",
      "Lead the work.",
      "",
    ].join("\n"));
    const store = new AgentStore({
      storePath: join(stateDir, "agents.json"),
      stateDir,
      agentDir: join(base, "agent"),
      workspaces: { chat: chatDir() },
    });
    try {
      await vi.waitFor(() => expect(store.get("lead")).toBeDefined(), { timeout: 5_000, interval: 10 });
      // It runs, and it runs without the names nothing answers to.
      expect(store.get("lead")?.allowedAgents).toEqual(["lead"]);
      const warning = store.warnings().find((item) => item.agentName === "lead");
      expect(warning).toMatchObject({ field: "allowedAgents", target: "beam", path: join(agents, "lead.md") });
      expect(warning?.message).toContain('"beam", "namer"');
      expect(warning?.message).toContain("allowed agents");
      // The file is the person's; nothing rewrote it behind their back.
      expect(readFileSync(join(agents, "lead.md"), "utf8")).toContain("- beam");
    } finally {
      store.close();
    }
  });
});
