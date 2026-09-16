import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerActivationState } from "@lasercode/protocol";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { RuntimeActivationGate } from "../src/runtime-activation.js";
import {
  runtimeReferenceFromManifest,
  writeRuntimeGenerationManifest,
  writeRuntimeGenerationPointer,
} from "../src/runtime-generation.js";
import { TaskRegister } from "../src/tasks/register.js";
import type { WorkerPool } from "../src/worker-pool.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const UPDATE = "a".repeat(64);

function harness() {
  const root = mkdtempSync(join(tmpdir(), "activation-gate-"));
  roots.push(root);
  const install = join(root, "install");
  const stateDir = join(root, "state");
  mkdirSync(join(install, "app"), { recursive: true });
  const cli = join(install, "app", "cli.js");
  const worker = join(install, "app", "worker.js");
  writeFileSync(cli, "cli");
  writeFileSync(worker, "worker");
  const { path, manifest } = writeRuntimeGenerationManifest({
    installRoot: install,
    files: [cli, worker],
    entries: { cli: "app/cli.js", worker: "app/worker.js" },
    productVersion: "1.0.0",
    buildIdentity: "activation-test",
  });
  const reference = runtimeReferenceFromManifest(path);
  writeRuntimeGenerationPointer(stateDir, { schemaVersion: 1, active: reference });

  let blockers: WorkerActivationState["blockers"] = {
    conversations: 0, agents: 0, questions: 0, approvals: 0, commands: 0,
  };
  let parkedId: string | undefined;
  const calls: string[] = [];
  const client = {
    request: async (method: string, params: { updateId: string; generationId?: string }) => {
      calls.push(method);
      if (method === "pi/worker/activation/park") parkedId = params.updateId;
      if (method === "pi/worker/activation/cancel") parkedId = undefined;
      if (parkedId !== params.updateId && method !== "pi/worker/activation/cancel") throw new Error("not parked");
      return {
        updateId: params.updateId,
        generationId: params.generationId ?? manifest.generationId,
        parked: Object.values(blockers).every((count) => count === 0),
        complete: true,
        blockers,
      } satisfies WorkerActivationState;
    },
  };
  const pool = { liveClients: () => [{ cwd: "/project", client }] } as unknown as WorkerPool;
  const gate = new RuntimeActivationGate(
    stateDir,
    pool,
    new AgentRunRegistry(),
    new TaskRegister({ notify: () => undefined }),
  );
  return {
    gate,
    generationId: manifest.generationId,
    calls,
    setBlockers: (next: Partial<WorkerActivationState["blockers"]>) => {
      blockers = { conversations: 0, agents: 0, questions: 0, approvals: 0, commands: 0, ...next };
    },
  };
}

describe("runtime activation park gate", () => {
  it("fences one update id, blocks new roots and admits settlement without cancelling work", async () => {
    const h = harness();
    h.setBlockers({ questions: 1 });
    await expect(h.gate.prepare(UPDATE, h.generationId)).resolves.toMatchObject({
      updateId: UPDATE,
      phase: "parking",
      blockers: { questions: 1 },
    });
    expect(() => h.gate.enter("session/prompt")).toThrow(/waiting for current work/i);

    const settle = h.gate.enter("pi/ui/response");
    await expect(h.gate.status(UPDATE)).resolves.toMatchObject({ blockers: { questions: 1, mutations: 1 } });
    settle();
    h.setBlockers({});
    await expect(h.gate.status(UPDATE)).resolves.toMatchObject({ phase: "parked", blockers: {
      conversations: 0, agents: 0, questions: 0, approvals: 0, commands: 0, mutations: 0, workers: 0,
    } });
    expect(h.calls).not.toContain("session/cancel");
  });

  it.each([
    ["conversations", { conversations: 1 }],
    ["agents", { agents: 1 }],
    ["questions", { questions: 1 }],
    ["approvals", { approvals: 1 }],
    ["commands", { commands: 1 }],
  ] as const)("reports %s as an independent blocker", async (_name, blocker) => {
    const h = harness();
    h.setBlockers(blocker);
    const state = await h.gate.prepare(UPDATE, h.generationId);
    expect(state.phase).toBe("parking");
    expect(state.blockers).toMatchObject(blocker);
  });

  it("keeps the fence across callers, refuses a different id and reopens only on matching cancel", async () => {
    const h = harness();
    await h.gate.prepare(UPDATE, h.generationId);
    await expect(h.gate.status("b".repeat(64))).rejects.toThrow(/does not own/);
    await expect(h.gate.prepare("b".repeat(64), h.generationId)).rejects.toThrow(/another update/i);
    await expect(h.gate.cancel(UPDATE)).resolves.toMatchObject({ phase: "cancelled", updateId: UPDATE });
    expect(() => h.gate.enter("session/prompt")).not.toThrow();
  });
});
