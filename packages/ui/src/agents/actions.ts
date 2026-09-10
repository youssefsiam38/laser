/**
 * The agents actions the provider exposes as `actions.agents`. Pure of React:
 * a request client, the reducer's dispatch and the shared toast guard in, a
 * stable object of methods out. Tested in test/agents/actions.test.ts.
 *
 * Two failure styles, on purpose:
 * - Methods that *answer* something a surface is waiting on (`validate`,
 *   `save`, `skills`, `engineInstructions`, `stopRun`, `qualifyNamer`) reject.
 *   The form, dialog or sheet that asked shows the message where the person
 *   is looking; a toast over a form is the wrong place.
 * - Methods that only *settle* (`remove`, `setDefault`, `setPolicy`,
 *   `setBuiltinModel`) toast on failure and resolve; the
 *   snapshot only moves on success, so a toggle that failed snaps back.
 * - `refresh` and `runs` record failure in `state.agents.error`, where the
 *   Agents page draws its error state with a retry.
 */
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentIssue,
  AgentModelChoice,
  AgentPolicy,
  AgentRun,
  AgentSkillsListing,
  AgentWorktreeStatus,
  BuiltinAgentName,
  NamerState,
} from "@lasercode/protocol";
import type { HostClient } from "../client.js";
import type { Action } from "../store.js";

export interface AgentsActions {
  /** `agents/list` into `state.agents.snapshot`; failure lands in `state.agents.error`. */
  refresh(): Promise<void>;
  /** `agents/validate`. Rejects when the host cannot be asked. */
  validate(agent: AgentDefinitionInput, originalName: string | null): Promise<AgentIssue[]>;
  /** `agents/save`; the snapshot in the result updates the store. Rejects on failure. */
  save(agent: AgentDefinitionInput, originalName: string | null): Promise<AgentDefinition>;
  /** `agents/delete`. Toasts on failure. */
  remove(name: string): Promise<void>;
  /** `agents/set-default`. Toasts on failure. */
  setDefault(name: string): Promise<void>;
  /** `agents/set-policy`. Toasts on failure. */
  setPolicy(patch: Partial<AgentPolicy>): Promise<void>;
  /** `agents/skills` for `cwd`. Rejects on failure. */
  skills(cwd: string): Promise<AgentSkillsListing>;
  /** `agents/engine-instructions` for `cwd`. Rejects on failure. */
  engineInstructions(cwd: string): Promise<string>;
  /** `agents/runs/list` into `state.agents.runs`; `path` narrows to one tree. Failure lands in `state.agents.error`. */
  runs(path?: string): Promise<void>;
  /** `agents/runs/stop`; the returned run is also folded into the store. Rejects on failure. */
  stopRun(runId: string, reason?: string): Promise<AgentRun>;
  /**
   * `agents/worktree/status` for a child session: what its worktree holds, or
   * `null` when it never had one. Rejects on failure — the two surfaces that
   * ask (the delete confirmation and the fleet's removal) both need to say so
   * where the person is looking, not in a toast somewhere else.
   */
  worktreeStatus(path: string): Promise<AgentWorktreeStatus | null>;
  /**
   * `agents/worktree/remove`: the person clears a leftover worktree without
   * deleting the session. Resolves with `removed: false` and what it holds
   * when it still carries unmerged work and `force` was not given.
   */
  removeWorktree(path: string, force?: boolean): Promise<{ removed: boolean; worktree: AgentWorktreeStatus | null }>;
  /**
   * `agents/builtin/set-model` for Beam, Chat or Namer; `null` returns that
   * agent to the default model. Choosing Beam's also clears its pending
   * choice. Toasts on failure.
   */
  setBuiltinModel(name: BuiltinAgentName, model: AgentModelChoice | null): Promise<void>;
  /** Replace one built-in's system instructions; `null` restores the shipped prompt. Rejects so the editor can show the failure inline. */
  setBuiltinInstructions(name: BuiltinAgentName, instructions: string | null): Promise<void>;
  /** `agents/namer/qualify` in `cwd`. Rejects on failure. */
  qualifyNamer(cwd: string): Promise<NamerState>;
  /** Close the Beam model choice without picking; the host keeps `beam.needsChoice`. */
  dismissBeamChoice(): void;
}

export interface AgentsActionsDeps {
  client: Pick<HostClient, "request">;
  dispatch(action: Action): void;
  /** Toast-and-swallow, shared with every other action. */
  guard<T>(work: () => Promise<T>): Promise<T | undefined>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAgentsActions({ client, dispatch, guard }: AgentsActionsDeps): AgentsActions {
  const settle = (work: () => Promise<void>): Promise<void> => guard(work).then(() => undefined);
  return {
    refresh: async () => {
      dispatch({ type: "agents/loading" });
      try {
        const snapshot = await client.request("agents/list", {});
        dispatch({ type: "agents/loaded", snapshot });
      } catch (error) {
        dispatch({ type: "agents/error", error: messageOf(error) });
      }
    },
    validate: async (agent, originalName) => {
      const { issues } = await client.request("agents/validate", { agent, originalName });
      return issues;
    },
    save: async (agent, originalName) => {
      const { agent: saved, snapshot } = await client.request("agents/save", { agent, originalName });
      dispatch({ type: "agents/updated", snapshot });
      return saved;
    },
    remove: (name) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/delete", { name });
        dispatch({ type: "agents/updated", snapshot });
      }),
    setDefault: (name) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/set-default", { name });
        dispatch({ type: "agents/updated", snapshot });
      }),
    setPolicy: (policy) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/set-policy", { policy });
        dispatch({ type: "agents/updated", snapshot });
      }),
    skills: (cwd) => client.request("agents/skills", { cwd }),
    engineInstructions: async (cwd) => {
      const { text } = await client.request("agents/engine-instructions", { cwd });
      return text;
    },
    runs: async (path) => {
      try {
        const { runs } = await client.request("agents/runs/list", path !== undefined ? { path } : {});
        dispatch({ type: "agents/runs/loaded", runs, ...(path !== undefined ? { path } : {}) });
      } catch (error) {
        dispatch({ type: "agents/error", error: messageOf(error) });
      }
    },
    stopRun: async (runId, reason) => {
      const { run } = await client.request("agents/runs/stop", { runId, ...(reason !== undefined ? { reason } : {}) });
      dispatch({ type: "agents/run", run });
      return run;
    },
    worktreeStatus: async (path) => {
      const { worktree } = await client.request("agents/worktree/status", { path });
      return worktree;
    },
    removeWorktree: async (path, force) => client.request("agents/worktree/remove", { path, ...(force !== undefined ? { force } : {}) }),
    setBuiltinModel: (name, model) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/builtin/set-model", { name, model });
        dispatch({ type: "agents/updated", snapshot });
        if (name === "beam") dispatch({ type: "agents/choose-beam-model/clear" });
      }),
    setBuiltinInstructions: async (name, instructions) => {
      const { snapshot } = await client.request("agents/builtin/set-instructions", { name, instructions });
      dispatch({ type: "agents/updated", snapshot });
    },
    qualifyNamer: (cwd) => client.request("agents/namer/qualify", { cwd }),
    dismissBeamChoice: () => dispatch({ type: "agents/choose-beam-model/clear" }),
  };
}
