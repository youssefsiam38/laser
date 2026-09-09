import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessBridge, BackgroundWorkOptions } from "../agents-bridge.js";
import type { PromptProvenanceObserver } from "../prompt-provenance.js";
import type { PiExtensionCommand, PiExtensionMessage, PiExtensionModuleName } from "@lasercode/protocol";
import { accountUsageModule } from "./account-usage.js";
import { backgroundWorkModule } from "./background-work.js";
import { fileFreshnessModule } from "./file-freshness.js";
import { providerLogModule } from "./provider-log.js";
import { subagentsModule } from "./subagents.js";
import { transcribeModule } from "./transcribe.js";
import { goalModule } from "./goal.js";
import { webAccessModule, type WebSearchHandler } from "./web-access.js";
export type { WebSearchHandler } from "./web-access.js";
export { isGoalCommand, toSessionGoal } from "./goal.js";

export type ModuleName = PiExtensionModuleName;
export type OutboundMessage = PiExtensionMessage;

/**
 * A worker → extension command handler. Returns true when it handled the
 * command, so the worker can tell "delivered" from "nobody holds that id".
 */
export type CommandHandler = (command: PiExtensionCommand) => boolean | void;

/** Inbound side of a module: subscribe to worker commands. */
export interface CommandBus {
  on(handler: CommandHandler): () => void;
}

export interface ModuleContext {
  requestProvenance?: PromptProvenanceObserver;
  pi: ExtensionAPI;
  webSearch?: WebSearchHandler;
  /** Fresh context for the session_start currently activating modules. */
  session?: ExtensionContext;
  send: (message: OutboundMessage) => void;
  /**
   * Commands from the worker (Stop on a background task, a usage refresh).
   * Absent when the worker that loaded this extension predates commands;
   * modules must cope, and simply have no inbound path.
   */
  commands?: CommandBus;
  /**
   * The worker's agent harness for this session (`subagents` module). Absent
   * when the agents feature is off; the harness tools are then not registered.
   */
  agents?: AgentHarnessBridge;
  /**
   * Shell execution for this session (`background-work` module). Absent when
   * the worker does not own a shell here; the built-in `bash` then stays.
   */
  backgroundWork?: BackgroundWorkOptions;
}

export interface LaserModule {
  name: ModuleName;
  /** Register tools while Pi is collecting extension definitions. */
  register?(ctx: ModuleContext): void;
  /** True if the package this module bridges is present in this session. */
  detect(ctx: ModuleContext): boolean | Promise<boolean>;
  /** Wire up; return a disposer if anything needs cleanup at session_shutdown. */
  activate(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

/**
 * The extension's end of the command channel: the worker calls `deliver`, the
 * modules subscribe through `on`. Exported so `createLaserExtension` can hand
 * `deliver` to the driver and `on` to the modules.
 */
export function createCommandBus(): CommandBus & { deliver(command: PiExtensionCommand): boolean } {
  const handlers = new Set<CommandHandler>();
  return {
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    deliver(command) {
      let handled = false;
      for (const handler of [...handlers]) {
        try {
          if (handler(command) === true) handled = true;
        } catch {
          // One module's fault must not stop the others (AGENTS.md §6a).
        }
      }
      return handled;
    },
  };
}

/** Order matters only for log readability. Modules must not depend on each other. */
export const modules: readonly LaserModule[] = [
  providerLogModule,
  accountUsageModule,
  goalModule,
  subagentsModule,
  backgroundWorkModule,
  fileFreshnessModule,
  transcribeModule,
  webAccessModule,
];
