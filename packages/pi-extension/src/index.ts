/**
 * @piorbit/pi-extension — the single companion extension (D-13).
 *
 * The worker passes `createPiorbitExtension({ send })` as an inline extension
 * factory when it builds the session's ResourceLoader. Inside the Pi process
 * it owns everything that must run in-process:
 *   - capability detection (which supported packages are present)
 *   - pi-subagents in-process registries and the `subagents:rpc:v1` bus
 *   - provider request/response hooks for the logs page
 *   - per-package glue (transcribe, web-access, ...)
 *
 * Rules:
 *   - One module per community package under ./modules. Modules never import
 *     each other. A module that fails to activate is reported, not fatal.
 *   - Nothing that reads files lives here; file watchers are in @piorbit/host so
 *     terminal-started sessions (no worker, no extension) stay visible.
 *   - Never load inside pi-subagents child sessions (PI_SUBAGENT_CHILD guard).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { modules, type ModuleContext, type ModuleName, type OutboundMessage } from "./modules/index.js";

export type { ModuleName, OutboundMessage, ModuleContext, PiorbitModule } from "./modules/index.js";

export interface PiorbitExtensionOptions {
  /** Delivers messages to the worker (in-process callback). */
  send: (message: OutboundMessage) => void;
  /** Restrict activation to these modules; default all. */
  only?: ModuleName[];
}

export const PIORBIT_EXTENSION_NAME = "piorbit";

export function createPiorbitExtension(options: PiorbitExtensionOptions): InlineExtension {
  return {
    name: PIORBIT_EXTENSION_NAME,
    factory: (pi: ExtensionAPI) => {
      if (process.env["PI_SUBAGENT_CHILD"] === "1") return;
      const disposers: Array<() => void> = [];
      const ctx: ModuleContext = { pi, send: options.send };
      const wanted = new Set<ModuleName>(options.only ?? modules.map((m) => m.name));

      // Detection runs at session_start so extensions loaded after us are visible.
      pi.on("session_start", async () => {
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
        options.send({ type: "piorbit/capabilities", active, failed });
      });

      pi.on("session_shutdown", async () => {
        for (const d of disposers.splice(0)) {
          try { d(); } catch { /* best effort */ }
        }
      });
    },
  };
}
