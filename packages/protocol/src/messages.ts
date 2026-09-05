/**
 * Message vocabulary. ACP-shaped core (session/new, session/load,
 * session/prompt, session/cancel, session/request_permission) plus `pi/*`
 * extras. Draft for M0-T2: zod schemas and runtime validation are still to be
 * written; keep the TypeScript types and the schemas in one place when you do.
 *
 * Every host → client update carries a per-session monotonically increasing
 * `seq`. Clients resume with `session/load { fromSeq }`.
 */

import type { PiExtensionMessage } from "./pi-extension.js";

// ---------- Shared value types (no Pi types allowed here) ----------

export interface ImageContent {
  type: "image";
  mimeType: string;
  /** base64 */
  data: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export type ContentBlock = TextContent | ImageContent;

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Attention state for the sidebar/inbox (M2-T2). */
export type SessionAttention = "idle" | "working" | "waiting_for_input" | "error" | "finished_unread";

export interface SessionSummary {
  /** File path of the Pi session, the stable identity (ids are only unique per cwd). */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentPath?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage?: string;
  attention?: SessionAttention;
}

export interface SessionState {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  /** `tokens`/`percent` are null right after compaction, before the next response. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

// ---------- Session updates (host → client notifications) ----------

/** Mirrors Pi SDK 0.85 AgentSessionEvent names so the driver mapping is 1:1. */
export type SessionUpdate =
  | { kind: "agent_start" }
  | { kind: "agent_end"; willRetry?: boolean }
  | { kind: "agent_settled" }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "message_start"; role: "user" | "assistant" | "tool" | "custom"; messageId?: string }
  | { kind: "text_delta"; delta: string; contentIndex: number }
  | { kind: "thinking_delta"; delta: string; contentIndex: number }
  | { kind: "toolcall_delta"; delta: string; contentIndex: number }
  | { kind: "message_end"; message: unknown }
  | { kind: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "tool_execution_update"; toolCallId: string; partial: unknown }
  | { kind: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean }
  | { kind: "bash_execution_update"; id?: string; delta: string }
  | { kind: "queue_update"; steering: string[]; followUp: string[] }
  | { kind: "compaction_start" }
  | { kind: "compaction_end"; ok: boolean }
  | { kind: "auto_retry_start"; attempt: number; maxAttempts: number }
  | { kind: "auto_retry_end"; ok: boolean }
  /** Only for custom entries appended by extensions (pi.appendEntry); regular messages do not produce this. */
  | { kind: "entry_appended"; entry: unknown }
  | { kind: "state"; state: SessionState }
  | { kind: "extension_error"; extension: string; message: string };

export interface SessionUpdateParams {
  sessionPath: string;
  seq: number;
  update: SessionUpdate;
  at: string;
}

// ---------- Extension UI (host → client requests; mirrors Pi RPC extension_ui_request) ----------

/**
 * `toolCallId` is stamped by the worker when the dialog was raised while exactly
 * one tool call was executing, so the UI can render it inside that tool's row
 * (approval / interrupt). Absent = free-standing dialog (render above composer).
 */
export type UiDialogRequest =
  | { method: "select"; id: string; title: string; options: string[]; timeoutMs?: number; toolCallId?: string }
  | { method: "confirm"; id: string; title: string; message?: string; timeoutMs?: number; toolCallId?: string }
  | { method: "input"; id: string; title: string; placeholder?: string; timeoutMs?: number; toolCallId?: string }
  | { method: "editor"; id: string; title: string; prefill?: string; timeoutMs?: number; toolCallId?: string };

export type UiDialogResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type UiFireAndForget =
  /** A pending dialog was settled without a client answer (timeout, abort, session end). */
  | { method: "dialogResolved"; id: string }
  | { method: "notify"; message: string; level: "info" | "warning" | "error" }
  | { method: "setStatus"; key: string; text?: string }
  | { method: "setWidget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
  | { method: "setTitle"; title: string }
  | { method: "setEditorText"; text: string };

// ---------- Method catalogue ----------

/** Client → host requests. */
export interface ClientRequests {
  "session/new": { params: { cwd: string; parentPath?: string }; result: { state: SessionState } };
  "session/load": { params: { path: string; fromSeq?: number }; result: { state: SessionState; replayFrom: number } };
  "session/prompt": {
    params: { path: string; content: ContentBlock[]; streamingBehavior?: "steer" | "followUp" };
    result: { accepted: boolean; queued: boolean };
  };
  "session/cancel": { params: { path: string }; result: {} };
  "session/set_mode": { params: { path: string; mode: string }; result: {} };

  "pi/session/list": { params: { cwd?: string }; result: { sessions: SessionSummary[] } };
  "pi/session/steer": { params: { path: string; content: ContentBlock[] }; result: {} };
  "pi/session/follow_up": { params: { path: string; content: ContentBlock[] }; result: {} };
  "pi/session/clear_queue": { params: { path: string }; result: { steering: string[]; followUp: string[] } };
  /** Forks before `entryId` into a new session; `editorText` carries that entry's text back for editing and resending. */
  "pi/session/fork": { params: { path: string; entryId: string }; result: { state: SessionState; editorText?: string } };
  "pi/session/navigate": {
    params: { path: string; entryId: string; summarize?: boolean; label?: string };
    result: { editorText?: string; cancelled: boolean };
  };
  "pi/session/rename": { params: { path: string; name: string }; result: {} };
  /** Persisted Pi session entries (opaque; see Pi's session-format.md) for transcript hydration. */
  "pi/session/entries": { params: { path: string }; result: { entries: unknown[] } };
  "pi/session/compact": { params: { path: string; instructions?: string }; result: {} };
  "pi/model/list": { params: { path: string }; result: { models: ModelRef[] } };
  "pi/model/set": { params: { path: string; model: ModelRef }; result: { state: SessionState } };
  "pi/thinking/set": { params: { path: string; level: ThinkingLevel }; result: { state: SessionState } };
  "pi/ui/response": { params: UiDialogResponse; result: {} };
}

/** Host → client requests (client must answer). */
export interface HostRequests {
  "session/request_permission": {
    params: { path: string; toolCallId: string; toolName: string; args: unknown; options: string[] };
    result: { choice: string } | { cancelled: true };
  };
}

/**
 * Host → client notifications. Extension dialogs travel as a notification
 * (`pi/ui/request`) answered by a client request (`pi/ui/response`), the same
 * shape Pi's own RPC mode uses, so a dialog survives a client reconnect: the
 * worker re-emits pending requests on `session/load`.
 */
export interface HostNotifications {
  "session/update": SessionUpdateParams;
  "pi/ui/request": { path: string } & UiDialogRequest;
  "pi/ui/event": { path: string } & UiFireAndForget;
  "pi/extension/message": { path: string; message: PiExtensionMessage };
  "pi/worker/status": { cwd: string; status: "starting" | "ready" | "crashed" | "retired"; message?: string };
}

export type ClientMethod = keyof ClientRequests;
export type HostRequestMethod = keyof HostRequests;
export type HostNotificationMethod = keyof HostNotifications;
