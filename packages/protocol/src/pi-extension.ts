/**
 * Messages produced inside a Pi session by the laser companion extension
 * (`@lasercode/pi-extension`). They live here, not in that package, so the worker
 * and host can reference them without importing anything Pi-flavoured
 * (AGENTS.md invariant 2: protocol first, then implementation).
 */

import type { Panel } from "./panels.js";

export type PiExtensionModuleName = "provider-log" | "subagents" | "transcribe" | "web-access" | "panels";

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
      type: "piorbit/capabilities";
      active: PiExtensionModuleName[];
      failed: Array<{ module: PiExtensionModuleName; error: string }>;
    }
  | ({ type: "piorbit/provider/request" } & ProviderRequestRecord)
  | ({ type: "piorbit/provider/response" } & ProviderResponseRecord)
  | { type: "piorbit/subagents/event"; event: unknown }
  /** The `panels` module: a validated `laser:panel` event, or a close (docs/ux-panels.md). */
  | { type: "piorbit/panel/upsert"; panel: Panel }
  | { type: "piorbit/panel/close"; id: string; reason?: string }
  | {
      type: "piorbit/module/log";
      module: PiExtensionModuleName;
      level: "info" | "warn" | "error";
      message: string;
    };
