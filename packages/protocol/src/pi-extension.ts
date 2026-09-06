/**
 * Messages produced inside a Pi session by the laser companion extension
 * (`@lasercode/pi-extension`). They live here, not in that package, so the worker
 * and host can reference them without importing anything Pi-flavoured
 * (AGENTS.md invariant 2: protocol first, then implementation).
 */

import type { Panel } from "./panels.js";
import type { SessionGoal } from "./features.js";

export type PiExtensionModuleName = "provider-log" | "account-usage" | "subagents" | "transcribe" | "web-access" | "panels" | "goal";

/** One server-owned allowance window for an account-authenticated provider. */
export interface AccountUsageWindow {
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
  | { type: "lasercode/subagents/event"; event: unknown }
  | { type: "lasercode/goal/state"; goal: SessionGoal | null }
  /** The `panels` module: a validated `laser:panel` event, or a close (docs/ux-panels.md). */
  | { type: "lasercode/panel/upsert"; panel: Panel }
  | { type: "lasercode/panel/close"; id: string; reason?: string }
  | {
      type: "lasercode/module/log";
      module: PiExtensionModuleName;
      level: "info" | "warn" | "error";
      message: string;
    };
