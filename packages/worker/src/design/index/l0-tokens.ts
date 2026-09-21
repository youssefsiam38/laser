/**
 * L0 · token documents the project already has.
 *
 * DTCG (`$value` / `$type`), Style Dictionary and Terrazzo's legacy shape
 * (`value` / `type`) and Figma token exports all describe the same thing: a
 * tree whose leaves are tokens. They are JSON, so they are parsed as JSON —
 * the only "config" in the whole index that is data by definition.
 *
 * Every token found here is `declared`: the project wrote it down. An alias
 * (`{color.brand.500}`) is kept as the alias it is, never resolved into a
 * literal the project never stated.
 */
import { factId, sourceAt, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";
import { categorizeNamed, type ValueCategory } from "./l0-styles.js";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** DTCG `$type` → the index's own value family. */
const DTCG_TYPES: Record<string, ValueCategory> = {
  color: "color",
  dimension: "spacing",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  duration: "duration",
  cubicBezier: "easing",
  number: "zIndex",
  shadow: "shadow",
  border: "border",
  typography: "fontSize",
  transition: "duration",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  borderRadius: "radius",
  spacing: "spacing",
  size: "size",
  opacity: "opacity",
  breakpoint: "breakpoint",
};

/** A file whose name says it holds tokens. Contents decide the rest. */
export function isTokenDocumentPath(path: string): boolean {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (!name.endsWith(".json")) return false;
  return (
    name.endsWith(".tokens.json") ||
    name === "tokens.json" ||
    name === "design-tokens.json" ||
    /(^|[-.])tokens([-.]|$)/.test(name.replace(/\.json$/, "")) ||
    /design[-_]?tokens/.test(path.toLowerCase()) ||
    // A `tokens/` directory is the other place a project keeps them, whatever
    // the individual files are called.
    /(^|\/)(tokens|design-tokens)\//.test(path.toLowerCase())
  );
}

interface Leaf {
  path: string[];
  value: string;
  type?: string;
  description?: string;
}

function isTokenLeaf(node: Record<string, unknown>): boolean {
  return typeof node["$value"] === "string" || typeof node["$value"] === "number" || typeof node["value"] === "string" || typeof node["value"] === "number";
}

function leafOf(node: Record<string, unknown>, path: string[]): Leaf {
  const raw = node["$value"] ?? node["value"];
  const type = node["$type"] ?? node["type"];
  const description = node["$description"] ?? node["comment"] ?? node["description"];
  return {
    path,
    value: typeof raw === "number" ? String(raw) : String(raw),
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

function collect(node: unknown, path: string[], leaves: Leaf[], depth: number): void {
  if (depth > 12 || !isRecord(node)) return;
  if (isTokenLeaf(node)) {
    leaves.push(leafOf(node, path));
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    collect(child, [...path, key], leaves, depth + 1);
  }
}

/** Every declared token of one JSON token document. */
export function parseTokenDocument(file: SourceFile): L0Result {
  const gaps: Gap[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (error) {
    return { facts: [], gaps: [{ path: file.path, reason: `this token file is not valid JSON (${error instanceof Error ? error.message : "unreadable"}), so none of its tokens are in the index.` }] };
  }
  if (!isRecord(parsed)) return { facts: [], gaps: [{ path: file.path, reason: "this token file does not hold an object." }] };
  const leaves: Leaf[] = [];
  collect(parsed, [], leaves, 0);
  if (leaves.length === 0) {
    return { facts: [], gaps: [{ path: file.path, reason: "this file is named like a token document but holds no $value or value leaves." }] };
  }
  const facts: DesignFact[] = leaves.map((leaf) => {
    const name = leaf.path.join(".");
    const alias = /^\{.+\}$/.test(leaf.value);
    const declaredType = leaf.type !== undefined ? DTCG_TYPES[leaf.type] : undefined;
    const category = declaredType ?? categorizeNamed(name.replace(/\./g, "-"), leaf.value) ?? "size";
    const line = Math.max(0, file.lines.findIndex((text) => text.includes(`"${leaf.path.at(-1) ?? name}"`)));
    return {
      id: factId("token", `${category}:${name}:${leaf.value}`, file.path, leaf.value),
      kind: "token",
      name,
      value: leaf.value,
      detail: {
        category,
        form: "token document",
        ...(leaf.type !== undefined ? { declaredType: leaf.type } : {}),
        ...(leaf.description !== undefined ? { description: leaf.description.slice(0, 300) } : {}),
        ...(alias ? { alias: "true" } : {}),
      },
      source: sourceAt(file, line),
      confidence: "declared",
    };
  });
  return { facts, gaps };
}
