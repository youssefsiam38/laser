/**
 * project-work — the model-facing half of the project lifecycle (M21-T17).
 *
 * One module for the whole area, not three: AGENTS.md invariant 11 says glue
 * for a capability is a module, and the lifecycle surface, the Design Index
 * and Research are one capability — a person's project work — reached through
 * one worker-supplied bridge. Modules never import each other, so everything
 * this one needs arrives on `ctx.projectWork`.
 *
 * What only this module can do, because it runs inside the engine session:
 *
 *   1. **Register the tools.** Whatever the bridge offers, and nothing else:
 *      a projectless chat gets `inspect_project_work` alone, a project
 *      without a design index gets no `inspect_design_index`, and a session
 *      whose research adapters are all switched off gets no research tools.
 *      An absent tool is absent, never present-and-refusing
 *      (`docs/agent-tool-contract.md` §3).
 *   2. **Put the turn's context in front of the model**, at
 *      `before_agent_start` — the same model-call boundary the agent role
 *      block uses (D-140), so the implementation context packet is rebuilt
 *      every turn and a `/design implement @Design` hand-off lands in the
 *      turn that asked for it.
 *
 * The worker owns the rest: the typed bridge to the host authority, the
 * Design Index builder, the Research run. Nothing here writes anything.
 */
import { INSTRUCTION_APP_ORIGIN, PRODUCT_DISPLAY_NAME, type LaserToolSpec } from "@lasercode/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { recordInstructionWrite } from "../prompt-provenance.js";
import { registerLaserTool } from "../register-tool.js";
import type { ProjectWorkBridge, ProjectWorkToolBinding } from "../project-work-bridge.js";
import type { LaserModule, ModuleContext } from "./index.js";

/**
 * The engine's short UI label for a tool, from its own name:
 * `inspect_project_work` → `Inspect project work`. The tools are named verb +
 * object by the contract, so the name already is the label.
 */
export function toolLabel(name: string): string {
  const words = name.split("_");
  const first = words[0] ?? name;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/**
 * Register one worker-defined tool.
 *
 * The worker declares the tool as a contract-linted {@link LaserToolSpec} —
 * plain JSON Schema, which is what TypeBox produces anyway — so the schema
 * the model sees is the one the fixtures lint and the one the engine
 * validates against. `registerLaserTool` re-lints it at registration, strips
 * D-277's activity label and turns a failure into the contract's error shape.
 */
export function registerBinding(pi: ExtensionAPI, binding: ProjectWorkToolBinding): void {
  const spec: LaserToolSpec = binding.spec;
  registerLaserTool(
    pi,
    {
      name: spec.name,
      label: toolLabel(spec.name),
      description: spec.description,
      activityLabel: spec.label,
      annotations: spec.annotations,
      recovery: binding.recovery,
      output: spec.output,
      parameters: spec.input as unknown as TSchema,
    },
    async (_toolCallId, params) => {
      const answer = await binding.run((params ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(answer, null, 2) }], details: answer };
    },
  );
}

/** Every tool this session's bridge offers, in the order the docs list them. */
export function bindingsOf(bridge: ProjectWorkBridge): ProjectWorkToolBinding[] {
  return [...bridge.lifecycleTools(), ...bridge.designTools(), ...bridge.researchTools()];
}

export const projectWorkModule: LaserModule = {
  name: "project-work",

  detect: (ctx) => Boolean(ctx.projectWork),

  register(ctx: ModuleContext) {
    const bridge = ctx.projectWork;
    if (!bridge) return;
    for (const binding of bindingsOf(bridge)) {
      try {
        registerBinding(ctx.pi, binding);
      } catch (error) {
        // One tool that does not conform must not take the others with it:
        // the failure is reported and the rest of the surface still loads.
        ctx.send({
          type: "lasercode/module/log",
          module: "project-work",
          level: "warn",
          message: `could not register ${binding.spec.name}: ${describe(error)}`,
        });
      }
    }
  },

  activate(ctx: ModuleContext) {
    const bridge = ctx.projectWork;
    if (!bridge) return;
    let disposed = false;

    // The model-call boundary. The packet is rebuilt here every turn, so it
    // can never describe a state older than the turn reading it, and it goes
    // into the system prompt rather than the transcript: it is context, not
    // something the person said.
    ctx.pi.on("before_agent_start", async (event) => {
      if (disposed) return undefined;
      let block: string | undefined;
      try {
        block = await bridge.turnContext({ prompt: event.prompt });
      } catch (error) {
        ctx.send({
          type: "lasercode/module/log",
          module: "project-work",
          level: "warn",
          message: `could not build this turn's project context: ${describe(error)}`,
        });
        return undefined;
      }
      if (!block) return undefined;
      return recordInstructionWrite(
        { systemPrompt: `${event.systemPrompt}\n\n${block}` },
        {
          kind: INSTRUCTION_APP_ORIGIN,
          origin: INSTRUCTION_APP_ORIGIN,
          label: `${PRODUCT_DISPLAY_NAME} · Project work`,
          inline: true,
          module: "project-work",
        },
      );
    });

    return () => {
      disposed = true;
    };
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
