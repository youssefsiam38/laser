/**
 * Pure logic behind the settings screen: reading values out of a snapshot,
 * working out where a value came from, searching the catalogue, and turning a
 * hand-edited JSON document back into the change list the protocol accepts.
 */
import type {
  SettingChange,
  SettingDescriptor,
  SettingsCatalog,
  SettingsScope,
  SettingsSnapshot,
} from "@piorbit/protocol";

export type ValueOrigin = "project" | "global" | "default" | "unset";

export interface FieldRow {
  field: SettingDescriptor;
  /** Value at each scope, and what Pi will actually use. */
  global: unknown;
  project: unknown;
  effective: unknown;
  origin: ValueOrigin;
  /** The effective value differs from the default Pi documents. */
  overridden: boolean;
}

export function getAtPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function rowFor(field: SettingDescriptor, snapshot: SettingsSnapshot): FieldRow {
  const global = getAtPath(snapshot.global.values, field.path);
  const project = getAtPath(snapshot.project.values, field.path);
  const effective = getAtPath(snapshot.effective, field.path);
  const origin: ValueOrigin =
    project !== undefined ? "project" : global !== undefined ? "global" : field.default !== undefined ? "default" : "unset";
  const shown = effective !== undefined ? effective : field.default;
  return {
    field,
    global,
    project,
    effective,
    origin,
    overridden: effective !== undefined && !sameValue(shown, field.default),
  };
}

/**
 * Fields matching a query, ranked so the thing you typed the name of comes
 * first: exact path, then a path prefix, then label, then description.
 */
export function searchFields(fields: readonly SettingDescriptor[], query: string): SettingDescriptor[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...fields];
  const scored: Array<{ field: SettingDescriptor; score: number }> = [];
  for (const field of fields) {
    const path = field.path.toLowerCase();
    const label = field.label.toLowerCase();
    let score = -1;
    if (path === needle) score = 0;
    else if (path.startsWith(needle)) score = 1;
    else if (path.includes(needle)) score = 2;
    else if (label.includes(needle)) score = 3;
    else if (field.description.toLowerCase().includes(needle)) score = 4;
    if (score >= 0) scored.push({ field, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.field.path.localeCompare(b.field.path)).map((s) => s.field);
}

export function fieldsOfSection(fields: readonly SettingDescriptor[], section: string): SettingDescriptor[] {
  return fields.filter((field) => field.section === section);
}

/** Sections that still have at least one field after a search. */
export function sectionsWithFields(
  catalog: SettingsCatalog,
  fields: readonly SettingDescriptor[],
): SettingsCatalog["sections"] {
  const present = new Set(fields.map((field) => field.section));
  return catalog.sections.filter((section) => present.has(section.id));
}

/** Every field whose effective value is not Pi's default — the "diff" view. */
export function effectiveDiff(catalog: SettingsCatalog, snapshot: SettingsSnapshot): FieldRow[] {
  return catalog.fields
    .map((field) => rowFor(field, snapshot))
    .filter((row) => row.global !== undefined || row.project !== undefined)
    .sort((a, b) => a.field.path.localeCompare(b.field.path));
}

export interface JsonApplyResult {
  changes: SettingChange[];
  /**
   * Paths the editor changed that piorbit cannot write — keys Pi 0.85 does not
   * define. The caller refuses the whole edit and names them.
   */
  unrepresentable: string[];
}

/**
 * Turn a hand-edited settings document into a change list.
 *
 * Only catalogued paths can be written, so anything else the editor touched is
 * reported rather than dropped: silently ignoring an edit is the one thing a
 * JSON escape hatch must never do. Keys already in the file that the editor did
 * not touch are left alone — the worker merges rather than replaces.
 */
export function changesFromJson(
  catalog: SettingsCatalog,
  current: Record<string, unknown>,
  edited: Record<string, unknown>,
  scope: SettingsScope,
): JsonApplyResult {
  const changes: SettingChange[] = [];
  const writable = catalog.fields.filter((field) => field.scopes.includes(scope) && !field.managed);
  for (const field of writable) {
    const before = getAtPath(current, field.path);
    const after = getAtPath(edited, field.path);
    if (sameValue(before, after)) continue;
    changes.push(after === undefined ? { path: field.path, op: "unset" } : { path: field.path, op: "set", value: after });
  }

  // Apply what we can to a copy; anything still different is out of reach.
  const projected = structuredCloneish(current);
  for (const change of changes) {
    if (change.op === "unset") unsetAtPath(projected, change.path);
    else setAtPath(projected, change.path, change.value);
  }
  const unrepresentable = differingKeys(projected, edited);
  return { changes, unrepresentable };
}

function structuredCloneish(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function setAtPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop() as string;
  let cursor = doc;
  for (const segment of segments) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

function unsetAtPath(doc: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  const chain: Record<string, unknown>[] = [doc];
  let cursor = doc;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
    chain.push(cursor);
  }
  delete cursor[segments[segments.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i] as Record<string, unknown>).length > 0) break;
    delete (chain[i - 1] as Record<string, unknown>)[segments[i - 1] as string];
  }
}

/** Dotted paths where two documents still disagree, deepest-first. */
function differingKeys(a: unknown, b: unknown, prefix = ""): string[] {
  if (sameValue(a, b)) return [];
  const aObj = isPlainObject(a) ? a : undefined;
  const bObj = isPlainObject(b) ? b : undefined;
  if (!aObj || !bObj) return [prefix || "(document)"];
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const out: string[] = [];
  for (const key of keys) {
    out.push(...differingKeys(aObj[key], bObj[key], prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
