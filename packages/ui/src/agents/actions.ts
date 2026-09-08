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
 *   `setBeamModel`, `setNamerModel`) toast on failure and resolve; the
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
  NamerState,
} from "@lasercode/protocol";
import type { HostClient } from "../client.js";
import type { Action } from "../store.js";

export interface AgentsActions {
  /** `agents/list` into `state.agents.snapshot`; failure lands in `state.agents.error`. */
  refresh(): Promise<void>;
  /** `agents/validate`. Rejects when the host cannot be asked. */
  validate(agent: AgentDefinitionInput): Promise<AgentIssue[]>;
  /** `agents/save`; the snapshot in the result updates the store. Rejects on failure. */
  save(agent: AgentDefinitionInput): Promise<AgentDefinition>;
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
  /** `agents/beam/set-model`; success also clears the pending choice. Toasts on failure. */
  setBeamModel(model: AgentModelChoice | null): Promise<void>;
  /** `agents/namer/set-model`. Toasts on failure. */
  setNamerModel(model: AgentModelChoice | null): Promise<void>;
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
    validate: async (agent) => {
      const { issues } = await client.request("agents/validate", { agent });
      return issues;
    },
    save: async (agent) => {
      const { agent: saved, snapshot } = await client.request("agents/save", { agent });
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
    setBeamModel: (model) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/beam/set-model", { model });
        dispatch({ type: "agents/updated", snapshot });
        dispatch({ type: "agents/choose-beam-model/clear" });
      }),
    setNamerModel: (model) =>
      settle(async () => {
        const { snapshot } = await client.request("agents/namer/set-model", { model });
        dispatch({ type: "agents/updated", snapshot });
      }),
    qualifyNamer: (cwd) => client.request("agents/namer/qualify", { cwd }),
    dismissBeamChoice: () => dispatch({ type: "agents/choose-beam-model/clear" }),
  };
}
