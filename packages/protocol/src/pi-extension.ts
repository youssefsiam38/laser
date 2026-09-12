/**
 * Messages produced inside a Pi session by the laser companion extension
 * (`@lasercode/pi-extension`). They live here, not in that package, so the worker
 * and host can reference them without importing anything Pi-flavoured
 * (AGENTS.md invariant 2: protocol first, then implementation).
 */

import type { SessionGoal } from "./features.js";
import { PRODUCT_DISPLAY_NAME } from "./identity.js";
import type { BackgroundTaskUpdate } from "./tasks.js";
import type { McpRuntimeSnapshot } from "./mcp.js";

export type PiExtensionModuleName = "provider-log" | "account-usage" | "subagents" | "background-work" | "file-freshness" | "transcribe" | "web-access" | "goal" | "mcp";

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

export type PiExtensionMessage =
  | {
      type: "lasercode/capabilities";
      active: PiExtensionModuleName[];
      failed: Array<{ module: PiExtensionModuleName; error: string }>;
    }
  | ({ type: "lasercode/provider/request" } & ProviderRequestRecord)
  | ({ type: "lasercode/provider/response" } & ProviderResponseRecord)
  | { type: "lasercode/account-usage/state"; state: AccountUsageState }
  /** Namer's early label for a tool call still running (`lasercode/namer/label`). */
  | { type: "lasercode/namer/label"; toolCallId: string; label: string }
  | { type: "lasercode/goal/state"; goal: SessionGoal | null }
  /** The `mcp` module: the engine's sanitized per-session server status (docs/mcp.md). */
  | { type: "lasercode/mcp/status"; snapshot: McpRuntimeSnapshot }
  /**
   * The `background-work` module: one of this session's long commands
   * appeared or changed (docs/ux-fleet.md). The worker stamps the session
   * path on the way past; the host keeps `logPath` and never forwards it.
   */
  | { type: "lasercode/task/update"; task: BackgroundTaskUpdate }
  | {
      type: "lasercode/module/log";
      module: PiExtensionModuleName;
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
  | { type: "lasercode/account-usage/refresh" };
