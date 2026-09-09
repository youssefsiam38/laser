/**
 * A `HostClient` replacement that models the *worker's* side of the transcript
 * contract, not just its request table: a per-session `seq`, a replay buffer,
 * and a `session/load` that resends every buffered update after `fromSeq` and
 * reports the floor it could honour together with its current watermark.
 *
 * The Beam fake (`test/beam/fake-host.ts`) answers `session/load` with a
 * constant `{ replayFrom: 0, seq: 0 }`, which is exactly the behaviour that
 * hides a re-open bug. This one replays for real, so a lying `fromSeq` shows up
 * as a doubled transcript here the same way it does in the app.
 *
 * Installed with
 *
 *   vi.mock("../../src/client.js", async (original) => ({
 *     ...(await original<typeof import("../../src/client.js")>()),
 *     HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
 *   }));
 */
import type { HostNotifications, SessionState, SessionSummary, SessionUpdate, SessionUpdateParams } from "@lasercode/protocol";
import type { HostClientOptions } from "../../src/client.js";
import { sessionState, snapshot as agentsSnapshot, summary } from "../agents/fixtures.js";

export const PROJECT_CWD = "/p";

/** One session as a worker holds it: its file, its buffered updates, its seq. */
interface LiveSession {
  state: SessionState;
  /**
   * The persisted transcript `pi/session/entries` reads. It is Pi's tree: every
   * entry carries its parent, and every branch stays in the file.
   */
  entries: TreeEntry[];
  /**
   * The entry the session sits on, as `SessionManager` holds it. `null` is a
   * leaf reset to before the first entry.
   */
  leafId: string | null;
  /** Set to make the next navigate answer `cancelled` — an extension vetoing it. */
  navigateCancelled?: boolean;
  /**
   * A turn is streaming (`startTurn`): the engine refuses to move the leaf
   * until it is stopped, and `stopFirst` is what stops it (M13-T46).
   */
  streaming?: { prompt: string; partial: string };
  seq: number;
  buffer: SessionUpdateParams[];
}

export interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content: Array<{ type: string; text: string }> };
}

export interface World {
  sessions: SessionSummary[];
  live: Record<string, LiveSession>;
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; params: unknown }>;
  /** How many updates the buffer keeps; past that a re-open has a hole. */
  replayBuffer: number;
  /** What the agent replies with, so a test can tell one run of a prompt from the next. */
  answer: (prompt: string) => string;
}

export function createWorld(over: Partial<World> = {}): World {
  return { sessions: [], live: {}, calls: [], replayBuffer: 100, answer: (prompt) => `re: ${prompt}`, ...over };
}

/** Register a persisted session the catalog lists and the worker can load. */
export function addSession(world: World, path: string, cwd = PROJECT_CWD): void {
  world.sessions.push(summary({ path, cwd, messageCount: 0 }));
  world.live[path] = { state: sessionState({ path, cwd }), entries: [], leafId: null, seq: 0, buffer: [] };
}

let entryCounter = 0;
let forkCounter = 0;

/**
 * Append an entry under the current leaf and move the leaf onto it — the one
 * write `SessionManager` makes, and the reason an edit lands beside the old
 * version rather than after it.
 */
export function appendEntry(world: World, path: string, entry: Omit<TreeEntry, "id" | "parentId">): TreeEntry {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  const persisted: TreeEntry = { id: `e${++entryCounter}`, parentId: live.leafId, ...entry };
  live.entries.push(persisted);
  live.leafId = persisted.id;
  return persisted;
}

/** The text of a persisted message entry, as `contentText` reads it. */
const entryText = (entry: TreeEntry): string => (entry.message?.content ?? []).map((part) => part.text ?? "").join("");

/**
 * What the worker does on a driver event: number it, buffer it, broadcast it.
 * Every connected client hears it, exactly as the host broadcasts.
 */
export function emit(world: World, path: string, update: SessionUpdate): void {
  // Numbered and buffered whether or not anyone is listening, exactly as the
  // worker does — that is the whole state this bug lives in.
  const params = record(world, path, update);
  for (const client of FakeWorkerClient.instances) client.deliver("session/update", params);
}

/**
 * The same event with nobody listening: numbered and buffered, never
 * delivered. What a dropped socket or a session nothing is attached to
 * produces, and the only way a client can fall behind the buffer's floor.
 */
export function emitOffline(world: World, path: string, update: SessionUpdate): void {
  record(world, path, update);
}

function record(world: World, path: string, update: SessionUpdate): SessionUpdateParams {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  const params: SessionUpdateParams = { sessionPath: path, seq: ++live.seq, at: "2026-09-08T10:00:00.000Z", update };
  live.buffer.push(params);
  if (live.buffer.length > world.replayBuffer) live.buffer.splice(0, live.buffer.length - world.replayBuffer);
  return params;
}

/** A turn as it reaches both the buffer and, on completion, the session file. */
export function runTurn(world: World, path: string, prompt: string, answer: string): void {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  emit(world, path, { kind: "message_start", role: "user" });
  emit(world, path, { kind: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  emit(world, path, { kind: "message_start", role: "assistant" });
  emit(world, path, { kind: "text_delta", delta: answer, contentIndex: 0 });
  emit(world, path, { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
  appendEntry(world, path, { type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  appendEntry(world, path, { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
  live.state = { ...live.state, messageCount: live.entries.length };
}

/**
 * A turn that has started and not finished: the prompt is persisted (its
 * entry rides on the user `message_end`, as the real worker sends it) and the
 * reply is one word in. Nothing ends it but `stopTurn`, `session/cancel` or a
 * move with `stopFirst`.
 */
export function startTurn(world: World, path: string, prompt: string, partial: string): TreeEntry {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  const entry = appendEntry(world, path, { type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  emit(world, path, { kind: "agent_start" });
  emit(world, path, { kind: "message_start", role: "user" });
  emit(world, path, { kind: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] }, entry: { id: entry.id, parentId: entry.parentId } });
  emit(world, path, { kind: "message_start", role: "assistant" });
  emit(world, path, { kind: "text_delta", delta: partial, contentIndex: 0 });
  live.state = { ...live.state, isStreaming: true };
  live.streaming = { prompt, partial };
  return entry;
}

/**
 * `AgentSession.abort()` as the real driver reports it: the partial reply
 * settles with `stopReason: "aborted"` and is persisted under the prompt, then
 * `agent_end` and `agent_settled`. Idle sessions have nothing to stop.
 */
export function stopTurn(world: World, path: string): void {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  const turn = live.streaming;
  if (!turn) return;
  live.streaming = undefined;
  const message = { role: "assistant", content: [{ type: "text", text: turn.partial }], stopReason: "aborted" as const };
  emit(world, path, { kind: "message_end", message, stopReason: "aborted" });
  appendEntry(world, path, { type: "message", message });
  live.state = { ...live.state, isStreaming: false, messageCount: live.entries.length };
  emit(world, path, { kind: "agent_end", willRetry: false });
  emit(world, path, { kind: "state", state: live.state });
  emit(world, path, { kind: "agent_settled" });
}

/**
 * The worker restarted: the session file survives, the `seq` counter does not.
 * A client still holding the old epoch's watermark has to notice and resync.
 */
export function restartWorker(world: World, path: string): void {
  const live = world.live[path];
  if (!live) throw new Error(`No session at ${path}.`);
  live.seq = 0;
  live.buffer = [];
}

/** `WorkerServer.replayFloor`, kept in step with packages/worker/src/server.ts. */
function replayFloor(live: LiveSession, fromSeq: number | undefined): number {
  const asked = fromSeq ?? 0;
  if (asked > live.seq) return live.seq;
  const oldest = live.buffer[0]?.seq;
  if (oldest === undefined) return live.seq;
  return asked >= oldest - 1 ? asked : oldest - 1;
}

export class FakeWorkerClient {
  static instances: FakeWorkerClient[] = [];
  static world: World = createWorld();
  static reset(world: World = createWorld()): void {
    FakeWorkerClient.instances = [];
    FakeWorkerClient.world = world;
  }

  /** Session path → the highest seq this client has told the worker it holds. */
  readonly attached = new Map<string, number>();

  constructor(readonly options: HostClientOptions) {
    FakeWorkerClient.instances.push(this);
  }

  connect(): void {
    queueMicrotask(() => this.options.onConnection?.("open"));
  }
  reconnect(): void {}
  close(): void {}
  track(path: string, seq = 0): void {
    if (!this.attached.has(path) || (this.attached.get(path) ?? 0) < seq) this.attached.set(path, seq);
  }
  untrack(path: string): void {
    this.attached.delete(path);
  }
  resync(path: string, seq: number): void {
    if (this.attached.has(path)) this.attached.set(path, seq);
  }
  whenConnected(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): () => void {
    return () => {};
  }

  /** Deliver a host notification, exactly as the socket would. */
  deliver<M extends keyof HostNotifications>(method: M, params: HostNotifications[M]): void {
    if (method === "session/update") {
      const p = params as SessionUpdateParams;
      if (this.attached.has(p.sessionPath)) this.attached.set(p.sessionPath, p.seq);
    }
    this.options.onNotification(method as Parameters<HostClientOptions["onNotification"]>[0], params);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const world = FakeWorkerClient.world;
    world.calls.push({ method, params });
    const p = (params ?? {}) as Record<string, unknown>;
    // A move that stops a turn first is two steps inside one request, with
    // time between them — enough for whatever the settle triggers to arrive.
    if ((method === "pi/session/navigate" || method === "pi/session/fork") && p.stopFirst) {
      stopTurn(world, p.path as string);
      await settle(5);
      return handle(world, this, method, { ...p, stopFirst: false });
    }
    return handle(world, this, method, p);
  }
}

function handle(world: World, client: FakeWorkerClient, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "pi/session/list":
      return { sessions: world.sessions };
    case "pi/project/list":
      return { projects: [{ cwd: PROJECT_CWD, name: "p", trusted: true }] };
    case "agents/list":
      return agentsSnapshot();
    case "agents/runs/list":
      return { runs: [] };
    case "session/load": {
      const path = params.path as string;
      const live = world.live[path];
      if (!live) throw new Error(`There is no session at ${path}.`);
      const fromSeq = params.fromSeq as number | undefined;
      // The worker replays inside the handler, so every replayed update
      // reaches the client *before* this reply does.
      if (fromSeq !== undefined) {
        for (const update of live.buffer) if (update.seq > fromSeq) client.deliver("session/update", update);
      }
      return { state: live.state, replayFrom: replayFloor(live, fromSeq), seq: live.seq };
    }
    case "pi/session/entries": {
      const live = world.live[params.path as string];
      return { entries: live?.entries ?? [], leafId: live?.leafId ?? null };
    }
    /**
     * `AgentSession.navigateTree`, to the letter: a user message puts the leaf
     * on that entry's PARENT and hands its text back for the editor, so what is
     * sent next becomes another version of it; anything else puts the leaf on
     * the entry itself. Nothing is ever deleted.
     */
    case "pi/session/navigate": {
      const live = world.live[params.path as string];
      if (!live) throw new Error(`There is no session at ${params.path as string}.`);
      // The worker's stop-then-move: the stop happens first and stays done
      // whatever the move then does; without it the engine refuses mid-turn.
      if (params.stopFirst) stopTurn(world, params.path as string);
      if (live.streaming) throw new Error("Wait for the current response to finish before navigating the session tree.");
      if (live.navigateCancelled) return { cancelled: true };
      const target = live.entries.find((entry) => entry.id === params.entryId);
      if (!target) throw new Error(`Entry ${params.entryId as string} is not in this session any more.`);
      if (target.type === "message" && target.message?.role === "user") {
        live.leafId = target.parentId;
        return { cancelled: false, editorText: entryText(target) };
      }
      live.leafId = target.id;
      return { cancelled: false };
    }
    /**
     * A turn: the prompt is appended under the CURRENT leaf, so a prompt sent
     * after a navigate becomes a sibling of the message it replaces rather
     * than another line at the end of the file.
     */
    case "session/prompt": {
      const path = params.path as string;
      const live = world.live[path];
      if (!live) throw new Error(`There is no session at ${path}.`);
      const text = ((params.content as Array<{ type?: string; text?: string }>) ?? [])
        .map((part) => (part.type === "text" ? part.text ?? "" : ""))
        .join("");
      const answer = world.answer(text);
      emit(world, path, { kind: "message_start", role: "user" });
      emit(world, path, { kind: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
      emit(world, path, { kind: "message_start", role: "assistant" });
      emit(world, path, { kind: "text_delta", delta: answer, contentIndex: 0 });
      emit(world, path, { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      appendEntry(world, path, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
      appendEntry(world, path, { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      live.state = { ...live.state, messageCount: live.entries.length };
      return { accepted: true };
    }
    /**
     * `AgentSession.fork`: a NEW session file holding everything up to, but not
     * including, the target entry, with that entry's text handed back for the
     * composer. The original file is untouched — that is the whole difference
     * between this and `pi/session/navigate`.
     */
    case "pi/session/fork": {
      const from = params.path as string;
      const live = world.live[from];
      if (!live) throw new Error(`There is no session at ${from}.`);
      // As in the real driver: the stop is recorded on the original before
      // anything is forked, and the original stays served when the fork fails.
      if (params.stopFirst) stopTurn(world, from);
      if (live.streaming) throw new Error("This session has not been saved yet. Wait for the first assistant response before cloning or forking it.");
      const at = live.entries.findIndex((entry) => entry.id === params.entryId);
      if (at < 0) throw new Error(`Entry ${params.entryId as string} is not in this session any more.`);
      const path = `${from.replace(/\.jsonl$/, "")}-fork${++forkCounter}.jsonl`;
      const kept = live.entries.slice(0, at).map((entry) => ({ ...entry }));
      world.sessions.push(summary({ path, cwd: PROJECT_CWD, messageCount: kept.length }));
      world.live[path] = {
        state: sessionState({ path, cwd: PROJECT_CWD }),
        entries: kept,
        leafId: kept.at(-1)?.id ?? null,
        seq: 0,
        buffer: [],
      };
      return { state: world.live[path]!.state, editorText: entryText(live.entries[at]!) };
    }
    case "session/goal/get":
      return { goal: null };
    case "session/pending/list":
      return { messages: [] };
    case "session/cancel":
      stopTurn(world, params.path as string);
      return {};
    /**
     * `pi/session/move` as the host does it (M13-T58): the file changes home,
     * its header names the project, and the old path is served by nobody.
     * Refused mid-turn, as the worker's `pi/session/close` refuses.
     */
    case "pi/session/move": {
      const from = params.path as string;
      const cwd = params.cwd as string;
      const live = world.live[from];
      const listed = world.sessions.findIndex((s) => s.path === from);
      if (!live || listed < 0) throw new Error("That session is no longer on disk.");
      if (live.streaming) throw new Error("This chat is still answering. Wait for it to finish, or stop it, then move it.");
      const moved = `${cwd}/sessions/${from.split("/").pop() ?? "moved.jsonl"}`;
      world.sessions[listed] = summary({ ...world.sessions[listed]!, path: moved, cwd, agent: { agentName: "default", kind: "root" } });
      delete world.live[from];
      world.live[moved] = { ...live, state: { ...live.state, path: moved, cwd, agent: { agentName: "default", kind: "root" } } };
      return { path: moved };
    }
    case "pi/session/detach":
    case "pi/session/seen":
      return {};
    case "pi/prefs/get":
      return { entries: [], revision: 0 };
    case "pi/prefs/set":
      return { revision: 1 };
    case "pi/commands/list":
      return { commands: [] };
    case "pi/models/catalog":
      return { models: [], enabledModels: null, defaultProvider: null, defaultModel: null };
    case "pi/providers/list":
      return { providers: [] };
    default:
      throw new Error(`The fake worker has no handler for ${method}.`);
  }
}

/** Wait for React effects, microtasks and short timers to settle. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
