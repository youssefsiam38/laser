import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiExtensionMessage, PiExtensionModuleName } from "@piorbit/protocol";
import { providerLogModule } from "./provider-log.js";
import { subagentsModule } from "./subagents.js";
import { transcribeModule } from "./transcribe.js";
import { webAccessModule } from "./web-access.js";

export type ModuleName = PiExtensionModuleName;
export type OutboundMessage = PiExtensionMessage;

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
export const modules: readonly PiorbitModule[] = [
  providerLogModule,
  subagentsModule,
  transcribeModule,
  webAccessModule,
];
