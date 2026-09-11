/**
 * A child agent's news never leaves the window (D-225): its question and its
 * ending reach its parent inside the parent's conversation, so the host tags
 * every attention event with the session's agent and sends no phone push for
 * a child's question. Only a top-level session interrupts a person.
 */
import { PRODUCT_NAME, type AgentRun, type HostNotifications } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostServer } from "../src/server.js";

let base: string;
let host: HostServer;

const ROOT = "/sessions/root.jsonl";
const CHILD = "/sessions/child.jsonl";
const PROJECT = "/workspace/project";

function childRun(): AgentRun {
  return {
    agentName: "reviewer",
    subagentName: "review-1",
    sessionId: "session-child",
    runId: "run_child",
    sessionPath: CHILD,
    projectCwd: PROJECT,
    rootSessionPath: ROOT,
    depth: 1,
    parent: { sessionPath: ROOT, sessionId: "root" },
    worktree: null,
    origin: "agent",
    status: "running",
    task: "Review it",
    startedAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-child-notify-`));
  mkdirSync(join(base, "agent"), { recursive: true });
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    log: () => {},
  });
});

afterEach(async () => {
  await host.close();
  rmSync(base, { recursive: true, force: true });
});

describe("a child agent's news stays inside the window", () => {
  it("sends no phone push for a child's question, and still does for a top-level session's", () => {
    const sendToAll = vi.spyOn(host.push, "sendToAll").mockResolvedValue([]);
    host.runs.upsert(childRun());
    const observe = (host as unknown as { observe(cwd: string, n: unknown): void }).observe.bind(host);
    const question = (path: string, id: string): HostNotifications["pi/ui/request"] =>
      ({ path, id, method: "confirm", title: "Go ahead?", message: "Yes or no.", timeoutMs: 60_000 } as HostNotifications["pi/ui/request"]);

    observe(PROJECT, { jsonrpc: "2.0", method: "pi/ui/request", params: question(CHILD, "q-child") });
    expect(sendToAll).not.toHaveBeenCalled();

    observe(PROJECT, { jsonrpc: "2.0", method: "pi/ui/request", params: question(ROOT, "q-root") });
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0]![1]).toMatchObject({ topic: "decision:q-root" });
  });

  it("tags a child's attention events with its agent so the desktop can stay quiet", () => {
    const notify = vi.spyOn(host, "notify");
    host.runs.upsert(childRun());
    const observe = (host as unknown as { observe(cwd: string, n: unknown): void }).observe.bind(host);
    observe(PROJECT, { jsonrpc: "2.0", method: "pi/ui/request", params: { path: CHILD, id: "q1", method: "confirm", title: "Go ahead?", message: "?", timeoutMs: 60_000 } });
    const attention = notify.mock.calls.filter(([method]) => method === "pi/session/attention").map(([, params]) => params as HostNotifications["pi/session/attention"]);
    expect(attention.at(-1)).toMatchObject({ path: CHILD, attention: "waiting_for_input", agent: { kind: "child", parentPath: ROOT, runId: "run_child" } });

    notify.mockClear();
    observe(PROJECT, { jsonrpc: "2.0", method: "pi/ui/request", params: { path: ROOT, id: "q2", method: "confirm", title: "Go ahead?", message: "?", timeoutMs: 60_000 } });
    const root = notify.mock.calls.filter(([method]) => method === "pi/session/attention").map(([, params]) => params as HostNotifications["pi/session/attention"]);
    // A session the host has no record for carries no agent: the desktop
    // treats it as top-level, which is what it is.
    expect(root.at(-1)).toMatchObject({ path: ROOT, attention: "waiting_for_input" });
    expect(root.at(-1)).not.toHaveProperty("agent");
  });
});
