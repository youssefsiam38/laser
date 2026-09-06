/**
 * @lasercode/pi-extension — the single companion extension (D-13).
 *
 * The worker passes `createLaserExtension({ send })` as an inline extension
 * factory when it builds the session's ResourceLoader. Inside the Pi process
 * it owns everything that must run in-process:
 *   - capability detection (which supported packages are present)
 *   - pi-subagents in-process registries and the `subagents:rpc:v1` bus
 *   - provider request/response hooks for the logs page
 *   - per-package glue (transcribe, subagents, ...)
 *
 * Rules:
 *   - One module per community package under ./modules. Modules never import
 *     each other. A module that fails to activate is reported, not fatal.
 *   - Nothing that reads files lives here; file watchers are in @lasercode/host so
 *     terminal-started sessions (no worker, no extension) stay visible.
 *   - Never load inside pi-subagents child sessions (PI_SUBAGENT_CHILD guard).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { WIRE_NAMESPACE } from "@lasercode/protocol";
import {
  createPanelClaims,
  modules,
  type CommandBus,
  type ModuleContext,
  type ModuleName,
  type OutboundMessage,
} from "./modules/index.js";

export { createCommandBus, createPanelClaims, toSessionGoal } from "./modules/index.js";
export type {
  CommandBus,
  CommandHandler,
  PanelClaims,
  ModuleName,
  OutboundMessage,
  ModuleContext,
  LaserModule,
} from "./modules/index.js";

export interface LaserExtensionOptions {
  /** Delivers messages to the worker (in-process callback). */
  send: (message: OutboundMessage) => void;
  /**
   * Worker → extension commands (a panel action or account refresh). Create one
   * with `createCommandBus()`, pass it here, and call its `deliver()` from the
   * driver. Optional, so a worker that has no inbound path still loads the
   * extension unchanged.
   */
  commands?: CommandBus;
  /** Restrict activation to these modules; default all. */
  only?: ModuleName[];
}

/**
 * The name Pi registers this extension under.
 *
 * The wire namespace rather than the product name: Pi writes it into session
 * transcripts and a person's settings can filter on it, so renaming the product
 * must not make an existing session's extension records unreadable.
 */
export const LASER_EXTENSION_NAME: string = WIRE_NAMESPACE;

export function createLaserExtension(options: LaserExtensionOptions): InlineExtension {
  return {
    name: LASER_EXTENSION_NAME,
    factory: (pi: ExtensionAPI) => {
      if (process.env["PI_SUBAGENT_CHILD"] === "1") return;
      const disposers: Array<() => void> = [];
      const ctx: ModuleContext = {
        pi,
        send: options.send,
        panels: createPanelClaims(),
        ...(options.commands ? { commands: options.commands } : {}),
      };
      const wanted = new Set<ModuleName>(options.only ?? modules.map((m) => m.name));

      // Detection runs at session_start so extensions loaded after us are visible.
      pi.on("session_start", async (_event, session) => {
        ctx.session = session;
        const active: ModuleName[] = [];
        const failed: Array<{ module: ModuleName; error: string }> = [];
        for (const mod of modules) {
          if (!wanted.has(mod.name)) continue;
          try {
            if (!(await mod.detect(ctx))) continue;
            const dispose = await mod.activate(ctx);
            if (dispose) disposers.push(dispose);
            active.push(mod.name);
          } catch (error) {
            failed.push({ module: mod.name, error: error instanceof Error ? error.message : String(error) });
          }
        }
        options.send({ type: "lasercode/capabilities", active, failed });
      });

      pi.on("session_shutdown", async () => {
        for (const d of disposers.splice(0)) {
          try { d(); } catch { /* best effort */ }
        }
      });
    },
  };
}
