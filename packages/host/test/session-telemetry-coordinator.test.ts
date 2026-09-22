import { describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type AgentRun,
  type SessionTelemetry,
  type TelemetryChildSpendSnapshot,
} from "@lasercode/protocol";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { SessionTelemetryCoordinator } from "../src/session-telemetry-coordinator.js";
import type { SessionTelemetryReader } from "../src/session-telemetry.js";
import type { WorkerClient } from "../src/worker-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const snapshot = (path: string, generation: number, childPath?: string): TelemetryChildSpendSnapshot => ({
  scopeSessionPath: path,
  generation,
  sources: childPath ? [{ sessionPath: childPath }] : [],
  coverage: childPath
    ? { knownChildren: 1, includedChildren: 0, unavailableChildren: 1 }
    : { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 },
});

const telemetry = (cost: number): SessionTelemetry => ({
  revision: "r1.test",
  environmentKey: "e1.test",
  authority: "live",
  scope: "session",
  spend: {
    billing: "api",
    coverage: { knownChildren: 0, includedChildren: 0, unavailableChildren: 0 },
    api: {
      totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost, turns: 1 },
      byModel: [],
      series: [cost],
    },
  },
});

function run(parent: string, child: string): AgentRun {
  return {
    agentName: "reviewer",
    subagentName: "child",
    sessionId: "child",
    runId: "run",
    sessionPath: child,
    projectCwd: "/project",
    rootSessionPath: parent,
    depth: 1,
    parent: { sessionPath: parent, sessionId: "parent" },
    worktree: null,
    origin: "agent",
    status: "completed",
    task: "child",
    startedAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
}

describe("SessionTelemetryCoordinator", () => {
  it("keeps overlapping same-scope responses request-scoped and the shared generation monotonic", async () => {
    const parent = "/parent.jsonl";
    const gates = new Map<number, ReturnType<typeof deferred<TelemetryChildSpendSnapshot>>>();
    const reader = {
      environmentKey: "e1.test",
      childSnapshot: (path: string, generation: number) => {
        const gate = deferred<TelemetryChildSpendSnapshot>();
        gates.set(generation, gate);
        return gate.promise;
      },
    } as unknown as SessionTelemetryReader;
    let currentGeneration = 0;
    const requests: number[] = [];
    const worker = {
      generation: "worker-1",
      request: async (method: string, params: unknown) => {
        if (method !== "pi/session/telemetry/with-sources") return {};
        const source = (params as { snapshot: TelemetryChildSpendSnapshot }).snapshot;
        requests.push(source.generation);
        const applied = source.generation >= currentGeneration;
        if (applied) currentGeneration = source.generation;
        return {
          telemetry: telemetry(source.generation),
          generation: currentGeneration,
          applied,
          published: false,
        };
      },
    } as unknown as WorkerClient;
    const runs = new AgentRunRegistry();
    const coordinator = new SessionTelemetryCoordinator({ reader, runs, owner: () => worker });
    try {
      const first = coordinator.read(worker, { path: parent, include: ["spend"] });
      const second = coordinator.read(worker, { path: parent, include: ["spend"] });
      gates.get(2)!.resolve(snapshot(parent, 2));
      expect((await second).spend?.api?.totals.cost).toBe(2);
      gates.get(1)!.resolve(snapshot(parent, 1));
      expect((await first).spend?.api?.totals.cost).toBe(1);
      expect(requests).toEqual([2, 1]);
      expect(currentGeneration).toBe(2);
    } finally {
      coordinator.close();
      runs.close();
    }
  });

  it("does not let a delayed accepted generation regress canonical membership", async () => {
    const parent = "/parent.jsonl";
    const replies = new Map<number, ReturnType<typeof deferred<unknown>>>();
    let invalidations = 0;
    const reader = {
      environmentKey: "e1.test",
      childSnapshot: async (path: string, generation: number) => snapshot(path, generation, generation === 1 ? "/old.jsonl" : "/new.jsonl"),
    } as unknown as SessionTelemetryReader;
    const worker = {
      generation: "worker-1",
      request: (method: string, params: unknown) => {
        if (method === "pi/session/telemetry/invalidate") {
          invalidations += 1;
          return Promise.resolve({ generation: (params as { generation: number }).generation });
        }
        const source = (params as { snapshot: TelemetryChildSpendSnapshot }).snapshot;
        const gate = deferred<unknown>();
        replies.set(source.generation, gate);
        return gate.promise;
      },
    } as unknown as WorkerClient;
    const runs = new AgentRunRegistry();
    const coordinator = new SessionTelemetryCoordinator({ reader, runs, owner: () => worker, coalesceMs: 1 });
    try {
      const first = coordinator.read(worker, { path: parent, include: ["spend"] });
      const second = coordinator.read(worker, { path: parent, include: ["spend"] });
      await vi.waitFor(() => expect(replies.size).toBe(2));
      replies.get(2)!.resolve({ telemetry: telemetry(2), generation: 2, applied: true, published: false });
      await second;
      replies.get(1)!.resolve({ telemetry: telemetry(1), generation: 1, applied: true, published: false });
      await first;

      coordinator.childChanged("/old.jsonl");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(invalidations).toBe(0);
    } finally {
      coordinator.close();
      runs.close();
    }
  });

  it("abandons a delayed public build after scope forget, rekey, or owner replacement", async () => {
    for (const lifecycle of ["forget", "rekey", "replace-owner"] as const) {
      const parent = "/parent.jsonl";
      const build = deferred<TelemetryChildSpendSnapshot>();
      let requests = 0;
      const reader = {
        environmentKey: "e1.test",
        childSnapshot: () => build.promise,
      } as unknown as SessionTelemetryReader;
      const oldWorker = {
        generation: "worker-1",
        request: async () => {
          requests += 1;
          return { telemetry: telemetry(1), generation: 1, applied: true, published: false };
        },
      } as unknown as WorkerClient;
      const newWorker = { ...oldWorker, generation: "worker-2" } as unknown as WorkerClient;
      let owner: WorkerClient | undefined = oldWorker;
      const runs = new AgentRunRegistry();
      const coordinator = new SessionTelemetryCoordinator({ reader, runs, owner: () => owner });
      try {
        const pending = coordinator.read(oldWorker, { path: parent, include: ["spend"] });
        if (lifecycle === "forget") coordinator.forgetScope(parent);
        if (lifecycle === "rekey") coordinator.rekey(parent, "/moved.jsonl");
        if (lifecycle === "replace-owner") owner = newWorker;
        build.resolve(snapshot(parent, 1));
        await expect(pending).rejects.toMatchObject({ code: ErrorCodes.RevisionUnavailable });
        expect(requests).toBe(0);
      } finally {
        coordinator.close();
        runs.close();
      }
    }
  });

  it("lets a settled request answer but not mutate interest recreated while it was in flight", async () => {
    const parent = "/parent.jsonl";
    const firstReply = deferred<unknown>();
    let builds = 0;
    let requests = 0;
    let invalidations = 0;
    const reader = {
      environmentKey: "e1.test",
      childSnapshot: async (path: string, generation: number) => snapshot(path, generation, ++builds === 1 ? "/old.jsonl" : "/new.jsonl"),
    } as unknown as SessionTelemetryReader;
    const worker = {
      generation: "worker-1",
      request: (method: string, params: unknown) => {
        if (method === "pi/session/telemetry/invalidate") {
          invalidations += 1;
          return Promise.resolve({ generation: (params as { generation: number }).generation });
        }
        requests += 1;
        const source = (params as { snapshot: TelemetryChildSpendSnapshot }).snapshot;
        if (requests === 1) return firstReply.promise;
        return Promise.resolve({ telemetry: telemetry(2), generation: source.generation, applied: true, published: false });
      },
    } as unknown as WorkerClient;
    const runs = new AgentRunRegistry();
    const coordinator = new SessionTelemetryCoordinator({ reader, runs, owner: () => worker, coalesceMs: 1 });
    try {
      const first = coordinator.read(worker, { path: parent, include: ["spend"] });
      await vi.waitFor(() => expect(requests).toBe(1));
      coordinator.forgetScope(parent);
      await coordinator.read(worker, { path: parent, include: ["spend"] });
      firstReply.resolve({ telemetry: telemetry(1), generation: 1, applied: true, published: false });
      expect((await first).spend?.api?.totals.cost).toBe(1);

      coordinator.childChanged("/old.jsonl");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(invalidations).toBe(0);
    } finally {
      coordinator.close();
      runs.close();
    }
  });

  it("refreshes the interested ancestor on its own worker, not the child or unrelated worker", async () => {
    const parent = "/parent.jsonl";
    const child = "/child.jsonl";
    const unrelated = "/unrelated.jsonl";
    const runs = new AgentRunRegistry();
    runs.upsert(run(parent, child));
    const makeWorker = (generation: string) => ({
      generation,
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === "pi/session/telemetry/invalidate") return { generation: (params as { generation: number }).generation };
        const source = (params as { snapshot: TelemetryChildSpendSnapshot }).snapshot;
        return { telemetry: telemetry(source.generation), generation: source.generation, applied: true, published: true };
      }),
    });
    const parentWorker = makeWorker("parent-worker");
    const childWorker = makeWorker("child-worker");
    const unrelatedWorker = makeWorker("unrelated-worker");
    const owners = new Map([
      [parent, parentWorker], [child, childWorker], [unrelated, unrelatedWorker],
    ]);
    const reader = {
      environmentKey: "e1.test",
      childSnapshot: async (path: string, generation: number) => snapshot(path, generation),
    } as unknown as SessionTelemetryReader;
    const coordinator = new SessionTelemetryCoordinator({
      reader, runs, owner: (path) => owners.get(path) as unknown as WorkerClient | undefined, coalesceMs: 1,
    });
    try {
      for (const [path, worker] of owners) {
        await coordinator.read(worker as unknown as WorkerClient, { path, include: ["spend"] });
        worker.request.mockClear();
      }
      coordinator.childChanged(child);
      await vi.waitFor(() => expect(parentWorker.request).toHaveBeenCalledTimes(2));
      expect(parentWorker.request.mock.calls[0]?.[0]).toBe("pi/session/telemetry/invalidate");
      expect(parentWorker.request.mock.calls[1]).toEqual([
        "pi/session/telemetry/with-sources",
        expect.objectContaining({ path: parent, subscribe: false, publishIfWanted: true }),
      ]);
      expect(childWorker.request).not.toHaveBeenCalled();
      expect(unrelatedWorker.request).not.toHaveBeenCalled();
      expect(coordinator.isDirty(parent)).toBe(false);
      coordinator.childChanged("/cold.jsonl");
      expect(coordinator.retainedScopes()).toBe(3);
    } finally {
      coordinator.close();
      runs.close();
    }
  });

  it("allocates only for interested scopes and tears them down on rekey and worker loss", async () => {
    const parent = "/parent.jsonl";
    const child = "/child.jsonl";
    const runs = new AgentRunRegistry();
    runs.upsert(run(parent, child));
    const reader = {
      environmentKey: "e1.test",
      childSnapshot: async (path: string, generation: number) => snapshot(path, generation),
    } as unknown as SessionTelemetryReader;
    let refreshes = 0;
    let invalidations = 0;
    const worker = {
      generation: "worker-1",
      request: async (method: string, params: unknown) => {
        if (method === "pi/session/telemetry/invalidate") {
          invalidations += 1;
          return { generation: (params as { generation: number }).generation };
        }
        refreshes += 1;
        const source = (params as { snapshot: TelemetryChildSpendSnapshot }).snapshot;
        return { telemetry: telemetry(0), generation: source.generation, applied: true, published: false };
      },
    } as unknown as WorkerClient;
    const coordinator = new SessionTelemetryCoordinator({ reader, runs, owner: () => worker, coalesceMs: 1 });
    try {
      coordinator.childChanged(child);
      expect(coordinator.retainedScopes()).toBe(0);
      await coordinator.read(worker, { path: parent, include: ["spend"] });
      expect(coordinator.retainedScopes()).toBe(1);
      coordinator.childChanged(child);
      const stale = coordinator.withoutStaleTelemetry({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionPath: parent, seq: 1, update: { kind: "state", state: {} }, at: "now", telemetry: telemetry(1) },
      } as never);
      expect((stale.params as { telemetry?: SessionTelemetry }).telemetry).toBeUndefined();
      const fresh = coordinator.withoutStaleTelemetry({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionPath: parent,
          seq: 2,
          update: { kind: "state", state: {} },
          at: "now",
          telemetry: telemetry(2),
          telemetryGeneration: 99,
        },
      } as never);
      expect((fresh.params as { telemetry?: SessionTelemetry }).telemetry?.spend?.api?.totals.cost).toBe(2);
      expect(fresh.params).not.toHaveProperty("telemetryGeneration");
      coordinator.childChanged(child);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(invalidations).toBe(2);
      expect(refreshes).toBe(2); // one direct read, one coalesced replacement
      expect(coordinator.isDirty(parent)).toBe(false);
      coordinator.childChanged(child);
      coordinator.rekey(parent, "/moved.jsonl");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(refreshes).toBe(3);
      expect(coordinator.isDirty("/moved.jsonl")).toBe(false);
      expect(coordinator.retainedScopes()).toBe(1);
      coordinator.forgetWorker("worker-1");
      expect(coordinator.retainedScopes()).toBe(0);
    } finally {
      coordinator.close();
      runs.close();
    }
  });
});
