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
 *
 * `next` is forced onto **one line**. That is not tidiness: it is what makes
 * {@link renderToolError} and {@link parseToolError} a round trip. The
 * rendering separates the message from the state sentence with a newline, so
 * a `next` that could itself contain a newline could contain the separator
 * too, and the parse would have two places to split. One line in `next`
 * leaves exactly one candidate — the last one — whatever the message says,
 * and a message quoting "Nothing was changed." or "Next: " survives the trip
 * unchanged.
 */
export function toolError(input: { code: string; message: string; committed: boolean; next: string }): ToolError {
  return toolErrorSchema.parse({
    code: input.code.trim(),
    message: clamp(input.message, TOOL_ERROR_MESSAGE_MAX),
    committed: input.committed,
    next: clamp(oneLine(input.next), TOOL_ERROR_NEXT_MAX),
  });
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** One sentence, on one line: every run of whitespace becomes a single space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** A literal string inside a regular expression, with nothing of its own to say. */
function quoteForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * The parse, built so that it cannot be fooled by its own vocabulary.
 *
 * The sentences are matched literally (their `.` is escaped, so "Nothing was
 * changedX" is not one of them), the message is **greedy** so the split falls
 * on the *last* state line rather than the first — a message may quote one —
 * and `next` is a single line, which {@link toolError} guarantees. Together
 * those three make the last candidate the real separator, always.
 */
const RENDERED = new RegExp(
  `^\\[([a-z][a-z0-9_]*)\\] ([\\s\\S]*)\\n(${quoteForRegExp(TOOL_ERROR_UNCOMMITTED_SENTENCE)}|${quoteForRegExp(TOOL_ERROR_COMMITTED_SENTENCE)})\\nNext: ([^\\n]+)$`,
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

/**
 * Every tool Laser registers through `registerLaserTool` (D-350.d: ten with
 * M26, and the eleven project-work tools of M21-T17). The live truth is `laserToolRegistry()` in the companion
 * extension, which only a process that imports the engine may read; this is
 * the same list for the surfaces that may not — the transcript, which has to
 * know whether a row it is drawing is a Laser tool or the engine's `bash`.
 * `packages/worker/test/tool-eval/fixtures.test.ts` pins the two together
 * after a real registration, so a tool added to one and not the other fails
 * the suite.
 */
export const LASER_TOOL_NAMES: readonly string[] = [
  "start_agent",
  "send_agent_message",
  "inspect_fleet",
  "inspect_agent",
  "stop_agent",
  "remove_agent_worktree",
  "complete_agent_run",
  "task_output",
  "task_stop",
  "web_search",
  // M21-T17 · the project lifecycle, in one companion module.
  "inspect_project_work",
  "write_project_artifact",
  "request_project_review",
  "report_project_task",
  "inspect_design_index",
  "build_design_index",
  "review_design_index",
  "search_sources",
  "read_source",
  "record_finding",
  "resolve_question",
];

/** Whether this tool name is one of Laser's own, rather than the engine's or an MCP server's. */
export function isLaserToolName(name: string | undefined): boolean {
  return name !== undefined && LASER_TOOL_NAMES.includes(name);
}

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
  "take",
  "bytes",
  "window",
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
  // M21-T17: `inspect_project_work` reads a body by offset and limit, and the
  // limit is that page's size like any other.
  "body_limit",
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

  checkInput(spec.input, add);
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

/**
 * A plain JSON object — a schema node, a result payload, an argument bag.
 * Exported because six modules had written it out for themselves and one of
 * them is the difference between a lint that walks a schema and one that
 * skips it.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The types the contract's schema subset knows. Anything else is refused, not skipped. */
const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * JSON Schema keywords the lint deliberately does not understand.
 *
 * The evaluation harness's validator already says the right thing about its
 * own subset — "a construct it does not know is reported as unvalidatable
 * rather than silently accepted" — and a lint that failed open where the
 * validator fails loud would let a schema be *conforming* and *unvalidatable*
 * at the same time. So a reference, a conditional, a negation or a rule about
 * properties the lint cannot enumerate is an issue: write the shape out.
 */
const UNSUPPORTED_KEYWORDS = [
  "$ref",
  "$dynamicRef",
  "$defs",
  "definitions",
  "patternProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
] as const;

/**
 * How one schema is walked. Inputs and outputs are walked by the same code
 * and judged by different rules (D-350.i): an input is a contract a model has
 * to satisfy exactly, so it is closed and bounded; an output is the declared
 * shape of a result, so it is described, and nothing more.
 */
interface Walk {
  add: Add;
  /** The rule a structural problem is reported under. */
  structure: ToolContractRule;
  /** The rule a missing description is reported under. */
  described: ToolContractRule;
  /** Whether strings, arrays and page sizes must declare their bounds. */
  bounds: boolean;
  /** Whether every object level must declare `additionalProperties: false`. */
  closed: boolean;
}

/** The whole input schema: an object, closed, described and bounded at every level. */
function checkInput(node: JsonSchemaNode, add: Add): void {
  if (!isRecord(node)) {
    add("input-closed", "input", "The input schema must be a JSON Schema object.");
    return;
  }
  if (node["type"] !== "object") {
    add("input-closed", "input", `The input schema must declare type "object"; this one declares ${JSON.stringify(node["type"] ?? null)}.`);
  }
  checkValue("input", node, "input", { add, structure: "input-closed", described: "property-described", bounds: true, closed: true });
}

/** One object level: closed, with every property described. */
function checkObjectLevel(node: Record<string, unknown>, path: string, ctx: Walk): void {
  if (ctx.closed && node["additionalProperties"] !== false) {
    ctx.add(ctx.structure, path, "A closed schema declares additionalProperties: false, so an invented field is refused rather than ignored.");
  }
  const properties = node["properties"];
  if (properties !== undefined && !isRecord(properties)) {
    ctx.add(ctx.structure, `${path}.properties`, "properties must be an object.");
    return;
  }
  for (const [name, property] of Object.entries(isRecord(properties) ? properties : {})) {
    checkProperty(name, property, `${path}.properties.${name}`, ctx);
  }
}

/** One named property: it says what it is for, and it is walked like any value. */
function checkProperty(name: string, node: unknown, path: string, ctx: Walk): void {
  if (!isRecord(node)) {
    ctx.add(ctx.described, path, "A property must be a JSON Schema object.");
    return;
  }
  const description = node["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    ctx.add(ctx.described, path, `"${name}" has no description. Every field the model fills in says what it is for.`);
  }
  checkValue(name, node, path, ctx);
}

/**
 * One value: a property, a union branch, an `allOf` member, an array's items.
 *
 * Everything that can hide a schema is walked — `allOf` (what TypeBox's
 * `Type.Intersect` emits), `anyOf` *and* `oneOf` when both are present,
 * `prefixItems`, a tuple-shaped `items`, a `type` written as a list — and a
 * node that says nothing the lint understands is an issue rather than a pass.
 */
function checkValue(name: string, node: unknown, path: string, ctx: Walk): void {
  if (!isRecord(node)) {
    ctx.add(ctx.structure, path, `A schema must be a JSON Schema object; this one is ${describeJson(node)}.`);
    return;
  }

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (node[keyword] !== undefined) {
      ctx.add(ctx.structure, path, `"${keyword}" is outside the schema subset the contract understands, so nothing here — or in the evaluation harness — can check it. Write the shape out in full.`);
    }
  }

  // A combinator describes the value as much as a `type` does; a node may
  // carry both (an intersection of objects that also names its own fields).
  let says = false;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = node[keyword];
    if (branches === undefined) continue;
    says = true;
    if (!Array.isArray(branches) || branches.length === 0) {
      ctx.add("enum-closed", path, `An empty ${keyword} accepts nothing and says nothing.`);
      continue;
    }
    branches.forEach((branch, index) => {
      checkValue(name, branch, `${path}.${keyword}[${String(index)}]`, ctx);
    });
  }

  if (node["enum"] !== undefined) {
    says = true;
    const values = node["enum"];
    if (!Array.isArray(values) || values.length === 0) {
      ctx.add("enum-closed", path, "An enum must list at least one value.");
    } else if (!values.every((value) => ["string", "number", "boolean"].includes(typeof value))) {
      ctx.add("enum-closed", path, "An enum lists scalars only, so the model can see every choice.");
    }
  }
  if (node["const"] !== undefined) says = true;

  const type = node["type"];
  if (type !== undefined) {
    says = true;
    // `type: ["string", "null"]` is still a string, and still needs its bound.
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0) ctx.add(ctx.structure, path, "An empty type list accepts nothing and says nothing.");
    for (const entry of types) {
      if (typeof entry !== "string" || !KNOWN_TYPES.has(entry)) {
        ctx.add(ctx.structure, path, `type ${JSON.stringify(entry ?? null)} is not one of ${[...KNOWN_TYPES].join(", ")}, so nothing can tell what this accepts.`);
        continue;
      }
      checkTyped(entry, name, node, path, ctx);
    }
  }

  if (!says) {
    ctx.add(ctx.structure, path, `"${name}" declares no type, enum, const or union, so nothing can tell what it accepts.`);
  }
}

/** One declared type of one value: its bounds and its nesting. */
function checkTyped(type: string, name: string, node: Record<string, unknown>, path: string, ctx: Walk): void {
  const constrained = node["enum"] !== undefined || node["const"] !== undefined;
  if (type === "string" && ctx.bounds && !constrained && typeof node["maxLength"] !== "number") {
    ctx.add("string-bounds", path, `"${name}" is an unbounded string. Declare maxLength, or close it with an enum.`);
  }
  if (type === "array") {
    if (ctx.bounds && typeof node["maxItems"] !== "number") ctx.add("array-bounds", path, `"${name}" is an unbounded array. Declare maxItems.`);
    const items = node["items"];
    const prefix = node["prefixItems"];
    if (Array.isArray(prefix)) prefix.forEach((entry, index) => checkValue(name, entry, `${path}.prefixItems[${String(index)}]`, ctx));
    if (Array.isArray(items)) items.forEach((entry, index) => checkValue(name, entry, `${path}.items[${String(index)}]`, ctx));
    else if (items !== undefined) checkValue(name, items, `${path}.items`, ctx);
    else if (ctx.bounds && !Array.isArray(prefix)) {
      ctx.add("array-bounds", path, `"${name}" is an array that never says what is in it. Declare items.`);
    }
  }
  if ((type === "number" || type === "integer") && ctx.bounds && isPageSizeProperty(name) && typeof node["maximum"] !== "number") {
    ctx.add("page-size-bounds", path, `"${name}" is a page size without a ceiling. Declare maximum, so a truncated answer is a bound and not a surprise.`);
  }
  if (type === "object") checkObjectLevel(node, path, ctx);
}

/** What a value is, for a message a person reads: `42`, `null`, `a list`. */
function describeJson(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value === undefined) return "missing";
  return JSON.stringify(value) ?? String(value);
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

/**
 * The declared result (D-350.i).
 *
 * An output is walked with the same walker as an input and judged by weaker
 * rules, on purpose. Bounds and closure are what a model must satisfy when it
 * *fills a schema in*: they turn an invented field or an unbounded page into
 * a refusal. A result is produced by the tool itself, never sent to the model
 * as a schema, and validated by nothing at runtime — so `additionalProperties:
 * false` there would enforce nothing while looking like enforcement, and
 * `maxLength` would duplicate the truncation the tool already does in code.
 * What the output schema is *for* — telling a reader, a fixture and the docs
 * what comes back — is exactly what this checks: an object, at least one
 * field, every field described at every level, and no construct the lint
 * cannot read. When results are validated (a lifecycle tool's payload against
 * its declared output), this rule grows with the validator.
 */
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
  checkValue("output", node, "output", { add, structure: "output-schema", described: "output-schema", bounds: false, closed: false });
}
