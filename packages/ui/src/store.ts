/**
 * App state and the reducer that folds protocol notifications into it.
 * Pure: no React, no DOM. Tested in test/store.test.ts.
 *
 * Transcript blocks are assembled from message/tool events (Pi emits
 * `entry_appended` only for extension custom entries, so it is not the source
 * of transcript state). Past sessions hydrate from `pi/session/entries`.
 */
import type {
  HostNotificationMethod,
  HostNotifications,
  MessageSpeaker,
  PiExtensionModuleName,
  SessionState,
  SessionSummary,
  SessionUpdate,
  StopReason,
  UiDialogRequest,
  UiFireAndForget,
  Usage,
} from "@lasercode/protocol";

/**
 * `at` is the ISO timestamp the block first appeared (from the notification's
 * `at`, or the persisted entry's `timestamp`). Optional: a block assembled by
 * `applyUpdate` outside the reducer has none.
 */
export type Block =
  | { kind: "user"; id: string; at?: string; text: string; images: number; optimistic?: boolean }
  | {
      kind: "assistant";
      id: string;
      at?: string;
      text: string;
      thinking: string;
      streaming: boolean;
      /**
       * Why this turn ended, from `message_end`. `stop` and `toolUse` are the
       * ordinary endings; anything else is a turn that stopped short and the
       * transcript says so out loud.
       */
      stopReason?: StopReason;
      /** The provider's own words when `stopReason` is `error`. */
      errorMessage?: string;
      /** This one turn's token counts. Never a running total. */
      usage?: Usage;
      /** Set only when something other than the session's own agent spoke. */
      speaker?: MessageSpeaker;
    }
  | { kind: "tool"; id: string; at?: string; name: string; args: unknown; partial?: string; result?: unknown; isError?: boolean; done: boolean }
  | { kind: "notice"; id: string; at?: string; level: "info" | "warning" | "error"; text: string };

export interface SessionView {
  path: string;
  state: SessionState;
  blocks: Block[];
  lastSeq: number;
  running: boolean;
  queue: { steering: string[]; followUp: string[] };
  dialogs: UiDialogRequest[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;
  editorText?: string;
  /**
   * When this view was first opened. Stands in for `createdAt`/`modifiedAt`
   * while the session is not yet in the catalog (Pi writes the file on the
   * first message); a wall-clock read at use time would make every derived
   * list — and the thread-list signature — change on every render.
   */
  openedAt: string;
  hydrated: boolean;
  /** Raw persisted entries (for the history/tree panel). */
  entries: unknown[];
  /**
   * Companion-extension modules active in this session, from
   * `laser/capabilities`. Features that only exist where their package does
   * gate on this and are hidden, never disabled, when it is absent (R2).
   */
  capabilities: PiExtensionModuleName[];
}

export interface AppState {
  connection: "connecting" | "open" | "closed";
  sessions: SessionSummary[];
  /** True once a `pi/session/list` has landed, so an empty list is real. */
  sessionsLoaded: boolean;
  open: Record<string, SessionView>;
  current: string | undefined;
  workers: Record<string, { status: string; message?: string }>;
  toasts: Array<{ id: number; level: "info" | "warning" | "error"; text: string }>;
}

export const initialState: AppState = {
  connection: "closed",
  sessions: [],
  sessionsLoaded: false,
  open: {},
  current: undefined,
  workers: {},
  toasts: [],
};

export type Action =
  | { type: "connection"; state: AppState["connection"] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "opened"; state: SessionState }
  | { type: "select"; path: string | undefined }
  | { type: "closeView"; path: string }
  /**
   * Replace the transcript from a persisted snapshot. `expectSeq` guards the
   * round trip: when live updates advanced `lastSeq` while `pi/session/entries`
   * was in flight the snapshot is stale, so only `entries` is refreshed and the
   * live blocks are kept.
   */
  | { type: "hydrate"; path: string; entries: unknown[]; expectSeq?: number }
  | { type: "entries"; path: string; entries: unknown[] }
  /**
   * The worker that owns this session restarted its per-process `seq` counter
   * (worker crash, host restart). Adopt the new epoch and re-hydrate, or every
   * later update is deduped away as a "replay" (see `applyNotification`).
   */
  | { type: "resync"; path: string; lastSeq: number }
  | { type: "forked"; from: string; state: SessionState }
  | { type: "optimisticUser"; path: string; text: string; images: number; id?: string }
  /** A prompt never reached the worker: drop the block that stood in for it. */
  | { type: "optimisticFailed"; path: string; id: string }
  | { type: "dialogAnswered"; id: string; path?: string }
  | { type: "toast"; level: "info" | "warning" | "error"; text: string }
  | { type: "notification"; method: HostNotificationMethod; params: HostNotifications[HostNotificationMethod] }
  | { type: "dismissToast"; id: number };

let blockCounter = 0;
let toastCounter = 0;
const nextBlockId = () => `b${++blockCounter}`;

/**
 * Mint a block id outside the reducer, so a caller that dispatches an
 * optimistic block can also address it later (`optimisticFailed`).
 */
export function newBlockId(): string {
  return nextBlockId();
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "sessions":
      return { ...state, sessions: action.sessions, sessionsLoaded: true };
    case "opened": {
      const existing = state.open[action.state.path];
      const view: SessionView = existing
        ? { ...existing, state: action.state }
        : {
            path: action.state.path,
            state: action.state,
            blocks: [],
            lastSeq: 0,
            running: action.state.isStreaming,
            queue: { steering: [], followUp: [] },
            dialogs: [],
            statuses: {},
            widgets: {},
            openedAt: new Date().toISOString(),
            hydrated: false,
            entries: [],
            capabilities: [],
          };
      return { ...state, open: { ...state.open, [view.path]: view }, current: view.path };
    }
    case "forked": {
      // The old view's live state moved to a new path; carry the transcript over.
      const old = state.open[action.from];
      const { [action.from]: _gone, ...rest } = state.open;
      const view: SessionView = old
        ? { ...old, path: action.state.path, state: action.state, lastSeq: 0, hydrated: false, entries: [] }
        : { path: action.state.path, state: action.state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] }, dialogs: [], statuses: {}, widgets: {}, openedAt: new Date().toISOString(), hydrated: false, entries: [], capabilities: [] };
      return { ...state, open: { ...rest, [view.path]: view }, current: view.path };
    }
    case "select":
      return { ...state, current: action.path };
    case "closeView": {
      const { [action.path]: _gone, ...rest } = state.open;
      return { ...state, open: rest, current: state.current === action.path ? undefined : state.current };
    }
    case "hydrate":
      return updateView(state, action.path, (v) =>
        // Live updates landed while the snapshot was in flight: they already
        // carry what the snapshot has, plus what it does not.
        action.expectSeq !== undefined && v.lastSeq !== action.expectSeq
          ? { ...v, entries: action.entries, hydrated: true }
          : { ...v, blocks: blocksFromEntries(action.entries), entries: action.entries, hydrated: true },
      );
    case "entries":
      return updateView(state, action.path, (v) => ({ ...v, entries: action.entries }));
    case "resync":
      return updateView(state, action.path, (v) =>
        v.lastSeq <= action.lastSeq ? v : { ...v, lastSeq: action.lastSeq, hydrated: false },
      );
    case "optimisticUser":
      return updateView(state, action.path, (v) => ({
        ...v,
        blocks: [
          ...v.blocks,
          { kind: "user", id: action.id ?? nextBlockId(), text: action.text, images: action.images, optimistic: true },
        ],
      }));
    case "optimisticFailed":
      return updateView(state, action.path, (v) => {
        const index = v.blocks.findIndex((b) => b.id === action.id && b.kind === "user" && b.optimistic === true);
        return index === -1 ? v : { ...v, blocks: [...v.blocks.slice(0, index), ...v.blocks.slice(index + 1)] };
      });
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "toast":
      return pushToast(state, action.level, action.text);
    case "dialogAnswered": {
      const drop = (v: SessionView): SessionView =>
        v.dialogs.some((d) => d.id === action.id) ? { ...v, dialogs: v.dialogs.filter((d) => d.id !== action.id) } : v;
      // Dialog ids are only unique per session; scope the removal when the
      // caller knows which session raised it.
      if (action.path !== undefined) return updateView(state, action.path, drop);
      const open: Record<string, SessionView> = {};
      for (const [path, v] of Object.entries(state.open)) open[path] = drop(v);
      return { ...state, open };
    }
    case "notification":
      return applyNotification(state, action.method, action.params);
  }
}

function updateView(state: AppState, path: string, fn: (v: SessionView) => SessionView): AppState {
  const view = state.open[path];
  if (!view) return state;
  const next = fn(view);
  // A reducer that returns the same view must not produce a new state object,
  // or every no-op notification re-renders every subscriber.
  return next === view ? state : { ...state, open: { ...state.open, [path]: next } };
}

function applyNotification(state: AppState, method: HostNotificationMethod, params: unknown): AppState {
  switch (method) {
    case "session/update": {
      const p = params as HostNotifications["session/update"];
      return updateView(state, p.sessionPath, (v) => {
        if (p.seq <= v.lastSeq) return v; // replayed duplicate
        const next = applyUpdate(v, p.update);
        return { ...next, blocks: stampNewBlocks(v.blocks, next.blocks, p.at), lastSeq: p.seq };
      });
    }
    case "pi/ui/request": {
      const p = params as HostNotifications["pi/ui/request"];
      const { path, ...request } = p;
      return updateView(state, path, (v) =>
        v.dialogs.some((d) => d.id === request.id) ? v : { ...v, dialogs: [...v.dialogs, request as UiDialogRequest] },
      );
    }
    case "pi/ui/event": {
      const p = params as HostNotifications["pi/ui/event"];
      const { path, ...event } = p;
      return applyUiEvent(state, path, event as UiFireAndForget);
    }
    case "pi/extension/message": {
      const p = params as HostNotifications["pi/extension/message"];
      if (p.message.type === "lasercode/capabilities") {
        const active = p.message.active;
        return updateView(state, p.path, (v) =>
          v.capabilities.length === active.length && active.every((m, i) => v.capabilities[i] === m)
            ? v
            : { ...v, capabilities: [...active] },
        );
      }
      if (p.message.type === "lasercode/module/log" && p.message.level === "error") {
        return pushToast(state, "error", `${p.message.module}: ${p.message.message}`);
      }
      return state;
    }
    case "pi/worker/status": {
      const p = params as HostNotifications["pi/worker/status"];
      const next = { ...state, workers: { ...state.workers, [p.cwd]: { status: p.status, ...(p.message ? { message: p.message } : {}) } } };
      return p.status === "crashed" ? pushToast(next, "error", `Worker for ${p.cwd} crashed: ${p.message ?? ""}`) : next;
    }
    default:
      return state;
  }
}

/**
 * Stamp `at` on blocks the update just appended. Blocks are append-only, so the
 * only candidates are the ones past `before.length`; the common delta (same
 * length, same tail id) does no work at all.
 */
function stampNewBlocks(before: Block[], after: Block[], at: string): Block[] {
  if (before === after || !at) return after;
  if (after.length <= before.length) return after;
  let changed = false;
  const next = after.slice();
  for (let i = before.length; i < next.length; i++) {
    const b = next[i]!;
    if (b.at !== undefined) continue;
    next[i] = { ...b, at };
    changed = true;
  }
  return changed ? next : after;
}

function pushToast(state: AppState, level: "info" | "warning" | "error", text: string): AppState {
  return { ...state, toasts: [...state.toasts, { id: ++toastCounter, level, text }] };
}

function applyUiEvent(state: AppState, path: string, event: UiFireAndForget): AppState {
  switch (event.method) {
    // The worker settled a pending dialog without us (timeout, abort, session
    // end). Drop it so the card/tool footer disappears instead of hanging.
    case "dialogResolved":
      return updateView(state, path, (v) =>
        v.dialogs.some((d) => d.id === event.id) ? { ...v, dialogs: v.dialogs.filter((d) => d.id !== event.id) } : v,
      );
    case "notify":
      return pushToast(state, event.level, event.message);
    case "setStatus":
      return updateView(state, path, (v) => {
        const statuses = { ...v.statuses };
        if (event.text === undefined) delete statuses[event.key];
        else statuses[event.key] = event.text;
        return { ...v, statuses };
      });
    case "setWidget":
      return updateView(state, path, (v) => {
        const widgets = { ...v.widgets };
        if (!event.lines) delete widgets[event.key];
        else widgets[event.key] = { lines: event.lines, placement: event.placement };
        return { ...v, widgets };
      });
    case "setTitle":
      return updateView(state, path, (v) => ({ ...v, title: event.title }));
    case "setEditorText":
      return updateView(state, path, (v) => ({ ...v, editorText: event.text }));
  }
}

function lastAssistant(blocks: Block[]): Extract<Block, { kind: "assistant" }> | undefined {
  const last = blocks.at(-1);
  return last?.kind === "assistant" && last.streaming ? last : undefined;
}

function replaceLast(blocks: Block[], block: Block): Block[] {
  return [...blocks.slice(0, -1), block];
}

function replaceAt(blocks: Block[], index: number, block: Block): Block[] {
  const next = blocks.slice();
  next[index] = block;
  return next;
}

/**
 * Index of the newest block still standing in for a prompt we sent. A refused
 * prompt steers instead, so assistant deltas can land between the optimistic
 * block and the real user `message_start`: only a backwards scan finds it.
 */
function lastOptimisticUserIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "user" && b.optimistic === true) return i;
  }
  return -1;
}

export function applyUpdate(v: SessionView, u: SessionUpdate): SessionView {
  switch (u.kind) {
    case "agent_start":
      return { ...v, running: true };
    case "agent_end":
    case "agent_settled":
      return { ...v, running: false, blocks: closeStreaming(v.blocks) };
    case "state":
      return { ...v, state: u.state, running: u.state.isStreaming };
    case "message_start": {
      if (u.role === "user") {
        // An optimistic block already stands in for this message.
        if (lastOptimisticUserIndex(v.blocks) !== -1) return v;
        return { ...v, blocks: [...v.blocks, { kind: "user", id: nextBlockId(), text: "", images: 0 }] };
      }
      if (u.role === "assistant") {
        return { ...v, blocks: [...closeStreaming(v.blocks), { kind: "assistant", id: nextBlockId(), text: "", thinking: "", streaming: true }] };
      }
      // A custom message with a speaker is a child run talking into this
      // session — the one case where words arrive that the session's own agent
      // did not say. It gets a block of its own so the transcript can put a
      // name over it; a custom message with no speaker is Pi's internal
      // bookkeeping and stays invisible, as before.
      if (u.role === "custom" && u.speaker) {
        return {
          ...v,
          blocks: [
            ...closeStreaming(v.blocks),
            { kind: "assistant", id: nextBlockId(), text: "", thinking: "", streaming: true, speaker: u.speaker },
          ],
        };
      }
      return v;
    }
    case "text_delta": {
      const a = lastAssistant(v.blocks);
      if (!a) return { ...v, blocks: [...v.blocks, { kind: "assistant", id: nextBlockId(), text: u.delta, thinking: "", streaming: true }] };
      return { ...v, blocks: replaceLast(v.blocks, { ...a, text: a.text + u.delta }) };
    }
    case "thinking_delta": {
      const a = lastAssistant(v.blocks);
      if (!a) return { ...v, blocks: [...v.blocks, { kind: "assistant", id: nextBlockId(), text: "", thinking: u.delta, streaming: true }] };
      return { ...v, blocks: replaceLast(v.blocks, { ...a, thinking: a.thinking + u.delta }) };
    }
    case "message_end": {
      const msg = u.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role === "user") {
        const text = textOf(msg.content);
        const optimistic = lastOptimisticUserIndex(v.blocks);
        const index = optimistic !== -1 ? optimistic : v.blocks.at(-1)?.kind === "user" ? v.blocks.length - 1 : -1;
        if (index === -1) return v;
        const block = v.blocks[index] as Extract<Block, { kind: "user" }>;
        return { ...v, blocks: replaceAt(v.blocks, index, { ...block, text: text || block.text, optimistic: false }) };
      }
      if (msg?.role === "assistant" || (msg?.role === "custom" && u.speaker)) {
        const a = lastAssistant(v.blocks);
        if (!a) return v;
        const finalText = textOf(msg.content);
        return {
          ...v,
          blocks: replaceLast(v.blocks, {
            ...a,
            text: finalText || a.text,
            streaming: false,
            ...(u.stopReason !== undefined ? { stopReason: u.stopReason } : {}),
            ...(u.errorMessage !== undefined ? { errorMessage: u.errorMessage } : {}),
            ...(u.usage !== undefined ? { usage: u.usage } : {}),
            ...(u.speaker !== undefined ? { speaker: u.speaker } : {}),
          }),
        };
      }
      return v;
    }
    case "tool_execution_start":
      return { ...v, blocks: [...closeStreaming(v.blocks), { kind: "tool", id: u.toolCallId, name: u.toolName, args: u.args, done: false }] };
    case "tool_execution_update":
      return { ...v, blocks: v.blocks.map((b) => (b.kind === "tool" && b.id === u.toolCallId ? { ...b, partial: String(stringify(u.partial)) } : b)) };
    case "tool_execution_end":
      return {
        ...v,
        blocks: v.blocks.map((b) => (b.kind === "tool" && b.id === u.toolCallId ? { ...b, result: u.result, isError: u.isError, done: true } : b)),
      };
    case "queue_update":
      return { ...v, queue: { steering: u.steering, followUp: u.followUp } };
    case "compaction_start":
      return notice(v, "info", "Compacting context…");
    case "compaction_end":
      return notice(v, u.ok ? "info" : "warning", u.ok ? "Context compacted." : "Compaction did not complete.");
    case "auto_retry_start":
      return notice(v, "warning", `Retrying (${u.attempt}/${u.maxAttempts})…`);
    case "extension_error":
      return notice(v, "error", `${u.extension}: ${u.message}`);
    default:
      return v;
  }
}

function closeStreaming(blocks: Block[]): Block[] {
  const a = lastAssistant(blocks);
  return a ? replaceLast(blocks, { ...a, streaming: false }) : blocks;
}

function notice(v: SessionView, level: "info" | "warning" | "error", text: string): SessionView {
  return { ...v, blocks: [...v.blocks, { kind: "notice", id: nextBlockId(), level, text }] };
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The stop reasons that draw a stopped row; every other ending is an ordinary one. */
const STOPPED_SHORT = new Set<string>(["aborted", "length", "error", "deferred"]);

/** Rebuild blocks from persisted Pi entries (session-format.md). Unknown shapes are ignored. */
export function blocksFromEntries(entries: unknown[]): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();
  for (const raw of entries) {
    const e = raw as {
      type?: string;
      timestamp?: unknown;
      message?: {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        timestamp?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
      };
    };
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const at = entryTimestamp(e.timestamp ?? m.timestamp);
    if (m.role === "user") {
      blocks.push({ kind: "user", id: nextBlockId(), ...(at ? { at } : {}), text: textOf(m.content), images: countImages(m.content) });
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>) : [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("");
      // A turn that ended short belongs in the transcript even when it said
      // nothing: without this, an authentication failure reloads as a bare
      // question with no answer under it and nothing to explain the silence.
      // `stop`, `toolUse` and `pending` end a turn the ordinary way and draw no
      // row — the same list `incompleteReason` in runtime/projection.ts uses.
      const stopReason = STOPPED_SHORT.has(m.stopReason as string) ? (m.stopReason as StopReason) : undefined;
      const errorMessage = typeof m.errorMessage === "string" && m.errorMessage !== "" ? m.errorMessage : undefined;
      if (text || thinking || stopReason) {
        blocks.push({
          kind: "assistant",
          id: nextBlockId(),
          ...(at ? { at } : {}),
          text,
          thinking,
          streaming: false,
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
      }
      for (const p of parts) {
        if (p.type === "toolCall" && p.id) {
          toolIndex.set(p.id, blocks.length);
          blocks.push({ kind: "tool", id: p.id, ...(at ? { at } : {}), name: p.name ?? "tool", args: p.arguments, done: false });
        }
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      const i = toolIndex.get(m.toolCallId);
      const result = textOf(m.content);
      if (i !== undefined) {
        const b = blocks[i] as Extract<Block, { kind: "tool" }>;
        blocks[i] = { ...b, result, isError: m.isError ?? false, done: true };
      }
    }
  }
  return blocks;
}

/** Pi entries stamp `timestamp` as epoch ms or an ISO string; both become ISO. */
function entryTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter((c) => (c as { type?: string })?.type === "image").length : 0;
}
