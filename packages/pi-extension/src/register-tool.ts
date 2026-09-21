/**
 * The one way a Laser tool reaches a model (D-350,
 * `docs/agent-tool-contract.md`).
 *
 * Every tool Laser registers with the engine goes through
 * {@link registerLaserTool}, and it does three things no module should do for
 * itself:
 *
 *   1. **Lints the tool against the contract at registration.** A name that is
 *      not verb + object, an open schema, an undescribed or unbounded field, a
 *      missing annotation, a description over budget or a mis-declared
 *      activity label throws here — which means in the module's own tests,
 *      before a model ever sees it.
 *   2. **Strips D-277's injected `activity_label`** before `execute`, so a
 *      tool never receives, validates or logs a parameter that is a display
 *      hint and not an argument. The worker's driver already strips it on the
 *      way in; this is the same rule held at the only other door.
 *   3. **Turns a failure into the contract's error shape**: `{ code, message,
 *      committed, next }`, rendered into the thrown message. The engine keeps
 *      only a thrown error's message — its `details` are replaced with `{}` —
 *      so the four fields travel as text and `parseToolError()` reads them
 *      back for the UI. `committed` is forced to `false` for a read-only
 *      tool: a read cannot have saved anything, and no declaration may claim
 *      otherwise.
 *
 * The engine's own tools are not Laser's to reshape: the `bash` override in
 * `modules/background-work.ts` keeps the engine's definition and is not
 * registered here.
 */
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertToolContract,
  carriedToolError,
  isToolLabelExempt,
  parseToolError,
  renderToolError,
  toolError,
  withoutToolLabel,
  type JsonSchemaNode,
  type LaserToolSpec,
  type ToolAnnotations,
  type ToolError,
} from "@lasercode/protocol";
import type { TSchema } from "typebox";

/**
 * What a tool says about its own failures when the failure itself does not.
 *
 * `next` names the call the model should make instead — the whole point of
 * the contract's error rule — and is written as a sentence fragment starting
 * with a verb: "call inspect_fleet to list the agents under you".
 */
export interface LaserToolRecovery {
  /** The code carried by a failure with nothing more specific to say. */
  code: string;
  /** The next valid call. */
  next: string;
}

/** A Laser tool, as its module declares it. */
export interface LaserToolDefinition<TParams extends TSchema, TDetails> {
  name: string;
  /** The engine's short UI label for the tool itself (not D-277's activity label). */
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /** The closed input schema, as TypeBox — which is JSON Schema already. */
  parameters: TParams;
  /** The declared result shape, as JSON Schema. */
  output: JsonSchemaNode;
  annotations: ToolAnnotations;
  recovery: LaserToolRecovery;
  /** Whether the worker injects an activity label here (D-277). */
  activityLabel: "injected" | "exempt";
}

/**
 * The tool's own `execute`, which never sees the injected label. It is the
 * engine's own signature: the parameter type comes from the engine's TypeBox,
 * so a module's schema and its handler agree without a cast.
 */
export type LaserToolExecute<TParams extends TSchema, TDetails> = ToolDefinition<TParams, TDetails>["execute"];

/** The tool as the contract lint reads it. Also what a conformance fixture records. */
export function laserToolSpec<TParams extends TSchema, TDetails>(definition: LaserToolDefinition<TParams, TDetails>): LaserToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.parameters as unknown as JsonSchemaNode,
    output: definition.output,
    annotations: definition.annotations,
    label: definition.activityLabel,
  };
}

/**
 * The error a Laser tool throws: the contract's four fields, rendered into
 * the message, and carried on the value itself for anything in this process
 * that would rather read them than parse them.
 */
export class LaserToolFailure extends Error {
  readonly toolError: ToolError;
  constructor(error: ToolError, cause?: unknown) {
    super(renderToolError(error), cause === undefined ? undefined : { cause });
    this.name = "LaserToolFailure";
    this.toolError = error;
  }
}

/** Whether a failure is the turn being cancelled rather than the tool refusing. */
function isAbort(failure: unknown): boolean {
  return failure instanceof Error && (failure.name === "AbortError" || failure.name === "TimeoutError");
}

function describe(failure: unknown): string {
  const text = failure instanceof Error ? failure.message.trim() : String(failure).trim();
  return text.length > 0 ? text : "The tool failed without saying why.";
}

/**
 * The contract's shape for one failure.
 *
 * A refusal that knows its own code and recovery carries them (the worker's
 * `HarnessError` does); one that does not takes the tool's declared defaults,
 * keeping its own sentence, which is already written for a person.
 */
export function toolFailure(
  failure: unknown,
  definition: Pick<LaserToolDefinition<TSchema, unknown>, "annotations" | "recovery">,
): ToolError {
  const known = carriedToolError(failure) ?? (failure instanceof Error ? parseToolError(failure.message) : undefined);
  const committed = definition.annotations.readOnly ? false : (known?.committed ?? false);
  if (known) return { ...known, committed };
  return toolError({
    code: definition.recovery.code,
    message: describe(failure),
    committed,
    next: definition.recovery.next,
  });
}

/**
 * Register one Laser tool. Throws at registration when it does not conform,
 * so a non-conforming tool fails the module's tests rather than a session.
 */
export function registerLaserTool<TParams extends TSchema, TDetails = unknown>(
  pi: ExtensionAPI,
  definition: LaserToolDefinition<TParams, TDetails>,
  execute: LaserToolExecute<TParams, TDetails>,
): void {
  assertToolContract(laserToolSpec(definition));

  const tool: ToolDefinition<TParams, TDetails> = {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    ...(definition.promptSnippet !== undefined ? { promptSnippet: definition.promptSnippet } : {}),
    ...(definition.promptGuidelines !== undefined ? { promptGuidelines: definition.promptGuidelines } : {}),
    parameters: definition.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      // The label is a display hint, never an argument (D-277). Exempt tools
      // are left exactly as they came.
      const args = isToolLabelExempt(definition.name) ? params : withoutToolLabel(params, definition.name);
      try {
        return await execute(toolCallId, args, signal, onUpdate, ctx);
      } catch (failure) {
        // A cancelled turn is not a tool refusal and must not be dressed as
        // one: the engine has its own wording for it.
        if (isAbort(failure)) throw failure;
        throw new LaserToolFailure(toolFailure(failure, definition), failure);
      }
    },
  };
  pi.registerTool(tool);
}
