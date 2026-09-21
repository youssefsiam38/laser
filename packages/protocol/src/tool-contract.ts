/**
 * The agent-facing tool contract, as code (D-350,
 * `docs/agent-tool-contract.md`).
 *
 * Three things live here and nothing else:
 *
 *   1. **{@link ToolAnnotations}** — the four flags every Laser tool declares
 *      about itself, and the one mapping to MCP's annotation names.
 *   2. **{@link ToolError}** — the only shape a Laser tool's failure takes:
 *      what failed, whether anything was persisted, and the next valid call.
 *      A closed schema, a builder, and a rendering the model and the person
 *      both read which {@link parseToolError} reads back, because the engine
 *      keeps only a thrown error's message and discards its details.
 *   3. **{@link toolContract}** — the lint. A Laser tool that does not obey
 *      the contract fails at registration, and therefore in tests, before it
 *      can reach a model.
 *
 * Nothing here executes, registers or knows about the engine: the lint takes
 * plain JSON Schema, so the same spec can be written by hand in a test, read
 * from a conformance fixture, or taken from a TypeBox schema a module already
 * declares.
 */
import { z } from "zod";
import { TOOL_LABEL_EXEMPT, TOOL_LABEL_PARAM, isToolLabelExempt } from "./tool-label.js";

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * What a tool does to the world, in four independent facts.
 *
 * - `readOnly` — it changes nothing, not even "mark as seen".
 * - `idempotent` — repeating the same call is safe and lands the same state.
 * - `destructive` — it removes or ends something a person may want back.
 * - `external` — it leaves this machine's own authority (a provider, an
 *   integration, someone else's service).
 */
export interface ToolAnnotations {
  readOnly: boolean;
  idempotent: boolean;
  destructive: boolean;
  external: boolean;
}

/** MCP's names for the same four facts (`openWorldHint` is our `external`). */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/**
 * The one place the two vocabularies meet. Everything Laser-side speaks
 * {@link ToolAnnotations}; only a surface that exposes a tool through MCP
 * converts, and it converts here.
 */
export function mcpToolAnnotations(annotations: ToolAnnotations): McpToolAnnotations {
  return {
    readOnlyHint: annotations.readOnly,
    idempotentHint: annotations.idempotent,
    destructiveHint: annotations.destructive,
    openWorldHint: annotations.external,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A code is a stable, lowercase snake_case identifier; it is never shown as the headline. */
export const TOOL_ERROR_CODE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** Bounds, because an error travels in the model's context like everything else. */
export const TOOL_ERROR_MESSAGE_MAX = 2000;
export const TOOL_ERROR_NEXT_MAX = 600;

/**
 * A refusal or failure written for a person and usable by a model:
 * what went wrong, whether anything was persisted, and the next valid call.
 * Closed: a tool may not smuggle a payload through the error path.
 */
export const toolErrorSchema = z
  .object({
    code: z.string().regex(TOOL_ERROR_CODE_PATTERN),
    message: z.string().min(1).max(TOOL_ERROR_MESSAGE_MAX),
    committed: z.boolean(),
    next: z.string().min(1).max(TOOL_ERROR_NEXT_MAX),
  })
  .strict();

export type ToolError = z.infer<typeof toolErrorSchema>;

/**
 * Build one. Whitespace is normalised and over-long text is cut rather than
 * refused — an error is the worst moment to throw a second error — but a
 * missing message, a missing next call or a malformed code is a bug in the
 * tool and throws here, where a test sees it.
 */
export function toolError(input: { code: string; message: string; committed: boolean; next: string }): ToolError {
  return toolErrorSchema.parse({
    code: input.code.trim(),
    message: clamp(input.message, TOOL_ERROR_MESSAGE_MAX),
    committed: input.committed,
    next: clamp(input.next, TOOL_ERROR_NEXT_MAX),
  });
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The two sentences `committed` is written as. Fixed, so they can be read back. */
export const TOOL_ERROR_COMMITTED_SENTENCE = "Some of this was already saved.";
export const TOOL_ERROR_UNCOMMITTED_SENTENCE = "Nothing was changed.";

/**
 * The rendering a failing tool throws.
 *
 * The engine keeps only the message of a thrown error — its `details` are
 * dropped and replaced with `{}` — so the four fields have to be in the text
 * if they are to reach the transcript, the model and the person at all. The
 * shape is fixed, three parts, so {@link parseToolError} can recover it:
 *
 * ```
 * [no_such_run] No run called "run_9" was started by this session.
 * Nothing was changed.
 * Next: call inspect_fleet to list the agents under you with their runIds.
 * ```
 */
export function renderToolError(error: ToolError): string {
  const state = error.committed ? TOOL_ERROR_COMMITTED_SENTENCE : TOOL_ERROR_UNCOMMITTED_SENTENCE;
  return `[${error.code}] ${error.message}\n${state}\nNext: ${error.next}`;
}

const RENDERED = new RegExp(
  `^\\[([a-z][a-z0-9_]*)\\] ([\\s\\S]*?)\\n(${TOOL_ERROR_UNCOMMITTED_SENTENCE}|${TOOL_ERROR_COMMITTED_SENTENCE})\\nNext: ([\\s\\S]+)$`,
);

/**
 * Read a rendered tool error back into its fields, or `undefined` for text
 * that is not one: an engine tool's failure, an MCP tool's, a crash. A caller
 * that gets `undefined` shows the text as it is rather than guessing.
 */
export function parseToolError(text: string): ToolError | undefined {
  const match = RENDERED.exec(text.trim());
  if (!match) return undefined;
  const parsed = toolErrorSchema.safeParse({
    code: match[1],
    message: match[2],
    committed: match[3] === TOOL_ERROR_COMMITTED_SENTENCE,
    next: match[4],
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The property a thrown error carries its own {@link ToolError} on, for the
 * process that threw it: the worker's `HarnessError` fills it in when a
 * refusal knows its own code and recovery, and the registration helper reads
 * it instead of inventing defaults.
 */
export const TOOL_ERROR_PROPERTY = "toolError";

/** The {@link ToolError} a value carries, if it carries a valid one. */
export function carriedToolError(value: unknown): ToolError | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const carried = (value as Record<string, unknown>)[TOOL_ERROR_PROPERTY];
  const parsed = toolErrorSchema.safeParse(carried);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// The spec a tool is linted as
// ---------------------------------------------------------------------------

/** Verb + object in snake_case: at least two words, no CRUD-over-table names. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
/** Domain rules yes, tutorials no; the long form lives in the companion doc. */
export const TOOL_DESCRIPTION_MAX = 1200;

/** Plain JSON Schema, as TypeBox and a hand-written fixture both produce it. */
export type JsonSchemaNode = Readonly<Record<string, unknown>>;

/** Whether the worker injects D-277's activity label into this tool. */
export type ToolLabelMode = "injected" | "exempt";

/** One Laser tool, as the contract sees it. */
export interface LaserToolSpec {
  name: string;
  description: string;
  /** The closed input schema the model fills in. */
  input: JsonSchemaNode;
  /** The declared result shape. Free text only inside a named field. */
  output: JsonSchemaNode;
  annotations: ToolAnnotations;
  label: ToolLabelMode;
}

export const TOOL_CONTRACT_RULES = [
  "name",
  "description",
  "input-closed",
  "property-described",
  "string-bounds",
  "array-bounds",
  "page-size-bounds",
  "enum-closed",
  "annotations",
  "label",
  "output-schema",
] as const;
export type ToolContractRule = (typeof TOOL_CONTRACT_RULES)[number];

/** One thing wrong, where it is wrong, said the way the person fixing it reads it. */
export interface ToolContractIssue {
  rule: ToolContractRule;
  /** `input.properties.messages`, `output`, `annotations`, `name`. */
  path: string;
  message: string;
}

/**
 * Property names that are a page size, and therefore need a declared
 * `maximum`. The list is explicit rather than a clever pattern: a lint that
 * guesses is a lint people argue with.
 */
const PAGE_SIZE_NAMES = new Set([
  "limit",
  "tail",
  "count",
  "size",
  "pagesize",
  "page_size",
  "numresults",
  "num_results",
  "maxresults",
  "max_results",
  "messages",
  "lines",
  "rows",
  "results",
  "depth",
  "top",
]);

/** Whether a number by this name is a page size. Case- and separator-insensitive. */
export function isPageSizeProperty(name: string): boolean {
  const normalized = name.replace(/[-\s]/g, "_").toLowerCase();
  return PAGE_SIZE_NAMES.has(normalized) || PAGE_SIZE_NAMES.has(normalized.replace(/_/g, ""));
}

/**
 * Lint one tool against the contract. An empty array means it conforms.
 * Every rule is independent, so one bad property never hides another.
 */
export function toolContract(spec: LaserToolSpec): ToolContractIssue[] {
  const issues: ToolContractIssue[] = [];
  const add = (rule: ToolContractRule, path: string, message: string): void => {
    issues.push({ rule, path, message });
  };

  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    add("name", "name", `"${spec.name}" is not a verb_object name in snake_case, like inspect_agent or remove_agent_worktree.`);
  }

  const description = spec.description.trim();
  if (description.length === 0) add("description", "description", "A tool needs a description: what it does, and what changes when it does it.");
  else if (spec.description.length > TOOL_DESCRIPTION_MAX) {
    add(
      "description",
      "description",
      `The description is ${String(spec.description.length)} characters; the budget is ${String(TOOL_DESCRIPTION_MAX)}. Move the long form into the companion document and link it.`,
    );
  }

  checkInputObject(spec.input, "input", add);
  checkLabel(spec, add);
  checkAnnotations(spec.annotations, add);
  checkOutput(spec.output, add);
  return issues;
}

/** The lint as an assertion: used at registration, so a bad tool never loads. */
export function assertToolContract(spec: LaserToolSpec): void {
  const issues = toolContract(spec);
  if (issues.length === 0) return;
  const lines = issues.map((issue) => `  · ${issue.path} (${issue.rule}): ${issue.message}`).join("\n");
  throw new Error(`The tool "${spec.name}" does not obey the tool contract (docs/agent-tool-contract.md):\n${lines}`);
}

type Add = (rule: ToolContractRule, path: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object level: closed, and every property described and bounded. */
function checkInputObject(node: JsonSchemaNode, path: string, add: Add): void {
  if (!isRecord(node)) {
    add("input-closed", path, "The input schema must be a JSON Schema object.");
    return;
  }
  if (node["type"] !== "object") {
    add("input-closed", path, `The input schema must declare type "object"; this one declares ${JSON.stringify(node["type"] ?? null)}.`);
  }
  if (node["additionalProperties"] !== false) {
    add("input-closed", path, "A closed schema declares additionalProperties: false, so an invented field is refused rather than ignored.");
  }
  const properties = node["properties"];
  if (properties !== undefined && !isRecord(properties)) {
    add("input-closed", `${path}.properties`, "properties must be an object.");
    return;
  }
  for (const [name, property] of Object.entries(isRecord(properties) ? properties : {})) {
    checkProperty(name, property, `${path}.properties.${name}`, add);
  }
}

/** One named property: it says what it is for, and it is bounded. */
function checkProperty(name: string, node: unknown, path: string, add: Add): void {
  if (!isRecord(node)) {
    add("property-described", path, "A property must be a JSON Schema object.");
    return;
  }
  const description = node["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    add("property-described", path, `"${name}" has no description. Every field the model fills in says what it is for.`);
  }
  checkValue(name, node, path, add);
}

/** Bounds, enums and nesting, for a property or for one branch of a union. */
function checkValue(name: string, node: Record<string, unknown>, path: string, add: Add): void {
  const branches = node["anyOf"] ?? node["oneOf"];
  if (Array.isArray(branches)) {
    if (branches.length === 0) add("enum-closed", path, "An empty anyOf/oneOf accepts nothing and says nothing.");
    branches.forEach((branch, index) => {
      if (isRecord(branch)) checkValue(name, branch, `${path}.anyOf[${String(index)}]`, add);
    });
    return;
  }

  if (node["enum"] !== undefined) {
    const values = node["enum"];
    if (!Array.isArray(values) || values.length === 0) {
      add("enum-closed", path, "An enum must list at least one value.");
    } else if (!values.every((value) => ["string", "number", "boolean"].includes(typeof value))) {
      add("enum-closed", path, "An enum lists scalars only, so the model can see every choice.");
    }
  }

  const type = node["type"];
  const constrained = node["enum"] !== undefined || node["const"] !== undefined;
  if (type === "string" && !constrained && typeof node["maxLength"] !== "number") {
    add("string-bounds", path, `"${name}" is an unbounded string. Declare maxLength, or close it with an enum.`);
  }
  if (type === "array") {
    if (typeof node["maxItems"] !== "number") add("array-bounds", path, `"${name}" is an unbounded array. Declare maxItems.`);
    const items = node["items"];
    if (isRecord(items)) checkValue(name, items, `${path}.items`, add);
  }
  if ((type === "number" || type === "integer") && isPageSizeProperty(name) && typeof node["maximum"] !== "number") {
    add("page-size-bounds", path, `"${name}" is a page size without a ceiling. Declare maximum, so a truncated answer is a bound and not a surprise.`);
  }
  if (type === "object") checkInputObject(node, path, add);
}

/** D-277: the label is injected, never declared, and exactly three tools have none. */
function checkLabel(spec: LaserToolSpec, add: Add): void {
  const expected: ToolLabelMode = isToolLabelExempt(spec.name) ? "exempt" : "injected";
  if (spec.label !== expected) {
    add(
      "label",
      "label",
      expected === "exempt"
        ? `${spec.name} carries no activity label (D-277: ${TOOL_LABEL_EXEMPT.join(", ")} name their own work), so it declares label "exempt".`
        : `${spec.name} is given an activity label by the worker (D-277), so it declares label "injected".`,
    );
  }
  const properties = isRecord(spec.input) ? spec.input["properties"] : undefined;
  if (isRecord(properties) && Object.hasOwn(properties, TOOL_LABEL_PARAM)) {
    add("label", `input.properties.${TOOL_LABEL_PARAM}`, `${TOOL_LABEL_PARAM} is injected by the worker and stripped before execution; a tool never declares it itself.`);
  }
}

function checkAnnotations(annotations: ToolAnnotations, add: Add): void {
  if (!isRecord(annotations)) {
    add("annotations", "annotations", "Every tool declares readOnly, idempotent, destructive and external.");
    return;
  }
  for (const flag of ["readOnly", "idempotent", "destructive", "external"] as const) {
    if (typeof annotations[flag] !== "boolean") add("annotations", `annotations.${flag}`, `${flag} must be declared true or false.`);
  }
  if (annotations.readOnly === true && annotations.destructive === true) {
    add("annotations", "annotations", "A read-only tool cannot be destructive: one of the two flags is wrong.");
  }
}

function checkOutput(node: JsonSchemaNode, add: Add): void {
  if (!isRecord(node)) {
    add("output-schema", "output", "A tool declares the shape of its result; free text belongs inside a named field.");
    return;
  }
  if (node["type"] !== "object") {
    add("output-schema", "output", `The output schema must declare type "object"; this one declares ${JSON.stringify(node["type"] ?? null)}.`);
  }
  const properties = node["properties"];
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    add("output-schema", "output.properties", "The output schema names at least one field. A tool that returns nothing still says so.");
    return;
  }
  for (const [name, property] of Object.entries(properties)) {
    const description = isRecord(property) ? property["description"] : undefined;
    if (typeof description !== "string" || description.trim().length === 0) {
      add("output-schema", `output.properties.${name}`, `"${name}" has no description. A result field says what it means.`);
    }
  }
}
