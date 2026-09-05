import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiExtensionCommand, PiExtensionMessage, PiExtensionModuleName } from "@lasercode/protocol";
import { panelsModule } from "./panels.js";
import { providerLogModule } from "./provider-log.js";
import { subagentsModule } from "./subagents.js";
import { transcribeModule } from "./transcribe.js";
import { webAccessModule } from "./web-access.js";

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

/**
 * Panel ids a module will answer actions for, even ones it never emitted.
 *
 * Some panels are declared by the *host* — the pi-subagents file layer reads
 * runs off disk for sessions that have no extension at all — and an action on
 * one of those still has to reach the module that can perform it. A module
 * claims the id prefix it owns; the `panels` module asks this before dropping
 * a command for an id it has not seen.
 */
export interface PanelClaims {
  /** Register a prefix. The returned function releases it. */
  claim(prefix: string): () => void;
  /** Has any module claimed the namespace this id is in? */
  claimed(id: string): boolean;
}

export function createPanelClaims(): PanelClaims {
  const prefixes = new Set<string>();
  return {
    claim(prefix) {
      prefixes.add(prefix);
      return () => {
        prefixes.delete(prefix);
      };
    },
    claimed(id) {
      for (const prefix of prefixes) if (id.startsWith(prefix)) return true;
      return false;
    },
  };
}

export interface ModuleContext {
  pi: ExtensionAPI;
  send: (message: OutboundMessage) => void;
  /**
   * Commands from the worker (a panel action a person pressed). Absent when
   * the worker that loaded this extension predates commands; modules must
   * cope, and the panels module then simply has no inbound path.
   */
  commands?: CommandBus;
  /**
   * Panel id namespaces modules answer for. Absent only in a worker that
   * predates it; a module must not require it.
   */
  panels?: PanelClaims;
}

export interface LaserModule {
  name: ModuleName;
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
  panelsModule,
  subagentsModule,
  transcribeModule,
  webAccessModule,
];
