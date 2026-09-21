import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessBridge, BackgroundWorkOptions } from "../agents-bridge.js";
import type { PromptProvenanceObserver } from "../prompt-provenance.js";
import type { PiExtensionCommand, PiExtensionMessage, PiExtensionModuleName, ProviderCaptureLink } from "@lasercode/protocol";
import { accountUsageModule } from "./account-usage.js";
import { backgroundWorkModule } from "./background-work.js";
import { fileFreshnessModule } from "./file-freshness.js";
import { providerLogModule } from "./provider-log.js";
import { subagentsModule } from "./subagents.js";
import { transcribeModule } from "./transcribe.js";
import { goalModule } from "./goal.js";
import { mcpModule, type McpModuleOptions } from "./mcp.js";
import { projectWorkModule } from "./project-work.js";
import type { ProjectWorkBridge } from "../project-work-bridge.js";
import { webAccessModule, type WebSearchHandler } from "./web-access.js";
export type { McpModuleOptions } from "./mcp.js";
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
  /**
   * What the provider-capture producer may know about its link to the app
   * (RP-7): how far behind it is, and whether request bodies are kept here at
   * all. Absent from a worker that predates it, which simply means captures
   * cross as they always did.
   */
  captureLink?: ProviderCaptureLink;
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
  /**
   * MCP servers (`mcp` module). Present only when the worker loaded the MCP
   * engine for this session, which it does only for a project that has at
   * least one enabled server (docs/mcp.md).
   */
  mcp?: McpModuleOptions;
  /**
   * This session's project work (`project-work` module, M21-T17): the typed
   * bridge to the host authority, plus whichever of the Design Index and
   * Research this session has. Absent when the worker has no project-work
   * link at all, and the whole surface is then simply not registered.
   */
  projectWork?: ProjectWorkBridge;
}

/**
 * What a module is told when its session ends.
 *
 * The reason matters: only `quit` ends the person's work. `fork`, `new`,
 * `resume` and `reload` replace the extension runtime while the project, its
 * checkout and anything the agent left running carry on, so a module that owns
 * something outside the session must not treat them as an ending.
 */
export type ModuleShutdown = Pick<SessionShutdownEvent, "reason">;
export type ModuleDispose = (shutdown: ModuleShutdown) => void;

export interface LaserModule {
  name: ModuleName;
  /** Register tools while Pi is collecting extension definitions. */
  register?(ctx: ModuleContext): void;
  /** True if the package this module bridges is present in this session. */
  detect(ctx: ModuleContext): boolean | Promise<boolean>;
  /** Wire up; return a disposer if anything needs cleanup at session_shutdown. */
  activate(ctx: ModuleContext): void | ModuleDispose | Promise<void | ModuleDispose>;
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
          // One module's fault must not stop the others (AGENTS.md invariant 11).
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
  mcpModule,
  projectWorkModule,
];
