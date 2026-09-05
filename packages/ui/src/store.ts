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
  SessionState,
  SessionSummary,
  SessionUpdate,
  UiDialogRequest,
  UiFireAndForget,
} from "@piorbit/protocol";

export type Block =
  | { kind: "user"; id: string; text: string; images: number; optimistic?: boolean }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: unknown; partial?: string; result?: unknown; isError?: boolean; done: boolean }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

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
  hydrated: boolean;
  /** Raw persisted entries (for the history/tree panel). */
  entries: unknown[];
}

export interface AppState {
  connection: "connecting" | "open" | "closed";
  sessions: SessionSummary[];
  open: Record<string, SessionView>;
  current: string | undefined;
  workers: Record<string, { status: string; message?: string }>;
  toasts: Array<{ id: number; level: "info" | "warning" | "error"; text: string }>;
}

export const initialState: AppState = {
  connection: "closed",
  sessions: [],
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
  | { type: "hydrate"; path: string; entries: unknown[] }
  | { type: "entries"; path: string; entries: unknown[] }
  | { type: "forked"; from: string; state: SessionState }
  | { type: "optimisticUser"; path: string; text: string; images: number }
  | { type: "dialogAnswered"; id: string }
  | { type: "toast"; level: "info" | "warning" | "error"; text: string }
  | { type: "notification"; method: HostNotificationMethod; params: HostNotifications[HostNotificationMethod] }
  | { type: "dismissToast"; id: number };

let blockCounter = 0;
let toastCounter = 0;
const nextBlockId = () => `b${++blockCounter}`;

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "sessions":
      return { ...state, sessions: action.sessions };
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
            hydrated: false,
            entries: [],
          };
      return { ...state, open: { ...state.open, [view.path]: view }, current: view.path };
    }
    case "forked": {
      // The old view's live state moved to a new path; carry the transcript over.
      const old = state.open[action.from];
      const { [action.from]: _gone, ...rest } = state.open;
      const view: SessionView = old
        ? { ...old, path: action.state.path, state: action.state, lastSeq: 0, hydrated: false, entries: [] }
        : { path: action.state.path, state: action.state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] }, dialogs: [], statuses: {}, widgets: {}, hydrated: false, entries: [] };
      return { ...state, open: { ...rest, [view.path]: view }, current: view.path };
    }
    case "select":
      return { ...state, current: action.path };
    case "closeView": {
      const { [action.path]: _gone, ...rest } = state.open;
      return { ...state, open: rest, current: state.current === action.path ? undefined : state.current };
    }
    case "hydrate":
      return updateView(state, action.path, (v) => ({ ...v, blocks: blocksFromEntries(action.entries), entries: action.entries, hydrated: true }));
    case "entries":
      return updateView(state, action.path, (v) => ({ ...v, entries: action.entries }));
    case "optimisticUser":
      return updateView(state, action.path, (v) => ({
        ...v,
        blocks: [...v.blocks, { kind: "user", id: nextBlockId(), text: action.text, images: action.images, optimistic: true }],
      }));
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "toast":
      return pushToast(state, action.level, action.text);
    case "dialogAnswered": {
      const open: Record<string, SessionView> = {};
      for (const [path, v] of Object.entries(state.open)) {
        open[path] = v.dialogs.some((d) => d.id === action.id) ? { ...v, dialogs: v.dialogs.filter((d) => d.id !== action.id) } : v;
      }
      return { ...state, open };
    }
    case "notification":
      return applyNotification(state, action.method, action.params);
  }
}

function updateView(state: AppState, path: string, fn: (v: SessionView) => SessionView): AppState {
  const view = state.open[path];
  if (!view) return state;
  return { ...state, open: { ...state.open, [path]: fn(view) } };
}

function applyNotification(state: AppState, method: HostNotificationMethod, params: unknown): AppState {
  switch (method) {
    case "session/update": {
      const p = params as HostNotifications["session/update"];
      return updateView(state, p.sessionPath, (v) => {
        if (p.seq <= v.lastSeq) return v; // replayed duplicate
        return { ...applyUpdate(v, p.update), lastSeq: p.seq };
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
      if (p.message.type === "piorbit/module/log" && p.message.level === "error") {
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

function pushToast(state: AppState, level: "info" | "warning" | "error", text: string): AppState {
  return { ...state, toasts: [...state.toasts, { id: ++toastCounter, level, text }] };
}

function applyUiEvent(state: AppState, path: string, event: UiFireAndForget): AppState {
  switch (event.method) {
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
        if (v.blocks.at(-1)?.kind === "user" && (v.blocks.at(-1) as { optimistic?: boolean }).optimistic) return v;
        return { ...v, blocks: [...v.blocks, { kind: "user", id: nextBlockId(), text: "", images: 0 }] };
      }
      if (u.role === "assistant") {
        return { ...v, blocks: [...closeStreaming(v.blocks), { kind: "assistant", id: nextBlockId(), text: "", thinking: "", streaming: true }] };
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
        const last = v.blocks.at(-1);
        const text = textOf(msg.content);
        if (last?.kind === "user") return { ...v, blocks: replaceLast(v.blocks, { ...last, text: text || last.text, optimistic: false }) };
        return v;
      }
      if (msg?.role === "assistant") {
        const a = lastAssistant(v.blocks);
        if (!a) return v;
        const finalText = textOf(msg.content);
        return { ...v, blocks: replaceLast(v.blocks, { ...a, text: finalText || a.text, streaming: false }) };
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

/** Rebuild blocks from persisted Pi entries (session-format.md). Unknown shapes are ignored. */
export function blocksFromEntries(entries: unknown[]): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();
  for (const raw of entries) {
    const e = raw as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") {
      blocks.push({ kind: "user", id: nextBlockId(), text: textOf(m.content), images: countImages(m.content) });
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>) : [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("");
      if (text || thinking) blocks.push({ kind: "assistant", id: nextBlockId(), text, thinking, streaming: false });
      for (const p of parts) {
        if (p.type === "toolCall" && p.id) {
          toolIndex.set(p.id, blocks.length);
          blocks.push({ kind: "tool", id: p.id, name: p.name ?? "tool", args: p.arguments, done: false });
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

function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter((c) => (c as { type?: string })?.type === "image").length : 0;
}
