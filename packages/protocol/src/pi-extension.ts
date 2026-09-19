/**
 * Messages produced inside a Pi session by the laser companion extension
 * (`@lasercode/pi-extension`). They live here, not in that package, so the worker
 * and host can reference them without importing anything Pi-flavoured
 * (AGENTS.md invariant 2: protocol first, then implementation).
 */

import type { SessionGoal } from "./features.js";
import { PRODUCT_DISPLAY_NAME } from "./identity.js";
import type { MemoryPressureDirectiveLevel } from "./memory-pressure.js";
import type { ProviderCaptureMeta, ProviderCaptureOmission, ProviderCaptureSummary } from "./provider-capture.js";
import type { RuntimeFailure, RuntimeModuleName } from "./runtime-recovery.js";
import type { BackgroundTaskUpdate } from "./tasks.js";
import type { McpRuntimeSnapshot } from "./mcp.js";

export type PiExtensionModuleName = RuntimeModuleName;

/** One server-owned allowance window for an account-authenticated provider. */
export interface AccountUsageWindow {
  /** Server-owned allowance bucket; distinct buckets must never be summed. */
  limitId?: string;
  limitName?: string;
  kind: "primary" | "secondary" | "other";
  usedPercent: number;
  windowDurationMins?: number;
  /** Unix timestamp in seconds. */
  resetsAt?: number;
}

/** Purchased credits are separate from the rolling subscription allowance. */
export interface AccountCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-formatted decimal value; never coerce financial precision. */
  balance?: string;
}

export interface AccountUsageSnapshot {
  provider: string;
  planType?: string;
  fetchedAt: string;
  windows: AccountUsageWindow[];
  credits?: AccountCredits;
}

export interface AccountUsageState {
  provider: string;
  status: "loading" | "ready" | "unavailable";
  /** Kept during refresh/failure so the last good reading never disappears. */
  snapshot?: AccountUsageSnapshot;
  message?: string;
}

export interface ProviderRequestRecord {
  at: string;
  context?: ProviderRequestContext;
  /** The complete serialized provider payload, as Pi built it. */
  payload: unknown;
  /** Engine-neutral row line, including live-request composition estimates. */
  summary?: ProviderCaptureSummary;
}

/** Engine-neutral identity captured alongside the serialized request body. */
export interface ProviderRequestContext {
  promptEntryId?: string;
  provider?: string;
  model?: string;
  api?: string;
  /** Offsets refer to captured string leaves, never to files read by the UI. */
  instructionSources?: InstructionSourceMap[];
}

/** Stable wire identities, canonical display order and editable token names. */
export const ORIGINS = [
  { id: "engine", label: "Engine", token: "provenance-engine" },
  { id: "project", label: "Project", token: "provenance-project" },
  { id: "skill", label: "Skills", token: "provenance-skill" },
  { id: "agent", label: "Agent", token: "provenance-agent" },
  { id: "variable", label: "Variables", token: "provenance-variable" },
  { id: "app", label: PRODUCT_DISPLAY_NAME, token: "provenance-app" },
  { id: "extension", label: "Extensions", token: "provenance-extension" },
  { id: "environment", label: "Environment", token: "provenance-environment" },
  { id: "unrecorded", label: "Not recorded", token: "provenance-unrecorded" },
] as const;
export const INSTRUCTION_APP_ORIGIN = "app";
export type InstructionOrigin = (typeof ORIGINS)[number]["id"];
export interface InstructionSource {
  /** Legacy classification; new consumers use origin. */
  kind?: InstructionOrigin | "file" | undefined;
  /** Absent only in captures made before origin identities were recorded. */
  origin?: InstructionOrigin | undefined;
  label: string;
  agentName?: string | undefined;
  fieldKey?: string | undefined;
  module?: string | undefined;
  reason?: "template-ranges-unavailable" | "verification-unavailable" | undefined;
  path?: string | undefined;
  /** A named contribution with no source file to open. */
  inline?: true | undefined;
}
export interface InstructionSourceSpan {
  /** UTF-16 offsets, matching browser text ranges. */
  start: number;
  end: number;
  source: InstructionSource;
}
export interface InstructionSourceMap {
  /** Exact JSON path to one string in the provider payload. */
  path: Array<string | number>;
  /** Reject stale ranges after redaction, truncation or later transformation. */
  sha256: string;
  spans: InstructionSourceSpan[];
}

export interface ProviderResponseRecord {
  at: string;
  status: number;
  headers: Record<string, string>;
}

/**
 * What one session's background commands hold, for RP-3's retained-store
 * counters and the worker's log budget. Counts and bytes only; no command
 * text, no paths, no ids.
 */
export interface BackgroundTaskRetention {
  /** Commands still running. Never compacted, never evicted. */
  live: number;
  /** Terminal records still held in memory, already compacted. */
  terminal: number;
  /** Bytes of live tail buffers held in memory. */
  liveTailBytes: number;
  /** Bytes of terminal excerpts held in memory. */
  excerptBytes: number;
  /** Bytes this session's command logs occupy on disk. */
  logBytes: number;
  /** Bytes accepted from commands and not yet written. Bounded by construction. */
  pendingLogBytes: number;
  /** Records dropped by a bound since the session started. */
  evicted: number;
  /** Log segments released by a byte bound since the session started. */
  released: number;
  /** Live tail buffers shrunk or released by the session's tail ceiling. */
  tailsShrunk: number;
}

export type PiExtensionMessage =
  | {
      type: "lasercode/capabilities";
      active: PiExtensionModuleName[];
      failed: Array<{ module: PiExtensionModuleName; failure: RuntimeFailure }>;
    }
  | ({ type: "lasercode/provider/request" } & ProviderRequestRecord)
  | ({ type: "lasercode/provider/response" } & ProviderResponseRecord)
  /**
   * A capture too large for one frame (RP-7): its metadata, then its redacted
   * body in bounded chunks, then the end that proves the digest. None of the
   * four ever reaches a client or a relay listener; the host turns them into
   * one log row, which is read back through `pi/logs/query` and
   * `pi/logs/content` like any other.
   */
  | ({ type: "lasercode/provider/request/begin" } & ProviderCaptureMeta)
  | { type: "lasercode/provider/request/chunk"; captureId: string; index: number; text: string }
  | { type: "lasercode/provider/request/end"; captureId: string; chunks: number; bytes: number }
  /**
   * The producer gave up on a capture it had already begun — the link filled
   * while it was sending. One message, keyed by the capture id: the host
   * releases the pieces it holds and records the request once, without its
   * body, with the reason. Never two rows, and never a body half-stored.
   */
  | { type: "lasercode/provider/request/abort"; captureId: string; reason: ProviderCaptureOmission }
  /** The request happened and is recorded; its body was not kept, and why. */
  | ({ type: "lasercode/provider/request/omitted" } & ProviderCaptureMeta & { reason: ProviderCaptureOmission })
  | { type: "lasercode/account-usage/state"; state: AccountUsageState }
  | { type: "lasercode/goal/state"; goal: SessionGoal | null }
  /** The `mcp` module: the engine's sanitized per-session server status (docs/mcp.md). */
  | { type: "lasercode/mcp/status"; snapshot: McpRuntimeSnapshot }
  /**
   * The `background-work` module: one of this session's long commands
   * appeared or changed (docs/ux-fleet.md). The worker stamps the session
   * path on the way past; the host keeps `logPath` and never forwards it.
   */
  | { type: "lasercode/task/update"; task: BackgroundTaskUpdate }
  /**
   * The `background-work` module: what this session's commands are holding
   * right now (RP-6). Published when it changes — a task starts, a terminal
   * one is compacted, a bound evicts — never on a timer, so it stays a fact
   * and not a heartbeat. The worker aggregates it for the host's retained
   * store counters and for its own per-worker log budget.
   */
  | { type: "lasercode/task/retention"; retention: BackgroundTaskRetention }
  /**
   * A pid the module knows the meaning of: the shell of one background
   * command. Consumed by the host's process inventory (RP-1) and dropped
   * before any broadcast; a client is never told a pid.
   *
   * There is no matching "it ended" message: a pid alone cannot identify the
   * process it names once that process has gone, so the end of one is the
   * host's own table's to notice, never this module's to assert.
   */
  | { type: "lasercode/process/registration"; pid: number; taskId: string }
  | {
      type: "lasercode/module/log";
      module: PiExtensionModuleName | "worker";
      level: "info" | "warn" | "error";
      message: string;
    };

/**
 * Worker → companion extension. Fire-and-forget: the handler answers whether
 * it recognised the command, never what it produced.
 */
export type PiExtensionCommand =
  /** A person pressed Stop on a background task in the fleet. */
  | { type: "lasercode/task/stop"; id: string }
  /**
   * The worker's share of the per-worker log budget for this session (RP-6).
   * A session releases only bytes it wrote itself: the worker never deletes
   * another runtime's files, it tells each owner how much it may keep.
   */
  | { type: "lasercode/task/log-budget"; bytes: number }
  /**
   * The worker is short of memory and this session's **finished** commands are
   * asked to keep less for one sweep (RP-8).
   *
   * A level, and nothing else: the module decides what that means for its own
   * records. It never touches a running command, a live tail or a durable log,
   * so a command keeps running and `task_output` keeps answering — the bounds
   * return to their declared values when the level does.
   */
  | { type: "lasercode/task/pressure"; level: MemoryPressureDirectiveLevel }
  | { type: "lasercode/account-usage/refresh" };
