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
import type { ProjectMentionContext, ProjectWorkBridge } from "./project-work-bridge.js";
import type { PromptProvenanceObserver } from "./prompt-provenance.js";
export type {
  ProjectMentionContext,
  ProjectMentionContextBlock,
  ProjectMentionContextMessage,
  ProjectWorkBridge,
  ProjectWorkToolBinding,
} from "./project-work-bridge.js";
export { createPromptProvenanceObserver, recordInstructionWrite } from "./prompt-provenance.js";
// The one door every Laser tool goes through (D-350), exported so a
// conformance fixture can read a tool's spec without starting a session.
export { LaserToolFailure, laserToolRegistry, laserToolSpec, registerLaserTool, toolFailure } from "./register-tool.js";
export type { LaserToolDefinition, LaserToolExecute, LaserToolRecovery } from "./register-tool.js";
import { WIRE_NAMESPACE, type ProviderCaptureLink, type RuntimeFailure, type RuntimeFailureCategory, type RuntimeFailureStage } from "@lasercode/protocol";
import {
  modules,
  type CommandBus,
  type McpModuleOptions,
  type ModuleContext,
  type ModuleDispose,
  type ModuleName,
  type ModuleShutdown,
  type OutboundMessage,
  type WebSearchHandler,
} from "./modules/index.js";

export { createCommandBus, isGoalCommand, toSessionGoal } from "./modules/index.js";
export type {
  CommandBus,
  CommandHandler,
  ModuleName,
  ModuleDispose,
  ModuleShutdown,
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
  /** Link facts the provider-capture producer answers to (RP-7). */
  captureLink?: ProviderCaptureLink;
  /** Credential/policy-aware search supplied only when its feature is enabled. */
  webSearch?: WebSearchHandler;
  /** The worker's agent harness for this session; omit when the agents feature is off. */
  agents?: AgentHarnessBridge;
  /** Shell execution with background promotion; omit to keep the engine's own `bash`. */
  backgroundWork?: BackgroundWorkOptions;
  /** MCP status for this session; omit when no MCP server runs here (docs/mcp.md). */
  mcp?: McpModuleOptions;
  /** This session's project work (M21-T17); omit and none of its tools load. */
  projectWork?: ProjectWorkBridge;
  /**
   * What this session's messages mentioned (M21-T9), for the model to read
   * beside the message that mentioned it. Independent of `projectWork`: a
   * session with no project work of its own still has mentions.
   */
  mentionContext?: ProjectMentionContext;
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

function moduleFailure(
  module: ModuleName,
  stage: RuntimeFailureStage,
  category: RuntimeFailureCategory,
  message: string,
): RuntimeFailure {
  return { owner: { kind: "module", module }, stage, category, message };
}

export function createLaserExtension(options: LaserExtensionOptions): InlineExtension {
  return {
    name: LASER_EXTENSION_NAME,
    factory: (pi: ExtensionAPI) => {
      const disposers: ModuleDispose[] = [];
      const ctx: ModuleContext = {
        pi,
        send: options.send,
        ...(options.requestProvenance ? { requestProvenance: options.requestProvenance } : {}),
        ...(options.captureLink ? { captureLink: options.captureLink } : {}),
        ...(options.webSearch ? { webSearch: options.webSearch } : {}),
        ...(options.agents ? { agents: options.agents } : {}),
        ...(options.backgroundWork ? { backgroundWork: options.backgroundWork } : {}),
        ...(options.mcp ? { mcp: options.mcp } : {}),
        ...(options.projectWork ? { projectWork: options.projectWork } : {}),
        ...(options.mentionContext ? { mentionContext: options.mentionContext } : {}),
        ...(options.commands ? { commands: options.commands } : {}),
      };
      const wanted = new Set<ModuleName>(options.only ?? modules.map((m) => m.name));
      const registrationErrors = new Map<ModuleName, RuntimeFailure>();
      for (const mod of modules) {
        if (!wanted.has(mod.name)) continue;
        try { mod.register?.(ctx); }
        catch {
          registrationErrors.set(mod.name, moduleFailure(
            mod.name,
            "register",
            "registration_error",
            "Could not register this capability. Restart the project or update the app.",
          ));
        }
      }

      // Detection runs at session_start so extensions loaded after us are visible.
      pi.on("session_start", async (_event, session) => {
        ctx.session = session;
        const active: ModuleName[] = [];
        const failed: Array<{ module: ModuleName; failure: RuntimeFailure }> = [];
        for (const mod of modules) {
          if (!wanted.has(mod.name)) continue;
          const registrationError = registrationErrors.get(mod.name);
          if (registrationError) { failed.push({ module: mod.name, failure: registrationError }); continue; }
          let detected: boolean;
          try {
            detected = await mod.detect(ctx);
          } catch {
            failed.push({
              module: mod.name,
              failure: moduleFailure(
                mod.name,
                "detect",
                "detection_error",
                "Could not check this capability. Restart the project or update the app.",
              ),
            });
            continue;
          }
          if (!detected) continue;
          try {
            const dispose = await mod.activate(ctx);
            if (dispose) disposers.push(dispose);
            active.push(mod.name);
          } catch {
            failed.push({
              module: mod.name,
              failure: moduleFailure(
                mod.name,
                "activate",
                "activation_error",
                "Could not start this capability. Restart the project or update the app.",
              ),
            });
          }
        }
        options.send({ type: "lasercode/capabilities", active, failed });
      });

      // The reason is part of the news, not noise: `quit` is the person
      // leaving, while `fork`, `new`, `resume` and `reload` only replace this
      // runtime. A module that owns something living outside the session
      // (a background command) decides for itself what each means.
      pi.on("session_shutdown", async (event) => {
        const shutdown: ModuleShutdown = { reason: event?.reason ?? "quit" };
        for (const d of disposers.splice(0)) {
          try { d(shutdown); } catch { /* best effort */ }
        }
      });
    },
  };
}
