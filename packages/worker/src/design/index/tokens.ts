/**
 * The index's token layer: a DTCG document, every token citing its sources.
 *
 * Two kinds of token go in, and the difference is kept visible forever:
 *
 * - a **declared** token — a custom property, a Sass variable, a Tailwind
 *   theme key, a leaf of a DTCG file — keeps the project's own name and
 *   value;
 * - an **observed** value — a literal that appeared in declarations — is
 *   clustered with every identical value, counted, and named after what it is
 *   (`color.observed.1f2937`). Naming it *well* is L1's job and is labelled
 *   `proposed` when it happens; this layer never invents a semantic name.
 *
 * Aliases (`var(--x)`, `{color.brand.500}`) are kept as aliases. Resolving one
 * would state a value the project never wrote.
 */
import { PRODUCT_NAME, type DesignToken, type DesignTokenGroup, type FindingConfidence } from "@lasercode/protocol";
import { stableId, type DesignFact } from "./facts.js";
import type { ValueCategory } from "./l0-styles.js";

/** The `$extensions` key Laser's own provenance lives under. */
export const TOKEN_EXTENSION_KEY = `com.${PRODUCT_NAME}.provenance`;

/** The index's value families, as DTCG `$type`s. */
const DTCG_TYPE: Record<ValueCategory, string> = {
  color: "color",
  spacing: "dimension",
  size: "dimension",
  fontFamily: "fontFamily",
  fontSize: "dimension",
  fontWeight: "fontWeight",
  lineHeight: "number",
  radius: "dimension",
  shadow: "shadow",
  duration: "duration",
  easing: "cubicBezier",
  zIndex: "number",
  breakpoint: "dimension",
  border: "dimension",
  opacity: "number",
};

/** One token of the index, before it becomes a DTCG leaf and an entry. */
export interface IndexToken {
  /** Dotted DTCG path, e.g. `color.brand.primary`. */
  path: string;
  category: ValueCategory;
  value: string;
  confidence: Extract<FindingConfidence, "declared" | "observed">;
  /** How many parsed declarations carried this value. */
  usages: number;
  /** True when the value points at another token instead of holding one. */
  alias: boolean;
  sources: Array<{ path: string; digest?: string; excerpt?: string }>;
  factIds: string[];
  /** Stable entry id, so a review of this token survives a re-index. */
  entryId: string;
  description?: string;
}

const MAX_TOKENS = 800;
/** A literal has to appear this often before it is worth a token of its own. */
const OBSERVED_MIN_USAGES = 2;

/**
 * The token's DTCG path.
 *
 * A name the project already wrote as a path — `colors.brand.500` in a
 * Tailwind theme, `size.font.body` in a Style Dictionary file — is kept
 * exactly as the project wrote it, case included: that *is* the project's own
 * naming, and renaming it would make the index harder to read than the source.
 * A flat name (`--brand-primary`, `$space-sm`) becomes a path under its family.
 */
export function tokenPath(category: ValueCategory, rawName: string): string {
  const name = rawName
    .replace(/^--/, "")
    .replace(/^[$@]/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^\.|\.$/g, "");
  if (name.includes(".")) return name;
  const dotted = name.replace(/-/g, ".").toLowerCase();
  const head = dotted.split(".")[0] ?? "";
  const family = familyOf(category);
  return head === family ? dotted : `${family}.${dotted}`;
}

function familyOf(category: ValueCategory): string {
  switch (category) {
    case "color":
      return "color";
    case "spacing":
      return "space";
    case "size":
      return "size";
    case "fontFamily":
    case "fontSize":
    case "fontWeight":
    case "lineHeight":
      return "type";
    case "radius":
      return "radius";
    case "shadow":
      return "shadow";
    case "duration":
    case "easing":
      return "motion";
    case "zIndex":
      return "layer";
    case "breakpoint":
      return "breakpoint";
    case "border":
      return "border";
    case "opacity":
      return "opacity";
  }
}

/** Colours compare case-insensitively and `#abc` is `#aabbcc`. */
export function normalizeValue(category: ValueCategory, value: string): string {
  const text = value.trim().replace(/\s+/g, " ").replace(/;$/, "");
  if (category !== "color") return text;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (!hex) return text.toLowerCase();
  const digits = (hex[1] ?? "").toLowerCase();
  if (digits.length === 3 || digits.length === 4) return `#${[...digits].map((digit) => digit + digit).join("")}`;
  return `#${digits}`;
}

function isAlias(value: string): boolean {
  return /^var\(--[^)]+\)$/.test(value.trim()) || /^\{[^}]+\}$/.test(value.trim()) || value.trim().startsWith("$") || value.trim().startsWith("@");
}

function categoryOf(fact: DesignFact): ValueCategory | undefined {
  const category = fact.detail?.["category"];
  return category !== undefined && category !== "computed" ? (category as ValueCategory) : undefined;
}

/**
 * Every token of a build, from the facts: declared tokens keep their names,
 * observed literals are clustered by value inside their family.
 */
export function collectTokens(facts: readonly DesignFact[]): IndexToken[] {
  const declared = new Map<string, IndexToken>();
  const observed = new Map<string, IndexToken>();

  for (const fact of facts) {
    const category = categoryOf(fact);
    if (category === undefined) continue;
    if (fact.kind === "token") {
      const path = tokenPath(category, fact.name);
      const value = normalizeValue(category, fact.value ?? "");
      if (value === "") continue;
      const existing = declared.get(path);
      if (existing) {
        existing.usages += 1;
        if (existing.sources.length < 16) existing.sources.push(sourceOf(fact));
        existing.factIds.push(fact.id);
        continue;
      }
      declared.set(path, {
        path,
        category,
        value,
        confidence: "declared",
        usages: 1,
        alias: isAlias(value),
        sources: [sourceOf(fact)],
        factIds: [fact.id],
        entryId: stableId("e", "token", path),
        ...(fact.detail?.["description"] !== undefined ? { description: fact.detail["description"] } : {}),
      });
      continue;
    }
    if (fact.kind !== "value") continue;
    const value = normalizeValue(category, fact.value ?? "");
    if (value === "" || isAlias(value)) continue;
    const key = `${category}:${value}`;
    const existing = observed.get(key);
    if (existing) {
      existing.usages += 1;
      if (existing.sources.length < 16) existing.sources.push(sourceOf(fact));
      if (existing.factIds.length < 64) existing.factIds.push(fact.id);
      continue;
    }
    const path = `${familyOf(category)}.observed.${slug(value)}`;
    observed.set(key, {
      path,
      category,
      value,
      confidence: "observed",
      usages: 1,
      alias: false,
      sources: [sourceOf(fact)],
      factIds: [fact.id],
      entryId: stableId("e", "token", path),
    });
  }

  // A declared token already covers a value; an observed cluster of the same
  // value in the same family is that token being used, not a second token.
  const declaredValues = new Set([...declared.values()].map((token) => `${token.category}:${token.value}`));
  const clustered = [...observed.values()]
    .filter((token) => !declaredValues.has(`${token.category}:${token.value}`))
    .filter((token) => token.usages >= OBSERVED_MIN_USAGES)
    .sort((left, right) => right.usages - left.usages || left.path.localeCompare(right.path));

  return [...[...declared.values()].sort((left, right) => left.path.localeCompare(right.path)), ...clustered].slice(0, MAX_TOKENS);
}

function sourceOf(fact: DesignFact): { path: string; digest?: string; excerpt?: string } {
  return {
    path: fact.source.path,
    ...(fact.source.digest !== "" ? { digest: fact.source.digest } : {}),
    ...(fact.source.excerpt !== undefined ? { excerpt: fact.source.excerpt } : {}),
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "value";
}

/** The DTCG document: groups from the dotted paths, tokens at the leaves. */
export function tokenDocument(tokens: readonly IndexToken[]): DesignTokenGroup {
  const document: DesignTokenGroup = {};
  for (const token of tokens) {
    const parts = token.path.split(".").filter((part) => part !== "");
    if (parts.length === 0) continue;
    // Six levels is the document's bound; deeper paths fold their tail into
    // one name rather than being dropped.
    const head = parts.slice(0, 5);
    const tail = parts.slice(5);
    const leafName = tail.length > 0 ? [head.pop() ?? "", ...tail].join("-") : head.pop() ?? "";
    let group = document;
    for (const part of head) {
      const next = group[part];
      if (next !== undefined && isToken(next)) break;
      const child = (next as DesignTokenGroup | undefined) ?? {};
      group[part] = child;
      group = child;
    }
    if (group[leafName] !== undefined) continue;
    const leaf: DesignToken = {
      $type: DTCG_TYPE[token.category],
      $value: token.value,
      ...(token.description !== undefined ? { $description: token.description } : {}),
      $extensions: {
        [TOKEN_EXTENSION_KEY]: {
          sources: token.sources.slice(0, 16),
          confidence: token.confidence,
          usages: token.usages,
          entryId: token.entryId,
        },
      },
    };
    group[leafName] = leaf;
  }
  return document;
}

function isToken(node: DesignToken | DesignTokenGroup): node is DesignToken {
  return Object.prototype.hasOwnProperty.call(node, "$value");
}

/** Every token of a document, flattened back to dotted paths. */
export function flattenTokenDocument(document: DesignTokenGroup, prefix: string[] = []): Array<{ path: string; token: DesignToken }> {
  const flat: Array<{ path: string; token: DesignToken }> = [];
  for (const [name, node] of Object.entries(document)) {
    if (isToken(node)) flat.push({ path: [...prefix, name].join("."), token: node });
    else flat.push(...flattenTokenDocument(node, [...prefix, name]));
  }
  return flat;
}
