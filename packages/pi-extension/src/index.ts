/**
 * @lasercode/pi-extension — the single companion extension (D-13).
 *
 * The worker passes `createLaserExtension({ send, ... })` as an inline
 * extension factory when it builds the session's ResourceLoader. Inside the
 * Pi process it owns everything that must run in-process:
 *   - capability detection (which supported packages are present)
 *   - the model-facing half of the agent harness (D-140): `start_agent` and
 *     its siblings for parents, `complete_agent_run` for children, the child's
 *     role in its system prompt, and agent events delivered to the parent
 *   - long commands as background tasks (`bash` override plus `task_*` tools)
 *   - provider request/response hooks for the logs page
 *   - per-package glue (transcribe, goal, ...)
 *
 * Rules:
 *   - One module per capability under ./modules. Modules never import each
 *     other. A module that fails to activate is reported, not fatal.
 *   - Nothing that reads files lives here; file watchers are in @lasercode/host so
 *     terminal-started sessions (no worker, no extension) stay visible.
 *   - Child agent sessions load this extension like any other session: the
 *     harness bridge tells a module what role the session plays.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessBridge, BackgroundWorkOptions } from "./agents-bridge.js";
import type { PromptProvenanceObserver } from "./prompt-provenance.js";
export { createPromptProvenanceObserver, recordInstructionWrite } from "./prompt-provenance.js";
import { WIRE_NAMESPACE } from "@lasercode/protocol";
import {
  modules,
  type CommandBus,
  type McpModuleOptions,
  type ModuleContext,
  type ModuleName,
  type OutboundMessage,
  type WebSearchHandler,
} from "./modules/index.js";

export { createCommandBus, isGoalCommand, toSessionGoal } from "./modules/index.js";
export type {
  CommandBus,
  CommandHandler,
  ModuleName,
  OutboundMessage,
  ModuleContext,
  LaserModule,
} from "./modules/index.js";
export type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  BackgroundWorkOptions,
  ProjectEnvironmentBridge,
  CompleteRunInput,
  CompleteRunResult,
  FleetAgentRow,
  FleetCommandRow,
  FleetRow,
  FleetRowState,
  HarnessSessionRole,
  InspectAgentInput,
  InspectAgentResult,
  InspectFleetResult,
  InspectedMessage,
  ReadTaskOutputResult,
  RemoveAgentWorktreeInput,
  RemoveAgentWorktreeResult,
  SendAgentMessageInput,
  SendAgentMessageResult,
  StartAgentInput,
  StartAgentResult,
  StopAgentInput,
} from "./agents-bridge.js";

export interface LaserExtensionOptions {
  requestProvenance?: PromptProvenanceObserver;
  /** Credential/policy-aware search supplied only when its feature is enabled. */
  webSearch?: WebSearchHandler;
  /** The worker's agent harness for this session; omit when the agents feature is off. */
  agents?: AgentHarnessBridge;
  /** Shell execution with background promotion; omit to keep the engine's own `bash`. */
  backgroundWork?: BackgroundWorkOptions;
  /** MCP status for this session; omit when no MCP server runs here (docs/mcp.md). */
  mcp?: McpModuleOptions;
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
      const disposers: Array<() => void> = [];
      const ctx: ModuleContext = {
        pi,
        send: options.send,
        ...(options.requestProvenance ? { requestProvenance: options.requestProvenance } : {}),
        ...(options.webSearch ? { webSearch: options.webSearch } : {}),
        ...(options.agents ? { agents: options.agents } : {}),
        ...(options.backgroundWork ? { backgroundWork: options.backgroundWork } : {}),
        ...(options.mcp ? { mcp: options.mcp } : {}),
        ...(options.commands ? { commands: options.commands } : {}),
      };
      const wanted = new Set<ModuleName>(options.only ?? modules.map((m) => m.name));
      const registrationErrors = new Map<ModuleName, string>();
      for (const mod of modules) {
        if (!wanted.has(mod.name)) continue;
        try { mod.register?.(ctx); }
        catch { registrationErrors.set(mod.name, "Could not register this capability. Restart the project or update the app."); }
      }

      // Detection runs at session_start so extensions loaded after us are visible.
      pi.on("session_start", async (_event, session) => {
        ctx.session = session;
        const active: ModuleName[] = [];
        const failed: Array<{ module: ModuleName; error: string }> = [];
        for (const mod of modules) {
          if (!wanted.has(mod.name)) continue;
          const registrationError = registrationErrors.get(mod.name);
          if (registrationError) { failed.push({ module: mod.name, error: registrationError }); continue; }
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
