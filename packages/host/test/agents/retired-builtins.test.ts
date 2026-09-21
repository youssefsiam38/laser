/**
 * M23-T3 · what a machine that ran the previous generation still holds, and
 * what happens to it (`docs/plain-chat.md`, "Migration"; D-347).
 *
 * Three things a person would notice if they were got wrong:
 *
 * 1. conversations kept under `<state>/workspaces/beam` are re-homed and still
 *    open, still listed, with their transcripts untouched;
 * 2. a session whose stored record names `beam` or `chat` reads as a Chat,
 *    without that record being rewritten;
 * 3. an agent file listing one of the removed names in `allowedAgents` keeps
 *    working, with a warning on that field and the name dropped.
 */
import { GLOBAL_AGENTS_DIR_NAME, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalog } from "../../src/catalog.js";
import { AgentStore } from "../../src/agents/store.js";
import { HostServer } from "../../src/server.js";
import { chatWorkspaceDir, isChatWorkspace, rehomeRetiredWorkspaces, retiredBeamWorkspaceDir, workspacesDir } from "../../src/paths.js";

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
  it("moves every folder into the chat workspace, keeps what is in them, and clears the old directory", () => {
    workspaceFolder(beamDir(), "session-aaa", "first chat");
    workspaceFolder(beamDir(), "session-bbb", "second chat");
    mkdirSync(chatDir(), { recursive: true });

    const result = rehomeRetiredWorkspaces(root());
    expect(result.moved.map((path) => path.replace(`${chatDir()}/`, "")).sort()).toEqual(["session-aaa", "session-bbb"]);
    expect(result.kept).toEqual([]);
    // The work inside them is the person's, and it came along untouched.
    expect(readFileSync(join(chatDir(), "session-aaa", "notes.md"), "utf8")).toBe("first chat");
    expect(readFileSync(join(chatDir(), "session-bbb", "notes.md"), "utf8")).toBe("second chat");
    // Nothing is left behind, including the directory itself.
    expect(existsSync(beamDir())).toBe(false);

    // Idempotent: a second start finds nothing to do and says so.
    expect(rehomeRetiredWorkspaces(root())).toEqual({ moved: [], kept: [] });
  });

  it("leaves a folder it cannot move exactly where it is, and moves the rest", () => {
    workspaceFolder(beamDir(), "session-aaa", "from the retired folder");
    workspaceFolder(beamDir(), "session-bbb", "also retired");
    // A folder of the same name is already there: the one that arrives second
    // must not overwrite the one that is already a person's conversation.
    workspaceFolder(chatDir(), "session-aaa", "already a chat");

    const result = rehomeRetiredWorkspaces(root());
    expect(result.moved).toEqual([join(chatDir(), "session-bbb")]);
    expect(result.kept).toEqual([join(beamDir(), "session-aaa")]);
    expect(readFileSync(join(chatDir(), "session-aaa", "notes.md"), "utf8")).toBe("already a chat");
    expect(readFileSync(join(beamDir(), "session-aaa", "notes.md"), "utf8")).toBe("from the retired folder");
    // Something is still in it, so the directory stays.
    expect(existsSync(beamDir())).toBe(true);
  });

  it("does nothing at all when the retired folder was never there", () => {
    expect(rehomeRetiredWorkspaces(root())).toEqual({ moved: [], kept: [] });
    expect(existsSync(beamDir())).toBe(false);
  });

  it("happens at host start, without anything being asked of it", async () => {
    workspaceFolder(beamDir(), "session-aaa", "a conversation from before");
    const host = new HostServer({
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir,
      log: () => {},
    });
    try {
      expect(readFileSync(join(chatDir(), "session-aaa", "notes.md"), "utf8")).toBe("a conversation from before");
      expect(existsSync(beamDir())).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("keeps routing a transcript that still names the retired folder as a chat", () => {
    // The move does not rewrite a stored session header, so a conversation
    // written before M23 still names the old directory. It is a chat either
    // way, and a reader that forgot that would stop listing it.
    const workspaces = { chat: chatDir() };
    expect(isChatWorkspace(join(chatDir(), "session-aaa"), workspaces)).toBe(true);
    expect(isChatWorkspace(join(beamDir(), "session-aaa"), workspaces)).toBe(true);
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
