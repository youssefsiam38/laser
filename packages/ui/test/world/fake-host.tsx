/**
 * A host for the provider tests: `HostClient` replaced by an in-memory
 * JSON-RPC peer over a mutable world (sessions, states, the agents snapshot,
 * the model catalog), so the real `LaserProvider`, its runtimes and any scope
 * run unchanged against handlers a test can inspect and drive.
 *
 * Each test file installs it with
 *
 *   vi.mock("../../src/client.js", async (original) => ({
 *     ...(await original<typeof import("../../src/client.js")>()),
 *     HostClient: (await import("../world/fake-host.js")).FakeHostClient,
 *   }));
 */
import type { AgentsSnapshot, EnvironmentDescriptor, HostNotificationMethod, HostNotifications, ModelCatalogEntry, ModelProfile, ModelRef, ProfileAssignments, ProjectWorkCounts, ProjectWorkListItem, ProviderAuthInfo, SessionState, SessionSummary } from "@lasercode/protocol";
import type { HostClientOptions } from "../../src/client.js";
import { createTranscriptHoldLedger, type TranscriptHoldLedger } from "../../src/transcript-hold-ledger.js";
import { agentInfo, sessionState, snapshot as agentsSnapshot, summary } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

/** The Chat workspace this world's host reports (`docs/plain-chat.md`). */
export const CHAT_CWD = "/state/chat";
export const PROJECT_CWD = "/p";

export interface World {
  sessions: SessionSummary[];
  states: Record<string, SessionState>;
  snapshot: AgentsSnapshot;
  catalog: ModelCatalogEntry[];
  /** The model profiles the host holds, and what points at them (M22). */
  profiles: ModelProfile[];
  assignments: ProfileAssignments;
  providers: ProviderAuthInfo[];
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; params: unknown }>;
  /** A handler a test wants to override or make fail. */
  overrides: Partial<Record<string, (params: never) => unknown>>;
  /**
   * The project-work store (M21), by stable project id. `paths` is the
   * lookup `project/work/list { cwd }` performs; two paths of one project
   * therefore answer with one id, as the real host's does.
   */
  projectWork: Record<string, { seq: number; paths: string[]; items: ProjectWorkListItem[]; entities: Record<string, unknown> }>;
}

let created = 0;

export function createWorld(over: Partial<World> = {}): World {
  return {
    sessions: [],
    states: {},
    snapshot: agentsSnapshot({ workspaces: { chat: CHAT_CWD } }),
    profiles: [
      { id: "mp_fast00000000000000", name: "Fast", models: [{ provider: "openai", id: "gpt-fast" }], origin: "seeded", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "mp_smart0000000000000", name: "Smart", models: [{ provider: "openai", id: "gpt-big" }, { provider: "openai", id: "gpt-fast" }], origin: "seeded", updatedAt: "2026-09-01T00:00:00.000Z" },
    ],
    assignments: {
      defaultProfileId: "mp_fast00000000000000",
      namingProfileId: "mp_fast00000000000000",
      oracleProfileId: "mp_smart0000000000000",
      designIndexProfileId: null,
    },
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
    projectWork: {},
    ...over,
  };
}

/** The project a directory belongs to, the way the host resolves one. */
function projectIdOf(world: World, cwd: string | undefined): string {
  if (!cwd) throw new Error("name the project by id, or the folder it is open at");
  const found = Object.entries(world.projectWork).find(([, project]) => project.paths.some((path) => cwd === path || cwd.startsWith(`${path}/`)));
  if (found) return found[0];
  // A folder the store has never seen still resolves: the real host mints an
  // id and answers with an empty page.
  const projectId = `pw_${Object.keys(world.projectWork).length + 1}`;
  world.projectWork[projectId] = { seq: 0, paths: [cwd], items: [], entities: {} };
  return projectId;
}

function projectWorkCounts(items: readonly ProjectWorkListItem[]): ProjectWorkCounts {
  const byKind = { spec: 0, research: 0, design: 0, plan: 0, task: 0 };
  let total = 0;
  let needsAttention = 0;
  for (const item of items) {
    byKind[item.kind] += 1;
    total += 1;
    if (item.needsAttention) needsAttention += 1;
  }
  return { total, needsAttention, byKind };
}

/** Add a persisted session to the world: listed by the catalog and loadable. */
export function addSession(world: World, path: string, cwd: string, extra: Partial<SessionSummary> = {}): void {
  const agent = cwd === CHAT_CWD ? agentInfo({ kind: "chat" }) : undefined;
  world.sessions.push(summary({ path, cwd, messageCount: 1, ...(agent ? { agent } : {}), ...extra }));
  world.states[path] = sessionState({ path, cwd, messageCount: 1, ...(agent ? { agent } : {}) });
}

export class FakeHostClient {
  static instances: FakeHostClient[] = [];
  static world: World = createWorld();
  static reset(world: World = createWorld()): void {
    FakeHostClient.instances = [];
    FakeHostClient.world = world;
    FakeHostClient.environment = testDescriptor();
    created = 0;
  }
  /** The most recent client the provider built. */
  static get current(): FakeHostClient {
    const instance = FakeHostClient.instances.at(-1);
    if (!instance) throw new Error("No HostClient has been constructed yet.");
    return instance;
  }

  private readonly holds: TranscriptHoldLedger;

  constructor(readonly options: HostClientOptions) {
    this.holds = createTranscriptHoldLedger({
      hold: (path, owner) => this.options.onTranscriptHold?.(path, owner),
      release: (path, owner) => this.options.onTranscriptRelease?.(path, owner),
    });
    FakeHostClient.instances.push(this);
  }

  /**
   * The environment this fake host describes on connect, or `null` for a host
   * that cannot describe one (RP-13). A test that switches environments sets
   * this and calls {@link FakeHostClient.redescribe}.
   */
  static environment: EnvironmentDescriptor | null = testDescriptor();

  connect(): void {
    queueMicrotask(() => {
      // As in the app: the environment comes first, the connection second, and
      // a host that cannot describe one never opens.
      const environment = FakeHostClient.environment;
      if (!environment) {
        this.options.onEnvironmentFailure?.("This host cannot say what environment this is, so nothing is being kept on this device.");
        this.options.onConnection?.("closed");
        return;
      }
      const acceptance = this.options.onEnvironment?.(environment) ?? { ok: true };
      if (!acceptance.ok) {
        this.options.onEnvironmentFailure?.(acceptance.reason);
        this.options.onConnection?.("closed");
        return;
      }
      this.options.onConnection?.("open");
    });
  }

  /** A reconnect whose handshake cannot establish an environment at all. */
  failDescribe(reason = "This host cannot say what environment this is, so nothing is being kept on this device."): void {
    FakeHostClient.environment = null;
    this.options.onConnection?.("closed");
    this.options.onEnvironmentFailure?.(reason);
    this.options.onConnection?.("closed");
  }

  /**
   * A **reconnect** that lands in a different (or narrowed) environment.
   *
   * Modelled the way the real client does it, because there is no such thing
   * as a live re-description: the socket drops, the handshake runs again, the
   * app is told about the environment before anything opens, and only then is
   * the connection open (RP-13).
   */
  redescribe(environment: EnvironmentDescriptor): void {
    FakeHostClient.environment = environment;
    this.options.onConnection?.("closed");
    const acceptance = this.options.onEnvironment?.(environment) ?? { ok: true };
    if (!acceptance.ok) {
      this.options.onEnvironmentFailure?.(acceptance.reason);
      this.options.onConnection?.("closed");
      return;
    }
    this.options.onConnection?.("open");
  }
  reconnect(): void {
    this.clearHolds();
    this.options.onConnection?.("closed");
    queueMicrotask(async () => {
      this.options.onConnection?.("open");
      for (const path of [...this.attached]) {
        if (this.options.shouldResume && !this.options.shouldResume(path)) {
          this.attached.delete(path);
          continue;
        }
        const result = await this.request("session/load", { path, fromSeq: 0 }) as { replayFrom: number };
        this.options.onResume?.(path, result.replayFrom, 0);
      }
    });
  }
  close(): void {
    this.clearHolds();
    this.options.onConnection?.("closed");
  }
  /** Really forgotten, and observable: a test can assert nothing was kept. */
  readonly attached = new Set<string>();
  forgetAttachments(): void {
    this.attached.clear();
    this.clearHolds();
  }
  track(path: string): void {
    this.attached.add(path);
  }
  untrack(path: string): void {
    this.attached.delete(path);
  }
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
    const p = params as Record<string, unknown>;
    if (method === "session/load") this.holds.hold(p.path as string, p.owner as string | undefined);
    if (method === "pi/session/detach") this.holds.release(p.path as string, p.owner as string | undefined);
    const override = world.overrides[method];
    const result = override ? await override(params as never) : handle(world, method, p);
    if (method === "session/new" || method === "pi/session/fork") {
      const path = (result as { state?: { path?: string } }).state?.path;
      if (path) this.holds.hold(path, undefined);
    }
    return result;
  }

  private clearHolds(): void {
    this.holds.clear();
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
    case "pi/session/telemetry":
      return { revision: "r1.test", environmentKey: "e1.test", authority: "live", scope: "session", spend: { billing: "none" } };
    case "session/goal/get":
      return { goal: null };
    // Every session open asks for its pending tray; a test that cares about
    // the rows overrides this (see thread/message-queue.test.tsx).
    case "session/pending/list":
      return { messages: [] };
    case "session/new": {
      const cwd = params.path as string | undefined ?? (params.cwd as string);
      const agentName = params.agentName as string | undefined;
      const sessionKind = params.sessionKind as string | undefined;
      const path = `${cwd}/session-${++created}.jsonl`;
      // As the worker does: a Chat session is recorded with its kind and no
      // definition at all; anything else names the agent it runs.
      const agent = sessionKind === "chat"
        ? agentInfo({ kind: "chat" })
        : agentName ? agentInfo({ kind: "root", agentName }) : undefined;
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
      return { models: world.catalog, enabledModels: null, profiles: world.profiles, assignments: world.assignments, errors: [] };
    case "models/profiles/list":
      return { profiles: world.profiles, assignments: world.assignments };
    case "models/profiles/save": {
      const profile = params.profile as ModelProfile;
      world.profiles = world.profiles.some((entry) => entry.id === profile.id)
        ? world.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
        : [...world.profiles, profile];
      return { profiles: world.profiles, assignments: world.assignments };
    }
    case "session/profile/set": {
      const path = params.path as string;
      const profile = world.profiles.find((entry) => entry.id === params.profileId);
      const first = profile?.models[0];
      world.states[path] = {
        ...world.states[path]!,
        ...(profile ? { profile: { id: profile.id, name: profile.name } } : { profile: null }),
        ...(first ? { model: { provider: first.provider, id: first.id } } : {}),
      };
      return { state: world.states[path] };
    }
    case "session/model/pin": {
      const path = params.path as string;
      world.states[path] = { ...world.states[path]!, profile: null, pinned: true, model: params.model as ModelRef };
      return { state: world.states[path] };
    }
    case "pi/providers/list":
      return { providers: world.providers };
    // The project lifecycle leap (M21): enough of the host's project-work
    // authority for the workspace to read a project, create in it and move a
    // task. A test that cares about the answers overrides the method.
    case "project/work/list": {
      const projectId = (params.projectId as string | undefined) ?? projectIdOf(world, params.cwd as string | undefined);
      const project = world.projectWork[projectId];
      if (!project) throw new Error("That project is not one this device can read.");
      const items = project.items.filter((item) => (params.includeArchived === true ? true : !item.archived));
      return { projectId, seq: project.seq, items, counts: projectWorkCounts(items) };
    }
    case "project/work/get": {
      const projectId = params.projectId as string;
      const entity = world.projectWork[projectId]?.entities[params.entityId as string];
      if (!entity) throw new Error("That item is not in this project.");
      return entity;
    }
    case "project/work/create":
    case "project/work/revise":
    case "project/work/archive":
    case "project/work/delete":
    case "project/task/action":
      throw new Error(`The fake host has no handler for ${method}.`);
    default:
      throw new Error(`The fake host has no handler for ${method}.`);
  }
}

/** Wait for React effects, microtasks and short timers to settle. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
