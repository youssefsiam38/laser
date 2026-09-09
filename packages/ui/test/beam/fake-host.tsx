/**
 * A host for the Beam tests: `HostClient` replaced by an in-memory JSON-RPC
 * peer over a mutable world (sessions, states, the agents snapshot, the model
 * catalog), so the real `LaserProvider`, its runtimes and the scope run
 * unchanged against handlers a test can inspect and drive.
 *
 * Each test file installs it with
 *
 *   vi.mock("../../src/client.js", async (original) => ({
 *     ...(await original<typeof import("../../src/client.js")>()),
 *     HostClient: (await import("./fake-host.js")).FakeHostClient,
 *   }));
 */
import type { AgentsSnapshot, HostNotificationMethod, HostNotifications, ModelCatalogEntry, ProviderAuthInfo, SessionState, SessionSummary } from "@lasercode/protocol";
import type { HostClientOptions } from "../../src/client.js";
import { sessionState, snapshot as agentsSnapshot, summary } from "../agents/fixtures.js";

export const BEAM_CWD = "/state/beam";
export const PROJECT_CWD = "/p";

export interface World {
  sessions: SessionSummary[];
  states: Record<string, SessionState>;
  snapshot: AgentsSnapshot;
  catalog: ModelCatalogEntry[];
  providers: ProviderAuthInfo[];
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; params: unknown }>;
  /** A handler a test wants to override or make fail. */
  overrides: Partial<Record<string, (params: never) => unknown>>;
}

let created = 0;

export function createWorld(over: Partial<World> = {}): World {
  return {
    sessions: [],
    states: {},
    snapshot: agentsSnapshot({ workspaces: { beam: BEAM_CWD, chat: "/state/chat" } }),
    catalog: [
      { provider: "openai", id: "gpt-fast", name: "GPT Fast", enabled: true, thinkingLevels: ["off"] },
      { provider: "openai", id: "gpt-big", name: "GPT Big", enabled: true, thinkingLevels: ["off", "high"] },
      { provider: "anthropic", id: "claude-quick", name: "Claude Quick", enabled: true, thinkingLevels: ["off"] },
    ],
    providers: [
      { id: "openai", name: "OpenAI", configured: true, oauth: false, subscription: false, modelCount: 2 },
      { id: "anthropic", name: "Anthropic", configured: false, oauth: true, subscription: true, modelCount: 1 },
    ],
    calls: [],
    overrides: {},
    ...over,
  };
}

/** Add a persisted session to the world: listed by the catalog and loadable. */
export function addSession(world: World, path: string, cwd: string, extra: Partial<SessionSummary> = {}): void {
  const agent = cwd === BEAM_CWD ? { agentName: "beam", kind: "beam" as const } : undefined;
  world.sessions.push(summary({ path, cwd, messageCount: 1, ...(agent ? { agent } : {}), ...extra }));
  world.states[path] = sessionState({ path, cwd, messageCount: 1, ...(agent ? { agent } : {}) });
}

export class FakeHostClient {
  static instances: FakeHostClient[] = [];
  static world: World = createWorld();
  static reset(world: World = createWorld()): void {
    FakeHostClient.instances = [];
    FakeHostClient.world = world;
    created = 0;
  }
  /** The most recent client the provider built. */
  static get current(): FakeHostClient {
    const instance = FakeHostClient.instances.at(-1);
    if (!instance) throw new Error("No HostClient has been constructed yet.");
    return instance;
  }

  constructor(readonly options: HostClientOptions) {
    FakeHostClient.instances.push(this);
  }

  connect(): void {
    queueMicrotask(() => this.options.onConnection?.("open"));
  }
  reconnect(): void {}
  close(): void {}
  track(): void {}
  untrack(): void {}
  resync(): void {}
  whenConnected(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): () => void {
    return () => {};
  }

  /** Deliver a host notification, exactly as the socket would. */
  notify<M extends HostNotificationMethod>(method: M, params: HostNotifications[M]): void {
    this.options.onNotification(method, params);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const world = FakeHostClient.world;
    world.calls.push({ method, params });
    const override = world.overrides[method];
    if (override) return override(params as never);
    return handle(world, method, params as Record<string, unknown>);
  }
}

function handle(world: World, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "pi/session/list":
      return { sessions: world.sessions };
    case "pi/project/list":
      return { projects: [] };
    case "agents/list":
      return world.snapshot;
    case "agents/runs/list":
      return { runs: [] };
    case "session/load": {
      const state = world.states[params.path as string];
      if (!state) throw new Error(`There is no session at ${String(params.path)}.`);
      // No buffered updates in this world, so the watermark is 0 and nothing
      // is replayed. A fake that models the replay buffer, for the re-open
      // contract itself, lives in test/runtime/fake-worker.ts.
      return { state, replayFrom: 0, seq: 0 };
    }
    case "pi/session/entries":
      return { entries: [] };
    case "session/goal/get":
      return { goal: null };
    // Every session open asks for its pending tray; a test that cares about
    // the rows overrides this (see thread/message-queue.test.tsx).
    case "session/pending/list":
      return { messages: [] };
    case "session/new": {
      const cwd = params.path as string | undefined ?? (params.cwd as string);
      const agentName = params.agentName as string | undefined;
      const path = `${cwd}/session-${++created}.jsonl`;
      const agent = agentName ? { agentName, kind: agentName === "beam" ? ("beam" as const) : ("root" as const) } : undefined;
      const state = sessionState({ path, cwd, ...(agent ? { agent } : {}) });
      world.states[path] = state;
      world.sessions.push(summary({ path, cwd, messageCount: 0, ...(agent ? { agent } : {}) }));
      return { state };
    }
    case "session/prompt":
      return { accepted: true };
    case "session/cancel":
    case "pi/session/detach":
    case "pi/session/seen":
    case "pi/session/rename":
    case "pi/session/delete":
      return {};
    case "pi/prefs/get":
      return { entries: [], revision: 0 };
    case "pi/prefs/set":
      return { revision: 1 };
    case "pi/commands/list":
      return { commands: [] };
    case "pi/models/catalog":
      return { models: world.catalog, enabledModels: null, defaultProvider: "openai", defaultModel: "gpt-fast" };
    case "pi/providers/list":
      return { providers: world.providers };
    case "agents/builtin/set-model": {
      const model = params.model as AgentsSnapshot["beam"]["model"];
      if (params.name !== "beam") throw new Error(`The Beam bubble only ever sets Beam's model, not ${String(params.name)}.`);
      world.snapshot = { ...world.snapshot, revision: world.snapshot.revision + 1, beam: { ...world.snapshot.beam, model, needsChoice: false } };
      return { snapshot: world.snapshot };
    }
    default:
      throw new Error(`The fake host has no handler for ${method}.`);
  }
}

/** Wait for React effects, microtasks and short timers to settle. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
