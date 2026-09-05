import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerLogModule } from "./provider-log.js";
import { subagentsModule } from "./subagents.js";
import { transcribeModule } from "./transcribe.js";
import { webAccessModule } from "./web-access.js";

export type ModuleName = "provider-log" | "subagents" | "transcribe" | "web-access";

/** Messages a module may send to the worker. Extend in @piorbit/protocol first. */
export type OutboundMessage =
  | { type: "piorbit/capabilities"; active: ModuleName[]; failed: Array<{ module: ModuleName; error: string }> }
  | { type: "piorbit/provider/request"; at: string; payload: unknown }
  | { type: "piorbit/provider/response"; at: string; status: number; headers: Record<string, string> }
  | { type: "piorbit/subagents/event"; event: unknown }
  | { type: "piorbit/module/log"; module: ModuleName; level: "info" | "warn" | "error"; message: string };

export interface ModuleContext {
  pi: ExtensionAPI;
  send: (message: OutboundMessage) => void;
}

export interface PiorbitModule {
  name: ModuleName;
  /** True if the package this module bridges is present in this session. */
  detect(ctx: ModuleContext): boolean | Promise<boolean>;
  /** Wire up; return a disposer if anything needs cleanup at session_shutdown. */
  activate(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

/** Order matters only for log readability. Modules must not depend on each other. */
export const modules: readonly PiorbitModule[] = [providerLogModule, subagentsModule, transcribeModule, webAccessModule];
