/**
 * M21-T17: the worker asking the host something (D-356.b).
 *
 * The fd-3 link used to carry requests one way. These are the rules of the
 * other direction: a worker's request id is its own and can never be
 * mistaken for the host's, an answer settles exactly the call that asked for
 * it, and a refusal comes back as the protocol error the bridge turns into a
 * tool's `{ code, message, committed, next }`.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, PROJECT_WORK_BRIDGE_METHOD, ProtocolError, type JsonRpcMessage } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import type { SessionDriver } from "../../src/driver.js";
import { HostProjectWorkBridge, ProjectWorkToolFailure } from "../../src/project-work/bridge.js";

function server(): { server: WorkerServer; sent: JsonRpcMessage[] } {
  const sent: JsonRpcMessage[] = [];
  const instance = new WorkerServer({
    cwd: "/tmp/project-work-link",
    createDriver: () => ({}) as unknown as SessionDriver,
    send: (message) => sent.push(message),
  });
  return { server: instance, sent };
}

describe("the worker's own requests to the host", () => {
  it("sends a request with a string id of its own and settles on the answer", async () => {
    const { server: worker, sent } = server();
    const pending = worker.hostRequest<{ ok: boolean }>(PROJECT_WORK_BRIDGE_METHOD, { agent: { label: "Builder" } });
    const request = sent.at(-1) as { id: string; method: string; params: unknown };
    expect(request.method).toBe(PROJECT_WORK_BRIDGE_METHOD);
    expect(request.id, "a worker id is a string; the host's are numbers").toBe("w1");
    expect(worker.hostResponse({ jsonrpc: "2.0", id: request.id, result: { ok: true } })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("settles each call with its own answer, whatever order they come back in", async () => {
    const { server: worker, sent } = server();
    const first = worker.hostRequest<string>("project/work/bridge", {});
    const second = worker.hostRequest<string>("project/work/bridge", {});
    const [one, two] = sent.slice(-2).map((message) => (message as { id: string }).id);
    worker.hostResponse({ jsonrpc: "2.0", id: two, result: "second" });
    worker.hostResponse({ jsonrpc: "2.0", id: one, result: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("rejects with the host's own error, code and message intact", async () => {
    const { server: worker, sent } = server();
    const pending = worker.hostRequest("project/work/bridge", {});
    const id = (sent.at(-1) as { id: string }).id;
    worker.hostResponse({ jsonrpc: "2.0", id, error: { code: ErrorCodes.ProjectUntrusted, message: "This project's folder is not trusted." } });
    await expect(pending).rejects.toBeInstanceOf(ProtocolError);
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.ProjectUntrusted });
  });

  it("ignores an answer that is not to one of its own requests", () => {
    const { server: worker } = server();
    expect(worker.hostResponse({ jsonrpc: "2.0", id: 7, result: {} }), "a numeric id is the host's own").toBe(false);
    expect(worker.hostResponse({ jsonrpc: "2.0", id: "w99", result: {} }), "an id nobody is waiting on").toBe(false);
  });
});

describe("the bridge over that link", () => {
  it("sends the agent's provenance and the forwarded request, and learns the project from the answer", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = new HostProjectWorkBridge({
      link: (method, params) => {
        calls.push({ method, params });
        return Promise.resolve({ method: "project/work/list", result: { projectId: "prj_1", items: [] }, projectId: "prj_1" });
      },
      identity: () => ({ label: "Builder", sessionId: "ses_1", runId: "run_1" }),
      execution: async () => ({ workspace: "shared", checkout: "/tmp/project" }),
    });
    expect(bridge.projectId()).toBeUndefined();
    await bridge.call("project/work/list", { cwd: "/tmp/project", limit: 1 });
    expect(calls[0]?.method).toBe(PROJECT_WORK_BRIDGE_METHOD);
    expect(calls[0]?.params).toMatchObject({
      agent: { label: "Builder", sessionId: "ses_1", runId: "run_1" },
      request: { method: "project/work/list", params: { cwd: "/tmp/project", limit: 1 } },
    });
    expect(bridge.projectId(), "the host says which project this session is in").toBe("prj_1");
  });

  it("carries a research operation and an attempt beside the request, never inside it", async () => {
    const calls: unknown[] = [];
    const bridge = new HostProjectWorkBridge({
      link: (_method, params) => {
        calls.push(params);
        return Promise.resolve({ method: "project/task/link-execution", result: {}, researchResult: { staleRefs: [] } });
      },
      identity: () => ({ label: "Builder" }),
      execution: async () => ({ workspace: "worktree", checkout: "/tmp/w" }),
    });
    await bridge.call(
      "project/task/link-execution",
      { projectId: "prj_1", entityId: "ent_1", expectedRevisionId: "rev_1", execution: { kind: "session", targetId: "ses_1" }, idempotencyKey: "k" },
      { attempt: { workspace: "worktree", checkout: "/tmp/w" } },
    );
    expect(calls[0]).toMatchObject({ attempt: { workspace: "worktree", checkout: "/tmp/w" } });
    expect(bridge.lastResearchResult()).toEqual({ staleRefs: [] });
  });

  it("turns a wrong-project refusal into the offer to open a session there", async () => {
    const bridge = new HostProjectWorkBridge({
      link: () =>
        Promise.reject(
          new ProtocolError(ErrorCodes.InvalidParams, "That work belongs to beta, and this session is working in a different project.", {
            refused: "wrong_project",
            owningProjectId: "prj_beta",
            owningProjectName: "beta",
            offer: "open_session",
          }),
        ),
      identity: () => ({ label: "Builder" }),
      execution: async () => ({ workspace: "shared", checkout: "/tmp/project" }),
    });
    await expect(bridge.call("project/work/create", {} as never)).rejects.toBeInstanceOf(ProjectWorkToolFailure);
    try {
      await bridge.call("project/work/create", {} as never);
    } catch (error) {
      const failure = (error as ProjectWorkToolFailure).toolError;
      expect(failure.code).toBe("wrong_project");
      expect(failure.committed).toBe(false);
      expect(failure.next).toContain("beta");
    }
  });

  it("says the work could not be reached when the link itself fails", async () => {
    const bridge = new HostProjectWorkBridge({
      link: () => Promise.reject(new Error("worker exited")),
      identity: () => ({ label: "Builder" }),
      execution: async () => ({ workspace: "shared", checkout: "/tmp/project" }),
    });
    try {
      await bridge.call("project/work/list", { cwd: "/tmp/project" });
      throw new Error("that call should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectWorkToolFailure);
      expect((error as ProjectWorkToolFailure).toolError.code).toBe("project_work_unavailable");
    }
  });
});
