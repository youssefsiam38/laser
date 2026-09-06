/**
 * Messages produced inside a Pi session by the laser companion extension
 * (`@lasercode/pi-extension`). They live here, not in that package, so the worker
 * and host can reference them without importing anything Pi-flavoured
 * (AGENTS.md invariant 2: protocol first, then implementation).
 */

import type { Panel } from "./panels.js";
import type { SessionGoal } from "./features.js";

export type PiExtensionModuleName = "provider-log" | "subagents" | "transcribe" | "web-access" | "panels" | "goal";

export interface ProviderRequestRecord {
  at: string;
  /** The complete serialized provider payload, as Pi built it. */
  payload: unknown;
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
