import {
  ErrorCodes,
  ProtocolError,
  isTerminalRunStatus,
  methodPolicy,
  type ActivationBlockers,
  type ClientMethod,
  type RuntimeActivationState,
  type WorkerActivationState,
} from "@lasercode/protocol";
import type { AgentRunRegistry } from "./agents/runs.js";
import { readRuntimeGenerationPointer, verifyRuntimeGeneration } from "./runtime-generation.js";
import type { TaskRegister } from "./tasks/register.js";
import type { WorkerPool } from "./worker-pool.js";

const NEW_ROOTS = new Set<ClientMethod>([
  "session/new",
  "session/prompt",
  "session/goal/action",
  "session/pending/add",
  "session/pending/edit",
  "session/pending/steer",
  "pi/session/steer",
  "pi/session/follow_up",
  "pi/session/compact",
  "pi/transcribe/begin",
]);
const ACTIVATION_METHODS = new Set<ClientMethod>([
  "pi/runtime/activation/prepare",
  "pi/runtime/activation/status",
  "pi/runtime/activation/cancel",
  "pi/worker/activation/park",
  "pi/worker/activation/status",
  "pi/worker/activation/cancel",
]);

interface Gate {
  updateId: string;
  generationId: string;
  phase: "parking" | "parked";
}

const emptyBlockers = (): ActivationBlockers => ({
  conversations: 0,
  agents: 0,
  questions: 0,
  approvals: 0,
  commands: 0,
  mutations: 0,
  workers: 0,
});

/** Host-wide, non-destructive admission fence for one exact update. */
export class RuntimeActivationGate {
  private gate: Gate | undefined;
  private inFlightMutations = 0;

  constructor(
    private readonly stateDir: string,
    private readonly pool: WorkerPool,
    private readonly runs: AgentRunRegistry,
    private readonly tasks: TaskRegister,
  ) {}

  /** Called around every routed request, even before a gate exists. */
  enter(method: ClientMethod): () => void {
    if (this.gate && NEW_ROOTS.has(method)) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        "An update is waiting for current work to finish. Keep working by cancelling update preparation first.",
      );
    }
    const scope = methodPolicy(method)?.scope;
    const mutation = scope !== undefined
      && scope !== "read"
      && scope !== "handshake"
      && !ACTIVATION_METHODS.has(method);
    if (!mutation) return () => undefined;
    this.inFlightMutations += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.inFlightMutations = Math.max(0, this.inFlightMutations - 1);
    };
  }

  async prepare(updateId: string, generationId: string): Promise<RuntimeActivationState> {
    if (this.gate && (this.gate.updateId !== updateId || this.gate.generationId !== generationId)) {
      throw new ProtocolError(ErrorCodes.SessionBusy, "Another update is already waiting for current work to finish.");
    }
    this.verifyTarget(generationId);
    this.gate ??= { updateId, generationId, phase: "parking" };
    await Promise.all(this.pool.liveClients().map(async ({ client }) => {
      try { await client.request("pi/worker/activation/park", { updateId, generationId }); }
      catch { /* status reports this exact worker as a blocker below. */ }
    }));
    return this.status(updateId);
  }

  async status(updateId: string): Promise<RuntimeActivationState> {
    const gate = this.owned(updateId);
    const blockers = emptyBlockers();
    blockers.mutations = this.inFlightMutations;

    const workerStates = await Promise.all(this.pool.liveClients().map(async ({ client }) => {
      try {
        return await client.request("pi/worker/activation/status", { updateId }) as WorkerActivationState;
      } catch {
        // A worker admitted by an already in-flight host request may have come
        // up after the first broadcast. Fence it now; it cannot disappear from
        // the parked decision merely because its spawn raced preparation.
        try {
          return await client.request("pi/worker/activation/park", {
            updateId: gate.updateId,
            generationId: gate.generationId,
          }) as WorkerActivationState;
        } catch { return undefined; }
      }
    }));
    let workerAgents = 0;
    let workerCommands = 0;
    for (const state of workerStates) {
      if (!state || state.updateId !== gate.updateId || state.generationId !== gate.generationId || !state.complete) {
        blockers.workers += 1;
        continue;
      }
      blockers.conversations += state.blockers.conversations;
      blockers.questions += state.blockers.questions;
      blockers.approvals += state.blockers.approvals;
      workerAgents += state.blockers.agents;
      workerCommands += state.blockers.commands;
    }
    const durableAgents = this.runs.list().filter((run) => !isTerminalRunStatus(run.status)).length;
    const durableCommands = this.tasks.list().filter((task) => task.status === "running").length;
    blockers.agents = Math.max(workerAgents, durableAgents);
    blockers.commands = Math.max(workerCommands, durableCommands);
    const parked = Object.values(blockers).every((count) => count === 0);
    gate.phase = parked ? "parked" : "parking";
    return { ...gate, blockers };
  }

  async cancel(updateId: string): Promise<RuntimeActivationState> {
    const gate = this.owned(updateId);
    const before = await this.status(updateId);
    await Promise.all(this.pool.liveClients().map(async ({ client }) => {
      try { await client.request("pi/worker/activation/cancel", { updateId }); }
      catch { /* A lost worker holds no admission gate. */ }
    }));
    this.gate = undefined;
    return { ...before, phase: "cancelled", blockers: emptyBlockers(), generationId: gate.generationId };
  }

  private owned(updateId: string): Gate {
    if (!this.gate || this.gate.updateId !== updateId) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That update does not own the preparation gate.");
    }
    return this.gate;
  }

  private verifyTarget(generationId: string): void {
    const pointer = readRuntimeGenerationPointer(this.stateDir);
    const target = pointer && [pointer.active, pointer.previous, pointer.pending]
      .find((reference) => reference?.generationId === generationId);
    if (!target) throw new ProtocolError(ErrorCodes.InvalidParams, "That runtime generation is not staged for activation.");
    try { verifyRuntimeGeneration(target); }
    catch { throw new ProtocolError(ErrorCodes.InvalidParams, "The staged update could not be verified. Download it again before preparing a restart."); }
  }
}
