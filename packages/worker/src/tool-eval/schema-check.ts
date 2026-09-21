/**
 * Does this call fit the tool's closed schema?
 *
 * The contract's first measure is "schema violations: zero across the fixture
 * prompts", and a violation is exactly what the name says: a call whose
 * arguments the tool's own declared input schema does not accept. The lint
 * (`toolContract()`) proves the schema is closed and bounded; this proves a
 * call obeys it.
 *
 * It validates the subset of JSON Schema the contract allows a Laser tool to
 * declare — objects with `additionalProperties: false`, `required`, typed
 * scalars with their bounds, `enum`/`const`, `anyOf`/`oneOf` unions, arrays
 * with `maxItems` and typed items — and nothing else. A construct it does not
 * know is reported as unvalidatable rather than silently accepted, so a
 * schema that grows past this file fails loudly instead of quietly passing
 * every call.
 */
import { isRecord, type JsonSchemaNode } from "@lasercode/protocol";

/** One thing wrong with one call, said where it is wrong. */
export interface ArgumentViolation {
  /** `taskId`, `filters[0].kind`, `` (the argument object itself). */
  path: string;
  message: string;
}

const typeName = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/**
 * Validate one call's arguments against a tool's input schema.
 * An empty list means the call conforms.
 */
export function validateArguments(schema: JsonSchemaNode, args: unknown): ArgumentViolation[] {
  const violations: ArgumentViolation[] = [];
  check(schema, args, "", violations);
  return violations;
}

function check(node: unknown, value: unknown, path: string, out: ArgumentViolation[]): void {
  if (!isRecord(node)) {
    out.push({ path, message: "The schema for this value is not an object, so nothing could be checked." });
    return;
  }
  const branches = node["anyOf"] ?? node["oneOf"];
  if (Array.isArray(branches)) {
    const matched = branches.some((branch) => check_ok(branch, value, path));
    if (!matched) out.push({ path, message: `${describe(value)} matches none of the ${String(branches.length)} allowed forms.` });
    return;
  }
  // A `const` is the whole constraint: a node that fixes its value says
  // nothing more about it, and `type` beside it is decoration.
  if (node["const"] !== undefined) {
    if (value !== node["const"]) out.push({ path, message: `${describe(value)} is not ${JSON.stringify(node["const"])}.` });
    return;
  }
  const values = node["enum"];
  if (Array.isArray(values)) {
    if (!values.includes(value as never)) out.push({ path, message: `${describe(value)} is not one of ${values.map((entry) => JSON.stringify(entry)).join(", ")}.` });
    return;
  }

  const type = node["type"];
  switch (type) {
    case "object":
      checkObject(node, value, path, out);
      return;
    case "array":
      checkArray(node, value, path, out);
      return;
    case "string":
      if (typeof value !== "string") {
        out.push({ path, message: `${describe(value)} is not a string.` });
        return;
      }
      if (typeof node["minLength"] === "number" && value.length < node["minLength"]) {
        out.push({ path, message: `is shorter than the declared minimum of ${String(node["minLength"])} characters.` });
      }
      if (typeof node["maxLength"] === "number" && value.length > node["maxLength"]) {
        out.push({ path, message: `is ${String(value.length)} characters; the declared maximum is ${String(node["maxLength"])}.` });
      }
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        out.push({ path, message: `${describe(value)} is not a number.` });
        return;
      }
      if (type === "integer" && !Number.isInteger(value)) out.push({ path, message: `${String(value)} is not a whole number.` });
      if (typeof node["minimum"] === "number" && value < node["minimum"]) out.push({ path, message: `${String(value)} is below the declared minimum of ${String(node["minimum"])}.` });
      if (typeof node["maximum"] === "number" && value > node["maximum"]) out.push({ path, message: `${String(value)} is above the declared maximum of ${String(node["maximum"])}.` });
      return;
    case "boolean":
      if (typeof value !== "boolean") out.push({ path, message: `${describe(value)} is not true or false.` });
      return;
    case "null":
      if (value !== null) out.push({ path, message: `${describe(value)} is not null.` });
      return;
    default:
      out.push({ path, message: `The schema declares type ${JSON.stringify(type ?? null)}, which this checker does not know how to validate.` });
  }
}

/** A branch of a union: does the value fit it at all? */
function check_ok(node: unknown, value: unknown, path: string): boolean {
  const out: ArgumentViolation[] = [];
  check(node, value, path, out);
  return out.length === 0;
}

function checkObject(node: Record<string, unknown>, value: unknown, path: string, out: ArgumentViolation[]): void {
  if (!isRecord(value)) {
    out.push({ path, message: `${describe(value)} is not an object.` });
    return;
  }
  const properties = isRecord(node["properties"]) ? node["properties"] : {};
  const required = Array.isArray(node["required"]) ? node["required"].filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (!Object.hasOwn(value, name) || value[name] === undefined) out.push({ path: join(path, name), message: "is required and was not passed." });
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const declared = properties[name];
    if (declared === undefined) {
      if (node["additionalProperties"] === false) out.push({ path: join(path, name), message: "is not a field of this tool; the schema is closed." });
      continue;
    }
    check(declared, entry, join(path, name), out);
  }
}

function checkArray(node: Record<string, unknown>, value: unknown, path: string, out: ArgumentViolation[]): void {
  if (!Array.isArray(value)) {
    out.push({ path, message: `${describe(value)} is not an array.` });
    return;
  }
  if (typeof node["maxItems"] === "number" && value.length > node["maxItems"]) {
    out.push({ path, message: `has ${String(value.length)} items; the declared maximum is ${String(node["maxItems"])}.` });
  }
  if (typeof node["minItems"] === "number" && value.length < node["minItems"]) {
    out.push({ path, message: `has ${String(value.length)} items; the declared minimum is ${String(node["minItems"])}.` });
  }
  const items = node["items"];
  if (items === undefined) return;
  value.forEach((entry, index) => {
    check(items, entry, `${path}[${String(index)}]`, out);
  });
}

const join = (path: string, name: string): string => (path.length === 0 ? name : `${path}.${name}`);

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  const rendered = typeof value === "string" ? JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value) : typeName(value);
  return rendered;
}
