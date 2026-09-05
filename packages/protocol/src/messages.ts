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

/**
 * Whether Pi may load a project's own `.pi` resources (see Pi's security.md).
 *
 * `not_required` means the directory has nothing trust-gated in it, so there is
 * nothing to ask about. `unknown` means it does and nobody has decided yet: the
 * host asks the client (`pi/project/trust_request`) before it starts a worker.
 */
export type ProjectTrust = "trusted" | "declined" | "not_required" | "unknown";

/** A project directory the host knows about. One worker per `cwd`. */
export interface ProjectInfo {
  cwd: string;
  /** Last path segment; display only. */
  name: string;
  addedAt: string;
  /** Last time a session in it was opened or created. */
  lastUsedAt?: string;
  trust: ProjectTrust;
  /** What makes the project trust-requiring; only set when `trust` is not `not_required`. */
  trustReasons?: string[];
  /** Added by a person (survives having no sessions), rather than discovered in the catalog. */
  pinned: boolean;
  /** Sessions in the catalog for this directory. */
  sessionCount: number;
}

export type WorkerStatus = "starting" | "ready" | "crashed" | "retired";

/** One worker process (one project directory). */
export interface WorkerInfo {
  cwd: string;
  status: WorkerStatus;
  /** Why it crashed, or what it is doing. Written for a person to read. */
  message?: string;
  pid?: number;
  /** Crashes survived so far. Reset when the worker reaches `ready`. */
  restarts?: number;
  /** ISO time of this status change. */
  since?: string;
  /** ISO time an automatic restart is due, when one is scheduled. */
  retryAt?: string;
  /** True when `pi/worker/restart` would do something (a crashed or retired worker). */
  canRestart?: boolean;
  /** Session paths the host re-opened after an automatic restart. */
  reopened?: string[];
}

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
  /** ISO time the client last marked this session seen (`pi/session/seen`). */
  seenAt?: string;
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
  /**
   * `oversized` marks a result the transport could not carry whole (today: a
   * relayed frame has a hard ceiling). The transcript on disk still has it; the
   * client re-reads it with `pi/session/entries` when a person opens the row.
   */
  | { kind: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean; oversized?: boolean }
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

// ===========================================================================
// M4 · Settings, packages, providers and logs (lane B).
// Everything between this banner and the closing banner belongs to M4. Keep
// additions inside the block so concurrent lanes merge cleanly.
// ===========================================================================

/** Which of Pi's two settings files a value lives in. Mirrors Pi's `SettingsScope`. */
export type SettingsScope = "global" | "project";

/** One choice in an `enum` control. `value` is the literal JSON Pi stores. */
export interface SettingOption {
  value: string | number | boolean;
  label: string;
  hint?: string;
}

/**
 * How the UI should render one setting. The catalogue is generated in the
 * worker from the pinned Pi's `Settings` interface and `docs/settings.md`, so
 * a Pi upgrade that adds a key shows up as a missing-field test failure rather
 * than a silently unreachable setting.
 */
export type SettingControl =
  | { control: "boolean" }
  | { control: "text"; placeholder?: string; multiline?: boolean }
  | { control: "number"; min?: number; max?: number; step?: number; integer?: boolean; unit?: string }
  | { control: "enum"; options: SettingOption[] }
  /** Ordered list of free strings (paths, globs, argv). Arrays replace, never merge. */
  | { control: "string-list"; placeholder?: string; hint?: string }
  /** Map of free-text keys to one enum value, e.g. `modelThinkingLevels`. */
  | { control: "enum-map"; options: SettingOption[]; keyPlaceholder?: string }
  /** Anything whose shape is richer than a form row (`packages`). Edited as JSON. */
  | { control: "json"; hint?: string };

export interface SettingDescriptor {
  /** Dotted path into the settings document, e.g. `compaction.reserveTokens`. */
  path: string;
  /** Top-level key this field is persisted under. Pi tracks modified fields by it. */
  key: string;
  label: string;
  /** One sentence, from Pi's own docs. Rendered as text, never as HTML. */
  description: string;
  section: string;
  type: SettingControl;
  /** Pi's documented default, or absent when Pi has none. */
  default?: unknown;
  /** Scopes this key may be written at. Some keys are global-only in Pi. */
  scopes: SettingsScope[];
  /** Pi honours this only in its terminal UI; piorbit says so instead of hiding it. */
  terminalOnly?: boolean;
  /** Pi writes this itself (identifiers, changelog markers). Shown read-only. */
  managed?: boolean;
  /** Documented by Pi as advanced or JSON-only; collapsed by default. */
  advanced?: boolean;
}

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
}

export interface SettingsCatalog {
  /** Version of the Pi the worker is pinned to. */
  piVersion: string;
  sections: SettingsSection[];
  fields: SettingDescriptor[];
  /** Every top-level key of the pinned Pi's `Settings` interface. */
  topLevelKeys: string[];
}

export interface SettingsFileState {
  path: string;
  exists: boolean;
  /** The file as Pi loaded it. Empty when it does not exist or failed to parse. */
  values: Record<string, unknown>;
  /** Set when the file exists but could not be read or parsed. */
  error?: string;
}

/** Why project settings are (or are not) in play, in words a person can act on. */
export interface SettingsProjectTrust {
  trusted: boolean;
  /** True when piorbit may write `.pi/settings.json` for this directory. */
  writable: boolean;
  reason: string;
}

export interface SettingsSnapshot {
  cwd: string;
  agentDir: string;
  global: SettingsFileState;
  project: SettingsFileState;
  /** Global deep-merged with project (nested objects merge, arrays replace). */
  effective: Record<string, unknown>;
  projectTrust: SettingsProjectTrust;
}

/** One edit. `unset` removes the key so Pi's default applies again. */
export type SettingChange = { path: string; op: "set"; value: unknown } | { path: string; op: "unset" };

export type PackageScope = "user" | "project";

export interface PackageEntry {
  source: string;
  scope: PackageScope;
  /** The settings entry filters which resources load (object form), rather than loading all. */
  filtered: boolean;
  installedPath?: string;
  type?: "npm" | "git";
  /** Only set after `pi/packages/check_updates`. */
  updateAvailable?: boolean;
}

export interface PackageUpdateInfo {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: PackageScope;
}

/** Streamed from `DefaultPackageManager`'s progress callback while work runs. */
export interface PackageProgress {
  cwd: string;
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
}

export interface ProviderAuthInfo {
  id: string;
  name: string;
  baseUrl?: string;
  /** Pi can resolve a credential for this provider right now. */
  configured: boolean;
  /** Where the credential came from, as Pi reports it. */
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  /** Pi's own short description of the credential (e.g. a masked key or account). */
  label?: string;
  oauth: boolean;
  subscription: boolean;
  modelCount: number;
}

export interface ModelCatalogEntry extends ModelRef {
  /** Levels this model accepts. Pi maps unsupported levels to null in `thinkingLevelMap`. */
  thinkingLevels: ThinkingLevel[];
  /** Startup level for this model from `modelThinkingLevels`, when set. */
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  /** Selected by the `enabledModels` patterns (true for every model when unset). */
  enabled: boolean;
  /** Cost per million tokens, as Pi's catalogue reports it. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export type LogSection = "provider" | "tools" | "session" | "subagents" | "host";
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * A payload too large to inline. Fetch the body with `pi/logs/content`.
 * Content is addressed by hash, so the same provider request logged twice is
 * stored once.
 */
export interface LogContentRef {
  ref: string;
  bytes: number;
  contentType: "application/json" | "text/plain";
  /** Leading characters, already plain text, for the collapsed row. */
  preview: string;
}

export interface LogEntry {
  id: number;
  at: string;
  section: LogSection;
  /** `provider_request`, `provider_response`, `tool_start`, `session_update`, `worker_stderr`, … */
  kind: string;
  level: LogLevel;
  cwd?: string;
  sessionPath?: string;
  /** One line, plain text, safe to render without escaping decisions. */
  summary: string;
  durationMs?: number;
  /** HTTP status, for provider responses. */
  status?: number;
  /** Joins a request to its response, or a tool start to its end. */
  correlationId?: string;
  /** Inline when small; large payloads travel as `detailRef` instead. */
  detail?: unknown;
  detailRef?: LogContentRef;
}

export interface LogQuery {
  sections?: LogSection[];
  cwd?: string;
  sessionPath?: string;
  /** Case-insensitive substring over `summary`, `kind` and the detail preview. */
  search?: string;
  levels?: LogLevel[];
  /** Rows newer than this id (live tail). */
  afterId?: number;
  /** Rows older than this id (paging back). */
  beforeId?: number;
  limit?: number;
  /** Stop filling the page past this many bytes of JSON. */
  byteBudget?: number;
}

export interface LogPage {
  /** Oldest first. */
  entries: LogEntry[];
  /** The limit or the byte budget cut the page short; page again. */
  hasMore: boolean;
  oldestId?: number;
  newestId?: number;
  approxBytes: number;
}

export interface LogStats {
  total: number;
  bySection: Record<LogSection, number>;
  oldestAt?: string;
  newestAt?: string;
  /** Size of the store's database file. */
  bytes: number;
  retention: { maxRows: number; maxAgeDays: number };
  /**
   * Pi 0.85 gives extensions the complete provider REQUEST but only the
   * response's status and headers — there is no raw-body hook. The assistant
   * message is reconstructed from session events instead. The UI states this
   * rather than implying a body was lost.
   */
  providerResponseBodies: "unavailable";
}

// ===========================================================================
// end M4 block
// ===========================================================================

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
  /**
   * Sessions that want a person, attention-sorted (waiting > error >
   * finished-unread > working > idle), then most recently modified. Across all
   * projects unless `cwd` narrows it.
   */
  "pi/session/inbox": { params: { cwd?: string; limit?: number }; result: { sessions: SessionSummary[] } };
  /**
   * Mark a session read up to `seq` (omit for "everything so far"). Clears
   * `finished_unread`; the host persists it so a reload does not resurrect it.
   */
  "pi/session/seen": { params: { path: string; seq?: number }; result: { attention: SessionAttention } };
  /**
   * The client is no longer showing this session. Purely a lifecycle hint: the
   * host stops counting the session as attached, so its worker becomes eligible
   * for idle retirement again. Detaching never closes the session, never stops
   * a running turn, and is safe to send for a path the client never loaded.
   */
  "pi/session/detach": { params: { path: string }; result: {} };
  /**
   * `steer` and `follow_up` are **not** `session/prompt` under another name,
   * and neither should be folded into the other:
   *   `session/prompt`  starts a turn, and answers whether it was accepted or
   *                     queued. `streamingBehavior` only says what to do if a
   *                     turn happens to be running.
   *   `pi/session/steer`      interrupts the running turn with new instructions.
   *   `pi/session/follow_up`  queues for after the running turn.
   * The last two address a turn that is already in flight, so they have nothing
   * to accept or queue and answer `{}`. They fail if nothing is running.
   */
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
  /**
   * Answer an extension dialog. `delivered` is false when no worker still holds
   * that dialog id — the session restarted, or the question timed out — so the
   * UI can say so instead of closing the dialog on an answer that went nowhere.
   */
  "pi/ui/response": { params: UiDialogResponse; result: { delivered: boolean } };

  // --- projects (M2-T4). Server-side, so the CLI and the UI see one list. ---
  "pi/project/list": { params: {}; result: { projects: ProjectInfo[] } };
  "pi/project/add": { params: { cwd: string }; result: { project: ProjectInfo } };
  /** Forgets the project (and its trust decision). Session files are never touched. */
  "pi/project/remove": { params: { cwd: string }; result: {} };
  /** Answer to `pi/project/trust_request`; also usable to change a decision later. */
  "pi/project/trust": {
    params: { cwd: string; trusted: boolean; remember?: boolean };
    result: { project: ProjectInfo };
  };

  // --- workers (M2-T1) ---
  "pi/worker/list": { params: {}; result: { workers: WorkerInfo[] } };
  /** Start a worker now: retry after a crash, or wake a retired one. */
  "pi/worker/restart": { params: { cwd: string }; result: { worker: WorkerInfo } };
  /** Retire a worker on purpose. Refused while one of its sessions is running. */
  "pi/worker/stop": { params: { cwd: string }; result: {} };

  // ------------------------------------------------------------------ M4 --
  // Settings, packages, providers and logs. `cwd` picks the worker (settings
  // and packages are per project); the log store lives in the host.

  /** The schema of every Pi setting. Static per pinned Pi version; cache it. */
  "pi/settings/list": { params: { cwd: string }; result: { catalog: SettingsCatalog } };
  /** Both files plus the effective merge, and why project settings are or are not writable. */
  "pi/settings/get": { params: { cwd: string }; result: { snapshot: SettingsSnapshot } };
  /**
   * Write `changes` to one scope through Pi's `SettingsManager` lock, then
   * reload it so a running session sees them. Only the paths named are
   * touched; everything else in the file is preserved.
   */
  "pi/settings/set": {
    params: { cwd: string; scope: SettingsScope; changes: SettingChange[] };
    result: { snapshot: SettingsSnapshot };
  };

  "pi/packages/list": { params: { cwd: string }; result: { packages: PackageEntry[] } };
  /** Installs and adds the source to settings at `scope`. Progress arrives as `pi/packages/progress`. */
  "pi/packages/install": {
    params: { cwd: string; source: string; scope: PackageScope };
    result: { packages: PackageEntry[] };
  };
  "pi/packages/remove": {
    params: { cwd: string; source: string; scope: PackageScope };
    result: { packages: PackageEntry[]; removed: boolean };
  };
  /** Updates one source, or every configured source when `source` is omitted. */
  "pi/packages/update": { params: { cwd: string; source?: string }; result: { packages: PackageEntry[] } };
  /** Network check; may be slow. Returns the sources with a newer version available. */
  "pi/packages/check_updates": { params: { cwd: string }; result: { updates: PackageUpdateInfo[] } };

  /** Auth status per provider, straight from Pi's `ModelRuntime`. No secrets cross this boundary. */
  "pi/providers/list": { params: { cwd: string }; result: { providers: ProviderAuthInfo[]; error?: string } };
  /** The full model catalogue with per-model thinking levels. `refresh` re-fetches dynamic catalogues. */
  "pi/models/catalog": {
    params: { cwd: string; refresh?: boolean };
    result: {
      models: ModelCatalogEntry[];
      /** `enabledModels` patterns, or null when unset (every model is enabled). */
      enabledPatterns: string[] | null;
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: ThinkingLevel;
      refreshedAt: string;
      /** Per-provider refresh failures; the catalogue is still returned. */
      errors: string[];
    };
  };

  /** Paged read of the host log store, oldest first, bounded by a byte budget. */
  "pi/logs/query": { params: LogQuery; result: LogPage };
  /** Fetch a payload referenced by `LogEntry.detailRef`. */
  "pi/logs/content": {
    params: { ref: string; maxBytes?: number };
    result: { ref: string; contentType: string; bytes: number; truncated: boolean; text: string };
  };
  "pi/logs/stats": { params: {}; result: { stats: LogStats } };
  /** Delete rows. Omit `sections` to clear everything. */
  "pi/logs/clear": { params: { sections?: LogSection[] }; result: { deleted: number } };
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
  /**
   * Worker lifecycle. The worker itself sends `ready` and `retired`; the host's
   * pool sends `starting`, `crashed`, and re-sends the others enriched with
   * pid/restart bookkeeping.
   */
  "pi/worker/status": WorkerInfo;
  /** One session's attention changed (M2-T2). Cheaper than re-listing the catalog. */
  "pi/session/attention": { path: string; cwd: string; attention: SessionAttention; at: string };
  /** The project set or a trust decision changed. Carries the whole list; it is small. */
  "pi/project/updated": { projects: ProjectInfo[] };
  /**
   * A project with trust-gated resources is being opened and nobody has decided.
   * The host is holding the worker start until a client answers `pi/project/trust`
   * (or the request times out, which declines for this run).
   */
  "pi/project/trust_request": { id: string; cwd: string; reasons: string[]; timeoutMs: number };
  /** The request above was settled (by any client, or by the timeout). */
  "pi/project/trust_resolved": { id: string; cwd: string; trusted: boolean };

  // ------------------------------------------------------------------ M4 --
  /** `DefaultPackageManager` progress, forwarded while an install/remove/update runs. */
  "pi/packages/progress": PackageProgress;
  /** New rows in the log store, for live follow. Batched per host tick. */
  "pi/logs/append": { entries: LogEntry[] };
}

export type ClientMethod = keyof ClientRequests;
export type HostRequestMethod = keyof HostRequests;
export type HostNotificationMethod = keyof HostNotifications;
