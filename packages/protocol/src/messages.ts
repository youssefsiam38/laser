/**
 * Message vocabulary. ACP-shaped core (session/new, session/load,
 * session/prompt, session/cancel, session/request_permission) plus `pi/*`
 * extras. Draft for M0-T2: zod schemas and runtime validation are still to be
 * written; keep the TypeScript types and the schemas in one place when you do.
 *
 * Every host → client update carries a per-session monotonically increasing
 * `seq`. Clients resume with `session/load { fromSeq }`.
 */

import type { AgentWorktreeStatus, SessionAgentInfo, SessionWorktreeDisposition } from "./agents.js";
import type { ProviderFailureClass } from "./provider-failure.js";
import { WIRE_NAMESPACE } from "./identity.js";
import type { HostEnvironmentParams } from "./environment.js";
import type { ProjectEnvStatus } from "./project-env.js";
import type { AccountUsageState, PiExtensionMessage, PiExtensionModuleName } from "./pi-extension.js";
import type { FeatureScope, FeatureState, GoalAction, SessionGoal } from "./features.js";
import type { PushConfig, PushDeviceInfo, PushSubscriptionJson } from "./push.js";
// Type-only, and erased: `pending.ts` augments the interfaces below, so the
// cycle exists in the type graph and never in the emitted modules.
import type { PendingMessage } from "./pending.js";

// ---------- Shared value types (no Pi types allowed here) ----------

export type HistoryWindowRequest =
  | { tail: number }
  | { before: string; limit?: number }
  | { from: string }
  | { all: true };

/** Accepted, nonterminal work beside a persisted history snapshot. */
export interface HistoryLiveSnapshot {
  running: boolean;
  message?: { id: string; value: unknown; speaker?: MessageSpeaker };
  tools: { toolCallId: string; toolName: string; args: unknown; partial?: unknown }[];
}

export interface HistoryWindow {
  epoch: string;
  seq: number;
  before?: string;
  /** First loaded entry, retained when refreshing an expanded window. */
  anchor?: string;
  userOffset: number;
  /** All messages on the active branch are present (not necessarily other versions). */
  complete: boolean;
  /** Alternate branches exist outside this window's active-branch scope. */
  branchesUnloaded: boolean;
  /** Durable messages or goal records exist in any branch, even with a reset leaf. */
  hasHistory: boolean;
  context: unknown[];
  priorGoalIds: string[];
  live?: HistoryLiveSnapshot;
}

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

/**
 * Why an assistant message stopped, mirroring the pinned Pi's own `StopReason`
 * one-for-one so the driver never has to invent a vocabulary. `stop` is the
 * ordinary end of a reply and `toolUse` is "it wants to run tools next";
 * everything else is a turn that ended short and the UI says so out loud.
 */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/**
 * Who produced a message, when it was not the session's own agent speaking.
 * Absent means "this session's own voice", which is the common case: the
 * transcript shows no header for it.
 */
export interface MessageSpeaker {
  kind: "user" | "agent" | "subagent" | "tool";
  /** Display name: `@auth-audit`, `orchestrator`, a tool's name. */
  name: string;
  /** Model, handle or role, shown after the name. */
  detail?: string;
}

/** Attention state for the sidebar/inbox (M2-T2). */
export type SessionAttention = "idle" | "working" | "waiting_for_input" | "error" | "finished_unread";

/**
 * Whether Laser may apply a project's own `.laser` settings.
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

/**
 * Git state of a project directory, for the project line under the composer
 * (D-20 §7, M2-T6). `added`/`removed` are lines changed in the working tree
 * since the baseline the worker captured when the session opened — a
 * tracked-file diff plus the lines of files created since — not since HEAD.
 * `ahead`/`behind` are counted against the upstream branch, or the remote's
 * default branch when the current branch has never been pushed; both are 0
 * when neither exists. Everything but `isRepo` is meaningless when it is false.
 */
export interface ProjectGitStatus {
  isRepo: boolean;
  /** Branch name, or a short commit hash when HEAD is detached. */
  branch: string;
  ahead: number;
  behind: number;
  added: number;
  removed: number;
  /** Uncommitted changes exist (tracked modifications or untracked files). */
  dirty: boolean;
  /** `origin/main`-style ref `ahead`/`behind` were counted against, when one exists. */
  upstream?: string;
  /** URL of the remote the upstream lives on, for building a compare link. */
  remoteUrl?: string;
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
  /**
   * The session of the agent that started this one, from the agent record —
   * the one thing that nests a session under another. Never a fork's origin.
   */
  parentPath?: string;
  /**
   * The session this one was forked from (the engine's `parentSession`
   * header). Lineage only: a fork is a top-level session of its own, listed
   * beside its origin, never under it (M13-T65).
   */
  forkedFrom?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage?: string;
  attention?: SessionAttention;
  /** ISO time the client last marked this session seen (`pi/session/seen`). */
  seenAt?: string;
  /** Which agent runs this session and, for a child, whose child it is. */
  agent?: SessionAgentInfo;
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
  /**
   * Active reviewed engine modules at the moment this snapshot was produced.
   * Included in the request result because startup notifications can arrive
   * before a client has created its local session view.
   */
  capabilities?: PiExtensionModuleName[];
  /** Live, account-wide allowance for an account-authenticated provider. */
  accountUsage?: AccountUsageState;
  /** `tokens`/`percent` are null right after compaction, before the next response. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /** Which agent runs this session and, for a child, whose child it is. */
  agent?: SessionAgentInfo;
  /** The fallback chain this session activated, when one applies (M15-T3). */
  fallback?: SessionFallbackSummary;
}

/**
 * What a client needs to draw a session's chain: the snapshot it activated, the
 * model inside it that is active now, whether a switch is happening this very
 * moment, and the last one that happened.
 */
export interface SessionFallbackSummary {
  /** The activation's snapshot, resolved against the catalogue for display. */
  chain: ModelRef[];
  position: number;
  /** A failover event is in flight: the session is working, on no settled model. */
  switching?: boolean;
  lastSwitch?: { from: ModelRef; to: ModelRef; reason: ProviderFailureClass; at: string };
}

// ---------- Session updates (host → client notifications) ----------

/** Mirrors Pi SDK 0.85 AgentSessionEvent names so the driver mapping is 1:1. */
export type SessionUpdate =
  | { kind: "agent_start" }
  | { kind: "agent_end"; willRetry?: boolean }
  | { kind: "agent_settled" }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | {
      kind: "message_start";
      role: "user" | "assistant" | "tool" | "custom";
      messageId?: string;
      /** Set only when something other than this session's own agent is speaking. */
      speaker?: MessageSpeaker;
    }
  | { kind: "text_delta"; delta: string; contentIndex: number }
  | { kind: "thinking_delta"; delta: string; contentIndex: number }
  | { kind: "toolcall_delta"; delta: string; contentIndex: number }
  /**
   * A message was finalised. `message` is Pi's own entry, opaque by design;
   * the named fields beside it are the parts the UI must not have to guess at.
   * `stopReason` is what ended an assistant turn (a stopped run renders from
   * it) and `usage` is that one turn's token counts — not a running total.
   */
  | {
      kind: "message_end";
      message: unknown;
      role?: "user" | "assistant" | "tool" | "custom";
      speaker?: MessageSpeaker;
      stopReason?: StopReason;
      /** The provider's own words when `stopReason` is `error`. */
      errorMessage?: string;
      /** This turn's usage. Absent when the provider reported none. */
      usage?: Usage;
      /**
       * Where a user message landed in the session tree, known the moment the
       * engine writes it — before the provider request goes out, not when the
       * turn ends. `parentId` is the entry it continues (`null` at the root).
       * Absent for other roles, and for a user message never persisted.
       */
      entry?: { id: string; parentId: string | null };
    }
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
  /**
   * The session's pending tray, whole (`./pending.ts`). Laser's own, not the
   * engine's: it rides the same numbered stream as everything else so a
   * reconnecting client replays it in order and never renders a stale list.
   */
  | { kind: "pending_update"; pending: PendingMessage[] }
  | { kind: "compaction_start" }
  | { kind: "compaction_end"; ok: boolean }
  | { kind: "auto_retry_start"; attempt: number; maxAttempts: number }
  | { kind: "auto_retry_end"; ok: boolean }
  /**
   * A fallback chain moved this session to another model, or could not
   * (M15-T3, `docs/model-fallback-chains.md`). `detail` is a sentence for a
   * person; a provider's own payload never travels here.
   */
  | {
      kind: "model_fallback";
      phase: "switching" | "switched" | "attempt_failed" | "exhausted";
      from?: ModelRef;
      to?: ModelRef;
      reason: ProviderFailureClass;
      detail?: string;
      /** Index in the activation's chain snapshot after this update. */
      position: number;
    }
  /** Only for custom entries appended by extensions (pi.appendEntry); regular messages do not produce this. */
  | { kind: "entry_appended"; entry: unknown }
  | { kind: "state"; state: SessionState }
  | { kind: "extension_error"; extension: string; message: string };

export interface SessionUpdateParams {
  sessionPath: string;
  /** The serving generation, shared with windowed history snapshots. */
  epoch?: string;
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
  /** Pi honours this only in its terminal UI; laser says so instead of hiding it. */
  terminalOnly?: boolean;
  /** Pi writes this itself (identifiers, changelog markers). Shown read-only. */
  managed?: boolean;
  /** Documented by Pi as advanced or JSON-only; collapsed by default. */
  advanced?: boolean;
  /** Laser-owned placement. Internal and unsupported settings never become fields. */
  audience?: "general" | "advanced";
}

export interface SettingClassification {
  key: string;
  disposition: "general" | "advanced" | "internal" | "unsupported";
  reason: string;
}

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
}

export interface SettingsCatalog {
  /** Version of the internal engine adapter that defined this catalog. */
  engineVersion: string;
  sections: SettingsSection[];
  fields: SettingDescriptor[];
  /** Every top-level key of the pinned Pi's `Settings` interface. */
  topLevelKeys: string[];
  /** Exhaustive classification of the pinned engine schema. */
  classifications: SettingClassification[];
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
  /** True when Laser may write `.laser/settings.json` for this directory. */
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
  // --- M10-T5: filled in by the host's PackageService, which reads manifests and its own lock. ---
  /** The registry name for an npm source (`npm:@scope/name@1.2.3` → `@scope/name`). */
  name?: string;
  /** The version actually on disk, read from the installed manifest. */
  version?: string;
  /** The exact version the source pins (`npm:name@1.2.3`), when it pins one. */
  pinnedVersion?: string;
  /** Newest version the registry offers; only set after `pi/packages/check_updates`. */
  latestVersion?: string;
  /** Subresource integrity of the tarball this install was recorded with. */
  integrity?: string;
}

export interface PackageUpdateInfo {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: PackageScope;
  /** For npm sources: what is on disk and what the registry has now. */
  installedVersion?: string;
  latestVersion?: string;
}

/**
 * A package the person can install from Settings (M10-T5): a row of
 * laser's curated list, or a hit from a live registry search. Metadata
 * only; installing pins `version` and verifies the download.
 */
export interface PackageCatalogEntry {
  /** The registry name. Doubles as the install source (`npm:<name>@<version>`). */
  name: string;
  description?: string;
  /** Newest exact version on the registry. Installing pins it. Absent while the registry has not answered. */
  version?: string;
  homepage?: string;
  publishedAt?: string;
  keywords?: string[];
  /** From laser's own list rather than a live search. */
  curated: boolean;
  /** Set when a configured package already provides this name. */
  installed?: { source: string; scope: PackageScope; version?: string };
}

/** Whether this machine can install packages at all, and with what (M10-T5). */
export interface PackageRuntimeInfo {
  ready: boolean;
  node: { version: string; path: string };
  npm?: { path: string; source: "bundled" | "configured" | "path" };
  /** Why installs cannot run, written for a person. Only set when `ready` is false. */
  reason?: string;
}

/**
 * One line of laser's package lock: what was installed, at which exact
 * version, with which tarball integrity. Enough to reproduce the same set
 * and to notice when the registry hands back different bytes for the same
 * version.
 */
export interface PackageRecord {
  name: string;
  version: string;
  scope: PackageScope;
  /** Only for project scope: the directory the package was installed for. */
  cwd?: string;
  /** `sha512-…` from the registry manifest at install time. */
  integrity?: string;
  /** Tarball URL the version resolved to. */
  resolved?: string;
  /** The source string as written to settings, e.g. `npm:pi-web-access@1.4.2`. */
  source: string;
  installedAt: string;
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
  /** Sign-in methods this provider supports from the UI (M10-T6). Absent when the worker predates it. */
  methods?: ProviderLoginMethod[];
  /** The provider's own wording for its account sign-in, e.g. "Sign in with SuperGrok or X Premium". */
  oauthLabel?: string;
}

// --- M10-T6: signing in to a provider from the UI ---------------------------

export type ProviderLoginMethod = "oauth" | "api_key";

/** A question the provider's login flow asks; answered with `pi/providers/login/answer`. */
export interface ProviderLoginPrompt {
  id: string;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  /** Only for `select`. The answer is an option `id`. */
  options?: Array<{ id: string; label: string; description?: string }>;
}

/**
 * What a login flow tells the person while it runs. Mirrors the agent's own
 * login callbacks one for one, so a provider that adds a step is not silently
 * unsupported; the terminal states are `done`, `error` and `cancelled`.
 */
export type ProviderLoginEvent =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string }
  | { type: "prompt"; prompt: ProviderLoginPrompt }
  | { type: "done"; method: ProviderLoginMethod }
  | { type: "error"; message: string }
  | { type: "cancelled" };

// --- M10-T6: first run --------------------------------------------------------

/**
 * Where first-run setup stands, kept by the host so it survives a quit and is
 * the same on every device. `cwd` is a directory the host owns with no project
 * in it: provider and model settings are global, but every settings method is
 * routed by directory, and this is the one to use before any project exists.
 */
export interface SetupState {
  cwd: string;
  completed: boolean;
  completedAt?: string;
}

/** One directory in a `pi/project/browse` listing. */
export interface DirectoryEntry {
  name: string;
  path: string;
  /** Looks like a code project (has `.git`, `.pi`, or a manifest). Display hint only. */
  project: boolean;
}

export interface DirectoryListing {
  path: string;
  /** Absent at the filesystem root. */
  parent?: string;
  home: string;
  entries: DirectoryEntry[];
  truncated: boolean;
  /** Set when the directory could not be read; `entries` is then empty. */
  error?: string;
}

export interface ModelCatalogEntry extends ModelRef {
  /** Levels this model accepts. Pi maps unsupported levels to null in `thinkingLevelMap`. */
  thinkingLevels: ThinkingLevel[];
  /** Startup level for this model from `modelThinkingLevels`, when set. */
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  /**
   * Offered by the pickers: selected by the `enabledModels` patterns (every
   * model when unset) and not switched off in `disabledModels` (M13-T49).
   */
  enabled: boolean;
  /** The `enabledModels` allow-list leaves it out, whatever the switch says. Absent from older hosts. */
  hiddenByList?: boolean;
  /** Switched off by a person in Providers and models (`disabledModels`). Absent from older hosts. */
  switchedOff?: boolean;
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
  requestContext?: import("./pi-extension.js").ProviderRequestContext;
  /** Inline when small; large payloads travel as `detailRef` instead. */
  detail?: unknown;
  detailRef?: LogContentRef;
}

export interface LogQuery {
  kind?: string;
  promptEntryId?: string;
  /** Inclusive lower / exclusive upper timestamp bound for legacy captures. */
  afterAt?: string;
  beforeAt?: string;
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

// ===========================================================================
// M11 · Host-owned preferences (`pi/prefs/*`).
//
// Pi's settings file belongs to Pi: `pi/settings/set` refuses any key the
// pinned agent does not define, and it is right to. laser's own preferences
// — the theme first among them — therefore need a store of their own, keyed by
// namespace, persisted beside the host's other state and never inside the
// agent's settings. Because it lives in the host and not in a browser, a theme
// chosen on the desktop is the theme a paired phone opens with.
// ===========================================================================

/**
 * One namespace of host-owned preferences. The value is whatever JSON the
 * owning feature stores there; the host never interprets it, it only keeps it
 * and tells every connected client when it changes.
 */
export interface PrefsEntry {
  namespace: string;
  /** `null` means the namespace has been cleared, which is not the same as never set. */
  value: unknown;
  /** Bumped on every accepted write, across all namespaces. Use it to ignore your own echo. */
  revision: number;
  at: string;
}

/** Largest single namespace, serialised. A preference is small by definition. */
export const PREFS_MAX_BYTES = 256 * 1024;

// ===========================================================================
// M4-T7 · Keybindings (`pi/keybindings/*`), over the agent's own manager.
// ===========================================================================

/**
 * One action the agent can be told to bind. `id` is the agent's own binding id
 * (`app.interrupt`, `tui.editor.undo`); `keys` is what is in force right now,
 * which is the person's override when there is one and the default otherwise.
 */
export interface KeybindingDescriptor {
  id: string;
  description: string;
  /** What the pinned agent ships. Resetting restores exactly this. */
  defaultKeys: string[];
  keys: string[];
  /** The person's file sets this one, so "Reset" has something to do. */
  overridden: boolean;
  /**
   * `app` is the agent's own actions, `tui` its editor and list keys. Sections
   * are derived from the id's first segment, so a new one shows up as itself
   * rather than disappearing.
   */
  section: string;
}

/** Two actions that answer to the same key. The agent resolves them in id order. */
export interface KeybindingConflict {
  key: string;
  ids: string[];
}

export interface KeybindingsSnapshot {
  /** The file the agent reads them from. Shown so a person can find it. */
  path: string;
  /** Version of the agent the ids and defaults came from. */
  engineVersion: string;
  bindings: KeybindingDescriptor[];
  conflicts: KeybindingConflict[];
  /** False when laser will not write the file; `reason` says why, for a person. */
  writable: boolean;
  reason?: string;
  /** Set when the file exists but could not be read; the defaults are shown instead. */
  error?: string;
}

/** One rebinding. `reset` removes the override so the agent's default applies again. */
export type KeybindingChange = { id: string; op: "set"; keys: string[] } | { id: string; op: "reset" };

// ===========================================================================
// Composer sources: `/` commands, `@` files, and the prompt library.
// ===========================================================================

/**
 * Something `/` can run. `source` says where it came from so the popover can
 * group it: `laser` is the app's own, `feature` a built-in capability's
 * command, `prompt` a prompt template, `skill` a skill file.
 */
export interface CommandInfo {
  /** What a person types after the slash, without the slash. */
  name: string;
  description?: string;
  source: typeof WIRE_NAMESPACE | "feature" | "prompt" | "skill";
  /** e.g. `<provider/model>`; shown after the name, never sent. */
  argumentHint?: string;
  /** Product feature or project source, for the row's second line. */
  origin?: string;
  /** Source Markdown for a loaded skill or prompt; never an executable command. */
  filePath?: string;
}

/** A prompt template the agent loaded from disk (the prompt library). */
export interface PromptInfo {
  name: string;
  description: string;
  argumentHint?: string;
  /** Absolute path of the markdown file, so a person can find and edit it. */
  filePath: string;
  /** Where it came from: `global`, `project`, or a package's name. */
  origin: string;
  /** First lines of the template, for the row's preview. Never the whole file. */
  preview: string;
}

/** One file in the project, for the composer's `@` popover. */
export interface ProjectFile {
  /** Posix-separated, relative to the project directory. */
  path: string;
  /** Last segment, for the row's title. */
  name: string;
  /** Tracked by git in this project. */
  tracked: boolean;
}

/**
 * A machine file read for display: the viewer behind a file card in the
 * transcript. Never executed; relative requests resolve against the project.
 */
export interface ProjectFileContent {
  /** Resolved target: project-relative (POSIX-separated) inside, absolute outside. */
  path: string;
  /** Last segment, for the title. */
  name: string;
  /** From the extension; `application/octet-stream` when unknown. */
  mediaType: string;
  /** Bytes on disk. */
  size: number;
  modifiedAt: string;
  /** `base64` for an image, `utf8` for everything readable as text. */
  encoding: "utf8" | "base64";
  content: string;
  /** `content` stops before `size`; the viewer says so and offers to open it natively. */
  truncated: boolean;
}

export interface ProjectFiles {
  cwd: string;
  files: ProjectFile[];
  /** More matched than `limit`; narrow the query. */
  truncated: boolean;
  /**
   * How the list was produced: `git` respects `.gitignore` exactly, `walk` is
   * a bounded directory scan for a project that is not a repository. The UI
   * says which when it matters.
   */
  source: "git" | "walk";
}

// ---------- Method catalogue ----------

/** Client → host requests. */
export interface ClientRequests {
  /** Read-only release handshake; complete before hydrating or sending work. */
  "pi/host/version": { params: {}; result: { version: string } };
  /** Local non-browser launchers only. Never persisted or sent to frontends. */
  "pi/host/environment": { params: HostEnvironmentParams; result: { applied: number } };
  /** `agentName` picks a definition; omitted means the default agent. */
  "session/new": { params: { cwd: string; parentPath?: string; agentName?: string }; result: { state: SessionState } };
  /**
   * `replayFrom` is the earliest seq this reply actually covers; `seq` is the
   * worker's current watermark for the session at the moment it answered.
   *
   * A client that hydrates from `pi/session/entries` must stamp its view with
   * `seq`, not with 0: "I have received no live update" and "I hold nothing"
   * are different states, and conflating them makes the next `session/load`
   * ask for `fromSeq: 0` and receive the whole buffer a second time.
   */
  /** `transcript: "loaded"` opts this connection into updates only for sessions
   * it loads/creates/forks. Admission starts before replay. Loaded caches remain
   * subscribed until disconnect, independently of retirement detach; questions,
   * attention and other small notifications remain global. Omit for full stream. */
  "session/load": { params: { path: string; fromSeq?: number; transcript?: "loaded" }; result: { state: SessionState; replayFrom: number; seq: number } };
  "session/prompt": {
    params: {
      path: string;
      content: ContentBlock[];
      streamingBehavior?: "steer" | "followUp";
      /**
       * Applied only while this exact root session is still pristine. `model`
       * is intent, not merely a value: absent preserves a prior explicit
       * session override, `null` follows the selected agent (and therefore the
       * project default when that agent has no model), and a ref is a later
       * explicit composer choice.
       */
      firstTurn?: { agentName: string; model?: ModelRef | null; thinkingLevel?: ThinkingLevel };
    };
    result: { accepted: boolean; queued: boolean };
  };
  "session/cancel": { params: { path: string }; result: {} };
  "session/set_mode": { params: { path: string; mode: string }; result: {} };

  "pi/session/list": {
    params: { cwd?: string; page?: { cursor?: string; size?: number; sizes?: Record<string, number>; exclude?: string[]; include?: string[]; probe?: string[] } };
    result: { sessions: SessionSummary[]; groups?: Array<{ cwd: string; total: number; cursor?: string }>; archivedCount?: number; presence?: Record<string, boolean> };
  };
  /** Read-only search of saved conversations; no worker is opened. */
  "session/search": {
    params: { query: string; cwd?: string; after?: string; before?: string; cursor?: number; searchId?: string };
    result: { hits: Array<{ path: string; count: number; excerpt: string; source: "user" | "assistant" | "reasoning" | "tool" }>; nextCursor?: number; unreadable: number };
  };
  /** Cancel only this connection's named saved-history read; never an agent turn. */
  "session/search/cancel": { params: { searchId: string }; result: {} };
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
   * Move a saved session into a project (M13-T58). The host does it while no
   * worker holds the file: the transcript keeps its history, its name and its
   * id; only where it lives changes. Its header names `cwd`, its agent record
   * becomes the default agent's, and the file moves into that project's
   * session directory. `path` in the result is where it lives now — the old
   * path is gone and is not served. Refused, with a reason a person can act
   * on, while a turn is streaming or an agent run of the session is live, for
   * a child session (its parent's tree is one thing), and when `cwd` is not a
   * directory or is one of the built-in workspaces.
   */
  "pi/session/move": { params: { path: string; cwd: string }; result: { path: string } };
  /**
   * Host → worker only: let go of one session so its file has no writer. The
   * host sends it before moving the session's file; a client cannot, because
   * closing a session under another viewer is not anyone's to do. `closed` is
   * false when the worker did not hold it. Refused while a turn is streaming.
   */
  "pi/session/close": { params: { path: string }; result: { closed: boolean } };
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
  /**
   * Forks before `entryId` into a new session; `editorText` carries that
   * entry's text back for editing and resending. The engine will not move a
   * leaf while a turn streams, so `stopFirst` asks the worker to stop the
   * running turn first — the same stop the Stop button makes, recorded on the
   * branch being left as `stopReason: "aborted"` — and only then fork. One
   * request, so a fork that fails leaves the session stopped and untouched
   * rather than half-moved (M13-T46). Idle sessions ignore it.
   */
  "pi/session/fork": { params: { path: string; entryId: string; stopFirst?: boolean }; result: { state: SessionState; editorText?: string } };
  /** `stopFirst` as on `pi/session/fork`: stop the running turn, then move. */
  "pi/session/navigate": {
    params: { path: string; entryId: string; summarize?: boolean; label?: string; stopFirst?: boolean };
    result: { editorText?: string; cancelled: boolean };
  };
  "pi/session/rename": { params: { path: string; name: string }; result: {} };
  /**
   * Permanently remove a closed persisted transcript.
   *
   * `worktree` says what happens to a child agent's checkout when the session
   * being deleted has one. **Omitting it keeps the worktree** (M13-T42): the
   * caller has to ask for a directory of work to be destroyed, because losing
   * a child's commits to a missing field is the one failure this whole
   * lifecycle exists to prevent. A session with no worktree ignores it.
   */
  "pi/session/delete": { params: { path: string; worktree?: SessionWorktreeDisposition }; result: { worktree?: AgentWorktreeStatus } };
  /**
   * Persisted Pi session entries (opaque; see Pi's session-format.md) for
   * transcript hydration. The file is an append-only *tree*, so `entries` is
   * every branch, not the conversation on screen: `leafId` is the entry the
   * session is currently sitting on, and the live conversation is the path
   * from the root to it. `null` means the leaf was reset to before the first
   * entry (editing the opening message); `undefined` means this answer did
   * not carry one — read the last entry as the leaf, which is what the engine
   * itself does when it re-opens a file.
   */
  "pi/session/entries": { params: { path: string; window?: HistoryWindowRequest }; result: { entries: unknown[]; leafId?: string | null; window?: HistoryWindow } };
  "pi/session/compact": { params: { path: string; instructions?: string }; result: {} };
  "pi/model/list": { params: { path: string }; result: { models: ModelRef[] } };
  "pi/model/set": { params: { path: string; model: ModelRef }; result: { state: SessionState } };
  "pi/thinking/set": { params: { path: string; level: ThinkingLevel }; result: { state: SessionState } };
  /** Ask the active account-usage module for a fresh server snapshot. */
  "pi/account-usage/refresh": { params: { path: string }; result: { delivered: boolean } };
  /**
   * Answer an extension dialog. `delivered` is false when no worker still holds
   * that dialog id — the session restarted, or the question timed out — so the
   * UI can say so instead of closing the dialog on an answer that went nowhere.
   */
  "pi/ui/response": { params: UiDialogResponse; result: { delivered: boolean } };

  // --- projects (M2-T4). Server-side, so the CLI and the UI see one list. ---
  "pi/project/list": { params: {}; result: { projects: ProjectInfo[] } };
  "pi/project/add": { params: { cwd: string }; result: { project: ProjectInfo } };
  /** Saves project priority. Omitted known projects retain their relative order after these entries. */
  "pi/project/reorder": { params: { cwds: string[] }; result: { projects: ProjectInfo[] } };
  /** Forgets the project (and its trust decision). Session files are never touched. */
  "pi/project/remove": { params: { cwd: string }; result: {} };
  /** Answer to `pi/project/trust_request`; also usable to change a decision later. */
  "pi/project/trust": {
    params: { cwd: string; trusted: boolean; remember?: boolean };
    result: { project: ProjectInfo };
  };
  /**
   * Git state of a project, answered by that project's worker (which runs
   * `git` in `cwd` with a short cache). `path` names the open session whose
   * open-time baseline `added`/`removed` are counted from; without it the
   * worker uses the baseline of the first session it opened.
   */
  "pi/project/git": { params: { cwd: string; path?: string }; result: ProjectGitStatus };
  /**
   * Subdirectories of `path` (the home directory when omitted), for picking a
   * project without typing a path (M10-T6). Directories only, hidden ones
   * excluded. Answered by the host.
   */
  "pi/project/browse": { params: { path?: string }; result: DirectoryListing };
  /**
   * The project's environment command (M16-T17, docs/project-environment.md).
   * Status carries variable **names** only; a value never crosses the protocol.
   */
  "pi/project/env/status": { params: { cwd: string }; result: { status: ProjectEnvStatus } };
  /**
   * Configure it. Saving through this method is the approval: the person chose
   * the executable, so the fingerprint of `{command, args}` is recorded here.
   */
  "pi/project/env/set": {
    params: {
      cwd: string;
      config: {
        enabled: boolean;
        command: string;
        args?: string[];
        required?: boolean;
        allowProviderKeys?: string[];
      } | null;
    };
    result: { status: ProjectEnvStatus };
  };
  /** Run it once without applying anything: names and counts, never values. */
  "pi/project/env/test": { params: { cwd: string }; result: { status: ProjectEnvStatus } };
  /** Re-resolve for subsequent commands. Running commands keep their environment. */
  "pi/project/env/refresh": { params: { cwd: string }; result: { status: ProjectEnvStatus } };

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

  /** Laser-owned capabilities. Implementations and package sources are deliberately absent. */
  "feature/list": { params: { cwd?: string }; result: { features: FeatureState[] } };
  "feature/set": {
    /** `null` clears a project override and follows the global choice again. */
    params: { id: string; enabled: boolean | null; scope: FeatureScope; cwd?: string };
    result: { features: FeatureState[]; restartPending: boolean };
  };

  /** One durable objective belongs to one session. */
  "session/goal/get": { params: { path: string }; result: { goal: SessionGoal | null } };
  "session/goal/action": { params: { path: string; action: GoalAction }; result: { goal: SessionGoal | null } };

  "pi/packages/list": { params: { cwd: string }; result: { packages: PackageEntry[] } };
  /** Installs and adds the source to settings at `scope`. Progress arrives as `pi/packages/progress`. */
  "pi/packages/install": {
    /**
     * `version` pins an exact release of an npm source; without it the host
     * resolves the newest and pins that. Either way the source written to
     * settings carries the exact version (M10-T5).
     */
    params: { cwd: string; source: string; scope: PackageScope; version?: string };
    result: { packages: PackageEntry[]; record?: PackageRecord };
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
      /**
       * Canonical `provider/id` references a person switched off in Providers
       * and models — the product's own `disabledModels` list, applied after the
       * allow-list. Empty when nothing is switched off; absent from older hosts.
       */
      disabledModels?: string[];
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: ThinkingLevel;
      refreshedAt: string;
      /** Per-provider refresh failures; the catalogue is still returned. */
      errors: string[];
    };
  };

  // ------------------------------------------------------------- M10-T5 --
  // Package management from Settings. Answered by the host's PackageService,
  // which resolves and pins versions and keeps the lock; the worker does the
  // installing through the agent's own package manager.

  /**
   * Packages a person can install: laser's curated list when `query` is
   * empty, a live registry search otherwise. With `cwd`, entries that are
   * already configured for that project say so.
   */
  "pi/packages/catalog": {
    params: { cwd?: string; query?: string; limit?: number };
    result: { entries: PackageCatalogEntry[]; source: "curated" | "search"; truncated: boolean; error?: string };
  };
  /** Can this machine install packages, and with what. Diagnostics; paths appear here and nowhere else. */
  "pi/packages/runtime": { params: {}; result: PackageRuntimeInfo };
  /** The lock: every install the host recorded. `cwd` limits project-scope records to one project. */
  "pi/packages/records": { params: { cwd?: string }; result: { records: PackageRecord[] } };

  // ------------------------------------------------------------- M10-T6 --
  // Provider sign-in from the UI. The worker drives the agent's own login
  // flow; every step reaches the person as a `pi/providers/login/event`.

  /** Begin signing in. Events for `id` follow; `answer` replies to prompts. */
  "pi/providers/login/start": {
    params: { cwd: string; provider: string; method: ProviderLoginMethod };
    result: { id: string };
  };
  "pi/providers/login/answer": { params: { cwd: string; id: string; promptId: string; value: string }; result: {} };
  "pi/providers/login/cancel": { params: { cwd: string; id: string }; result: {} };
  /** Forget the stored credential for a provider. */
  "pi/providers/logout": { params: { cwd: string; provider: string }; result: { providers: ProviderAuthInfo[] } };

  /** First-run setup state, kept by the host. */
  "pi/setup/state": { params: {}; result: SetupState };
  "pi/setup/complete": { params: { completed: boolean }; result: SetupState };

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

  // ---------------------------------------------------- M11 · preferences --
  // Answered by the host, not a worker: these are laser's own, they are not
  // per project, and they must survive a worker that is asleep.

  /** Every namespace, or one when `namespace` names it. */
  "pi/prefs/get": { params: { namespace?: string }; result: { entries: PrefsEntry[]; revision: number } };
  /**
   * Replace one namespace. `value: null` clears it. The write is broadcast to
   * every connected client as `pi/prefs/updated`, including the one that sent
   * it — compare `revision` with the one you got back to ignore your own echo.
   */
  "pi/prefs/set": { params: { namespace: string; value: unknown }; result: { entry: PrefsEntry } };

  // ---------------------------------------------------- M4-T7 · keybindings --
  // The agent's own `keybindings.json`, read and written through its
  // `KeybindingsManager`. `cwd` only picks the worker; the file is global.

  "pi/keybindings/get": { params: { cwd: string }; result: { keybindings: KeybindingsSnapshot } };
  /** Apply `changes` and answer with the file as it now stands. */
  "pi/keybindings/set": {
    params: { cwd: string; changes: KeybindingChange[] };
    result: { keybindings: KeybindingsSnapshot };
  };

  // -------------------------------------------------- composer sources --
  /** Everything `/` can run in a session, or in a project before its first session exists. */
  "pi/commands/list": {
    params: { path: string } | { cwd: string };
    result: { commands: CommandInfo[] };
  };
  /** The prompt library the agent loaded for this session. */
  "pi/prompts/list": { params: { path: string }; result: { prompts: PromptInfo[] } };
  /**
   * Files in a project, for `@`. `query` is a case-insensitive subsequence
   * match over the relative path; omit it for the first `limit` files.
   */
  "pi/project/files": { params: { cwd: string; query?: string; limit?: number }; result: ProjectFiles };
  /**
   * Read one file of the project for the viewer (M15-T1). `path` is relative
   * to `cwd` or absolute; either way it must resolve inside the project (no
   * traversal, symlinks resolved), or the request is refused. Text is capped
   * at 2 MiB and images at 12 MiB; beyond that `truncated` is set.
   */
  "pi/project/read": { params: { cwd: string; path: string }; result: ProjectFileContent };

  // --- M7 · push. Answered by the host itself; the phone is the only caller. ---

  /** Can this host send notifications, and with which application server key. */
  "pi/push/config": { params: {}; result: PushConfig };
  /** Upsert by `endpoint`. Idempotent: pages re-send their subscription on every start. */
  "pi/push/subscribe": {
    params: { subscription: PushSubscriptionJson; device: PushDeviceInfo };
    result: { id: string };
  };
  "pi/push/unsubscribe": { params: { endpoint: string }; result: {} };
  /** Send a test notification to one endpoint, so a person can watch it arrive. */
  "pi/push/test": { params: { endpoint: string }; result: { delivered: boolean; error?: string } };

  // --- M8 · dictation. The browser owns the microphone; the worker transcribes. ---

  /** Can this project dictate, and if not, why — in words for a person. */
  "pi/transcribe/status": { params: { cwd: string }; result: TranscribeStatus };
  /**
   * Open an upload. `path` binds the recording to a session so a phrase still
   * in flight when Enter is pressed reaches that prompt; `cwd` alone still
   * works but cannot hold a prompt open.
   */
  "pi/transcribe/begin": {
    params: { cwd: string; mimeType: string; language?: string; path?: string };
    result: { id: string };
  };
  /** One base64 chunk, at most 32 KiB decoded, in order. Sized to fit a relayed frame. */
  "pi/transcribe/chunk": { params: { id: string; data: string }; result: {} };
  /** `text` is "" when the phrase was claimed by a prompt while still in flight. */
  "pi/transcribe/end": { params: { id: string }; result: { text: string } };
  "pi/transcribe/cancel": { params: { id: string }; result: {} };
}

/** Answer to `pi/transcribe/status`. */
export interface TranscribeStatus {
  available: boolean;
  /** Which backend answers, e.g. `pi-gpt-transcribe`. */
  provider?: string;
  /** Why `available` is false, in words a person can act on. */
  reason?: string;
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
  /**
   * `agent` says which agent the session belongs to when the host knows: a
   * child's news reaches its parent inside the conversation, so nothing
   * outside the window announces it — only a top-level session interrupts a
   * person (D-225).
   */
  "pi/session/attention": { path: string; cwd: string; attention: SessionAttention; at: string; agent?: SessionAgentInfo };
  /** Read acknowledgement, even when an unanswered approval keeps attention unchanged. */
  "pi/session/seen": { path: string };
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
  /** A project's environment command changed state (configured, resolved, failed). */
  "pi/project/env/changed": { status: ProjectEnvStatus };

  // ------------------------------------------------------------------ M4 --
  /** `DefaultPackageManager` progress, forwarded while an install/remove/update runs. */
  "pi/packages/progress": PackageProgress;
  /** One step of a provider sign-in started with `pi/providers/login/start` (M10-T6). */
  "pi/providers/login/event": { cwd: string; id: string; provider: string; event: ProviderLoginEvent };
  /** New rows in the log store, for live follow. Batched per host tick. */
  "pi/logs/append": { entries: LogEntry[] };

  // ----------------------------------------------------------------- M11 --
  /** A host-owned preference namespace changed, on any device. */
  "pi/prefs/updated": PrefsEntry;
}

export type ClientMethod = keyof ClientRequests;
export type HostRequestMethod = keyof HostRequests;
export type HostNotificationMethod = keyof HostNotifications;
