/**
 * `pi/session/move` (M13-T58): a Chat session becomes a project's, through
 * the host, with a real catalog over real files. What is checked is what a
 * person would see — the rows before and after, the file's new home, the
 * project appearing in the list — and every refusal that protects the
 * invariants: never two writers on one file, a child stays with its parent's
 * tree, a live run is not abandoned.
 */
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type SessionSummary } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { AgentStore } from "../src/agents/store.js";
import { AttentionTracker } from "../src/attention.js";
import { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import { WorkerRpcError } from "../src/worker-client.js";
import type { WorkerPool } from "../src/worker-pool.js";

let base: string;
let sessionRoot: string;
let chat: string;
let project: string;

/** A session file in the Chat workspace, as the worker writes one. */
function chatSession(name: string, over: { record?: object | null; parentSession?: string } = {}): string {
  const dir = join(sessionRoot, "--chat--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const record = over.record === null ? [] : [JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: over.record ?? { agentName: "chat", kind: "chat" } })];
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", version: 3, id: name.replace(".jsonl", ""), timestamp: "2026-09-01T00:00:00Z", cwd: chat, ...(over.parentSession ? { parentSession: over.parentSession } : {}) }),
      ...record,
      JSON.stringify({ type: "session_info", name: "Recipe ideas" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Ideas for dinner" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Pasta." }] } }),
      "",
    ].join("\n"),
  );
  return path;
}

function harness(options: { open?: string[]; closeRefuses?: string } = {}) {
  const catalog = new SessionCatalog(sessionRoot);
  const open = new Set(options.open ?? []);
  const workerRequests: Array<{ cwd: string; method: string; params: unknown }> = [];
  const forgotten: string[] = [];
  const pool = {
    openSessions: (cwd: string) => (cwd === chat ? [...open] : []),
    cwdOfSession: () => undefined,
    bindSession: () => {},
    forgetSession: (path: string) => {
      forgotten.push(path);
      open.delete(path);
    },
    get: async (cwd: string) => ({
      request: async (method: string, params: unknown) => {
        workerRequests.push({ cwd, method, params });
        if (method === "pi/session/close") {
          if (options.closeRefuses) throw new WorkerRpcError({ code: -32001, message: options.closeRefuses });
          const { path } = params as { path: string };
          const held = open.delete(path);
          return { closed: held };
        }
        return {};
      },
    }),
  } as unknown as WorkerPool;
  const stateDir = join(base, "state");
  const workspaces = { beam: join(stateDir, "workspaces", "beam"), chat };
  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: join(base, "projects"), exclude: [workspaces.beam, workspaces.chat] });
  const agents = new AgentStore({ agentDir: join(base, "agent"), workspaces });
  const runs = new AgentRunRegistry({ now: () => new Date("2026-09-02T00:00:00.000Z") });
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), agents, runs });
  const rpc = (method: string, params: unknown) => router.handle({ jsonrpc: "2.0", id: 1, method, params }) as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  const rows = async () => ((await rpc("pi/session/list", {})).result as { sessions: SessionSummary[] }).sessions;
  return {
    router,
    rpc,
    rows,
    catalog,
    attention,
    projects,
    runs,
    workerRequests,
    forgotten,
    cleanup: () => {
      projects.close();
      attention.close();
      runs.close();
    },
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-move-`));
  sessionRoot = join(base, "agent", "sessions");
  chat = join(base, "state", "workspaces", "chat");
  project = join(base, "code", "app");
  mkdirSync(chat, { recursive: true });
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("Router · pi/session/move", () => {
  it("moves a closed Chat session into a project: new home, header, record, rows, and the project itself", async () => {
    const path = chatSession("s1.jsonl");
    const h = harness();
    try {
      const before = await h.rows();
      expect(before.map((row) => [row.path, row.cwd, row.agent?.kind])).toEqual([[path, chat, "chat"]]);
      expect(h.projects.list().map((p) => p.cwd)).toEqual([]);
      h.attention.markSeen(path, chat);

      const moved = (await h.rpc("pi/session/move", { path, cwd: project })).result as { path: string };
      const expected = join(sessionRoot, `--${project.replace(/^\//, "").replace(/\//g, "-")}--`, "s1.jsonl");
      expect(moved).toEqual({ path: expected });
      expect(existsSync(path)).toBe(false);
      expect(existsSync(expected)).toBe(true);

      const lines = readFileSync(expected, "utf8").split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", id: "s1", cwd: project });
      expect(JSON.parse(lines[1]!)).toEqual({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } });
      expect(lines).toHaveLength(6);

      // The same session, with its name and history, listed under the project
      // and attributed to the default agent with no workspace kind.
      const after = await h.rows();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ path: expected, id: "s1", cwd: project, name: "Recipe ideas", firstMessage: "Ideas for dinner", messageCount: 2, agent: { agentName: "default", kind: "root" } });
      // Read where it was read: not lit up as unread for having moved.
      expect(after[0]?.attention).toBe("idle");
      expect(after[0]?.seenAt).toBeDefined();
      expect(h.attention.seenAt(path)).toBeUndefined();
      // The project is a project now, pinned like one added from the rail.
      expect(h.projects.list().map((p) => [p.cwd, p.pinned, p.sessionCount])).toEqual([[project, true, 1]]);
      // No worker was involved: the session was not open anywhere.
      expect(h.workerRequests).toEqual([]);
      expect(h.forgotten).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("closes an open session in its worker first, then moves it", async () => {
    const path = chatSession("s2.jsonl");
    const h = harness({ open: [path] });
    try {
      const moved = (await h.rpc("pi/session/move", { path, cwd: project })).result as { path: string };
      expect(h.workerRequests).toEqual([{ cwd: chat, method: "pi/session/close", params: { path } }]);
      expect(h.forgotten).toEqual([path]);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(moved.path)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a streaming session with the worker's own reason and touches nothing", async () => {
    const path = chatSession("s3.jsonl");
    const h = harness({ open: [path], closeRefuses: "This chat is still answering. Wait for it to finish, or stop it, then move it." });
    try {
      const answer = await h.rpc("pi/session/move", { path, cwd: project });
      expect(answer.error).toEqual({ code: -32001, message: "This chat is still answering. Wait for it to finish, or stop it, then move it." });
      expect(h.forgotten).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).cwd).toBe(chat);
      expect((await h.rows()).map((row) => row.path)).toEqual([path]);
      expect(h.projects.list()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a child session, a session with a live run, a missing folder, a file, a workspace and a worktree", async () => {
    const parent = chatSession("parent.jsonl");
    const child = chatSession("child.jsonl", { record: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: parent, rootPath: parent }, parentSession: parent });
    const plain = chatSession("plain.jsonl");
    const h = harness();
    try {
      const refused = async (params: unknown) => (await h.rpc("pi/session/move", params)).error;

      expect(await refused({ path: child, cwd: project })).toMatchObject({ code: -32602, message: expect.stringMatching(/started this session under another one/) });

      const run: AgentRun = {
        agentName: "default", subagentName: "explorer", sessionId: "child", runId: "r1", sessionPath: child, projectCwd: chat, rootSessionPath: parent, depth: 1,
        parent: { sessionPath: parent, sessionId: "parent" }, worktree: null, origin: "agent", status: "running", task: "Count", startedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      };
      h.runs.upsert(run);
      expect(await refused({ path: parent, cwd: project })).toMatchObject({ code: -32001, message: expect.stringMatching(/still working/) });
      h.runs.upsert({ ...run, status: "completed" });
      // A finished run is history, not a reason to refuse.
      expect((await h.rpc("pi/session/move", { path: parent, cwd: project })).error).toBeUndefined();

      expect(await refused({ path: plain, cwd: join(base, "nowhere") })).toMatchObject({ code: -32602, message: expect.stringMatching(/There is no folder at/) });
      const file = join(base, "notes.txt");
      writeFileSync(file, "x");
      expect(await refused({ path: plain, cwd: file })).toMatchObject({ code: -32602, message: expect.stringMatching(/is a file, not a folder/) });
      expect(await refused({ path: plain, cwd: chat })).toMatchObject({ code: -32602, message: expect.stringMatching(/Chat's workspace is not a project/) });
      const worktree = join(project, ".worktrees", "explorer");
      mkdirSync(worktree, { recursive: true });
      expect(await refused({ path: plain, cwd: worktree })).toMatchObject({ code: -32602, message: expect.stringMatching(/agent's worktree/) });
      expect(await refused({ path: join(sessionRoot, "--chat--", "gone.jsonl"), cwd: project })).toMatchObject({ code: -32000 });

      // Nothing refused was moved.
      expect(existsSync(plain)).toBe(true);
      expect(existsSync(child)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("does not let a client close a session directly", async () => {
    const path = chatSession("s4.jsonl");
    const h = harness({ open: [path] });
    try {
      expect((await h.rpc("pi/session/close", { path })).error).toMatchObject({ code: -32004 });
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
