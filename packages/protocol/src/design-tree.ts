/**
 * The `DesignTree` rules that are not shape rules (M21-T11, D-354).
 *
 * `project-work-bodies.ts` says what a design body *is*; this says what it may
 * **mean**. Two of the three rules cannot be expressed as a zod shape:
 *
 * 1. **Nothing executable.** A prop record accepts any name, so the schema
 *    cannot refuse `onClick`, and a text value accepts any string, so it
 *    cannot refuse `<script>`, `javascript:` or a CSS block. That refusal is
 *    here, as one pure pass over the tree, and it is the pass the composer
 *    tool, the workspace inspector and the renderer all run.
 * 2. **The graph is a tree.** Unique stable ids, one parent per node, no
 *    cycle, everything reachable from the root.
 * 3. **Declarative actions only.** Every flow action is one of the seven the
 *    contract lists, and points at a screen or node this design has.
 *
 * Everything in this file is pure: no DOM, no React, no I/O. The UI renderer
 * needs the DTCG flattener too, and the UI may not import the worker, so the
 * flattener lives beside the document it flattens rather than being copied.
 */
import {
  DESIGN_FIDELITIES,
  designBodySchema,
  type DesignAction,
  type DesignBody,
  type DesignFidelity,
  type DesignFlowEdge,
  type DesignNode,
  type DesignPropValue,
  type DesignScreen,
  type DesignToken,
  type DesignTokenGroup,
} from "./project-work-bodies.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const DESIGN_TREE_ISSUE_CODES = [
  "id_shape",
  "duplicate_id",
  "missing_root",
  "missing_child",
  "multiple_parents",
  "cycle",
  "unreachable",
  "event_handler",
  "raw_markup",
  "raw_css",
  "script_url",
  "unvalidated_url",
  "unknown_token",
  "unknown_entry",
  "unknown_primitive",
  "unknown_screen",
  "unknown_node",
  "unknown_fidelity",
] as const;
export type DesignTreeIssueCode = (typeof DESIGN_TREE_ISSUE_CODES)[number];

export interface DesignTreeIssue {
  code: DesignTreeIssueCode;
  /** Where it is, in the body's own terms: `screens[2].nodes[7].props.href`. */
  path: string;
  /** One sentence, written for a person: what is wrong and what to do. */
  message: string;
  /** The value a refusal offers instead, when there is a nearest one. */
  suggestion?: string;
}

export interface DesignTreeValidation {
  ok: boolean;
  issues: DesignTreeIssue[];
}

/** What the tree is allowed to reference. Every field is optional: with none of
 * them the pass still refuses everything executable, and only stops checking
 * that a reference exists. */
export interface DesignTreeVocabulary {
  /** Token ids the index (or the foundation) offers. */
  tokenIds?: Iterable<string>;
  /** Index entry ids the design may compose from. */
  entryIds?: Iterable<string>;
  /** The primitive kit's names. */
  primitives?: Iterable<string>;
  /** Fixture ids this revision carries. */
  fixtureIds?: Iterable<string>;
}

/** A prop name that would be a handler in any renderer. */
const HANDLER_NAME = /^on[A-Z]/;

/** Prop names that carry markup, styling or a document in every framework. */
const FORBIDDEN_PROP_NAMES = new Set([
  "dangerouslysetinnerhtml",
  "innerhtml",
  "outerhtml",
  "srcdoc",
  "style",
  "classname",
  "class",
  "script",
  "csstext",
  "sandbox",
  "ref",
  "key",
]);

/** `<a>`, `</div>`, `<img …/>` — markup, wherever it appears. */
const MARKUP = /<\s*\/?[a-zA-Z][^>]*>/;
/** `<script`, `</script`, with or without a closing bracket. */
const SCRIPT = /<\s*\/?\s*script\b/i;
/** A CSS rule or at-rule: `a{color:red}`, `@import …`, `expression(…)`. */
const CSS_BLOCK = /(\{[^}]*:[^}]*\})|(^|\s)@(import|media|font-face|charset)\b|expression\s*\(/i;
/** A scheme this app will not follow, in any casing or with padding. */
const DANGEROUS_SCHEME = /^[\s\u0000-\u001f]*(javascript|vbscript|data|file|blob|about)\s*:/i;
/** Anything that looks like it wants to be fetched. */
const URLISH = /^[\s\u0000-\u001f]*([a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;
/** The schemes a design may name. */
const ALLOWED_SCHEME = /^(https?|mailto|tel):/i;

function looksExecutable(value: string): DesignTreeIssueCode | undefined {
  if (SCRIPT.test(value)) return "raw_markup";
  if (MARKUP.test(value)) return "raw_markup";
  if (DANGEROUS_SCHEME.test(value)) return "script_url";
  if (CSS_BLOCK.test(value)) return "raw_css";
  return undefined;
}

function urlIssue(value: string): DesignTreeIssueCode | undefined {
  if (DANGEROUS_SCHEME.test(value)) return "script_url";
  if (!URLISH.test(value)) return undefined; // a relative path is fine.
  if (!ALLOWED_SCHEME.test(value.trim())) return "unvalidated_url";
  return undefined;
}

const URL_PROP_NAME = /^(href|src|url|link|action|poster|image|icon)$/i;

function issueMessage(code: DesignTreeIssueCode, where: string): string {
  switch (code) {
    case "raw_markup":
      return `${where} carries markup. A design node is composed from the kit and the index, never from HTML.`;
    case "raw_css":
      return `${where} carries a style rule. Styling comes from token references, never from CSS written into a node.`;
    case "script_url":
      return `${where} points at a scheme this app will not follow. Use an https address, a mail or tel link, or a path inside the project.`;
    case "unvalidated_url":
      return `${where} points at a scheme this app does not validate. Use https, mailto, tel, or a path inside the project.`;
    case "event_handler":
      return `${where} is an event handler. Interactivity in a design is a declarative flow, never a handler on a node.`;
    default:
      return `${where} is not allowed here.`;
  }
}

function checkPropValue(path: string, name: string, value: DesignPropValue, vocabulary: DesignTreeVocabulary, issues: DesignTreeIssue[]): void {
  const where = `\`${name}\``;
  if (value.type === "text" || value.type === "choice") {
    const executable = looksExecutable(value.value);
    if (executable) {
      issues.push({ code: executable, path, message: issueMessage(executable, where) });
      return;
    }
    if (URL_PROP_NAME.test(name) || URLISH.test(value.value)) {
      const url = urlIssue(value.value);
      if (url) issues.push({ code: url, path, message: issueMessage(url, where) });
    }
    return;
  }
  if (value.type === "token") {
    const tokens = vocabulary.tokenIds ? [...vocabulary.tokenIds] : undefined;
    if (tokens && !tokens.includes(value.tokenId)) {
      const suggestion = suggestNearestToken(value.tokenId, tokens);
      issues.push({
        code: "unknown_token",
        path,
        message: `${where} names a token this design's index does not have.`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
    return;
  }
  if (value.type === "fixture" && vocabulary.fixtureIds) {
    const fixtures = [...vocabulary.fixtureIds];
    if (!fixtures.includes(value.fixtureId)) {
      issues.push({ code: "unknown_token", path, message: `${where} binds to a fixture this revision does not carry.` });
    }
  }
}

function checkNode(path: string, node: DesignNode, vocabulary: DesignTreeVocabulary, issues: DesignTreeIssue[]): void {
  for (const [name, value] of Object.entries(node.props)) {
    const lowered = name.toLowerCase();
    if (HANDLER_NAME.test(name)) {
      issues.push({ code: "event_handler", path: `${path}.props.${name}`, message: issueMessage("event_handler", `\`${name}\``) });
      continue;
    }
    if (FORBIDDEN_PROP_NAMES.has(lowered)) {
      const code: DesignTreeIssueCode = lowered === "style" || lowered === "csstext" ? "raw_css" : "raw_markup";
      issues.push({ code, path: `${path}.props.${name}`, message: issueMessage(code, `\`${name}\``) });
      continue;
    }
    checkPropValue(`${path}.props.${name}`, name, value, vocabulary, issues);
  }
  if (node.text !== undefined) {
    const executable = looksExecutable(node.text);
    if (executable) issues.push({ code: executable, path: `${path}.text`, message: issueMessage(executable, "This node's text") });
  }
  if ("indexEntryId" in node.component && vocabulary.entryIds) {
    const entries = [...vocabulary.entryIds];
    if (!entries.includes(node.component.indexEntryId)) {
      issues.push({ code: "unknown_entry", path: `${path}.component`, message: "This node is composed from an index entry the index no longer has." });
    }
  }
  if ("primitive" in node.component && vocabulary.primitives) {
    const primitives = [...vocabulary.primitives];
    if (!primitives.includes(node.component.primitive)) {
      const suggestion = suggestNearestToken(node.component.primitive, primitives);
      issues.push({
        code: "unknown_primitive",
        path: `${path}.component`,
        message: `This node draws \`${node.component.primitive}\`, which the kit does not have.`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }
  if (!(DESIGN_FIDELITIES as readonly string[]).includes(node.fidelity)) {
    issues.push({ code: "unknown_fidelity", path: `${path}.fidelity`, message: "A design node is Sketch, Mapped or Proposed. Native is Build evidence." });
  }
}

export interface DesignTreeInput {
  rootNodeId: string;
  nodes: readonly DesignNode[];
}

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One screen's tree: a non-executable, single-rooted graph of stable ids.
 *
 * The pass is deliberately total — it collects every issue rather than
 * stopping at the first — because the composer tool returns them all and the
 * inspector shows them beside the node they belong to.
 */
export function validateDesignTree(tree: DesignTreeInput, vocabulary: DesignTreeVocabulary = {}, pathPrefix = "tree"): DesignTreeValidation {
  const issues: DesignTreeIssue[] = [];
  const byId = new Map<string, DesignNode>();
  tree.nodes.forEach((node, index) => {
    const path = `${pathPrefix}.nodes[${String(index)}]`;
    if (!ID_SHAPE.test(node.id)) {
      issues.push({ code: "id_shape", path: `${path}.id`, message: "A node id is a stable id this app minted, so a comment anchored to it survives an edit." });
    }
    if (byId.has(node.id)) {
      issues.push({ code: "duplicate_id", path: `${path}.id`, message: `Two nodes share the id \`${node.id}\`; an anchor could not tell them apart.` });
      return;
    }
    byId.set(node.id, node);
  });

  const parents = new Map<string, string[]>();
  tree.nodes.forEach((node, index) => {
    const path = `${pathPrefix}.nodes[${String(index)}]`;
    checkNode(path, node, vocabulary, issues);
    for (const child of node.children) {
      if (!byId.has(child)) {
        issues.push({ code: "missing_child", path: `${path}.children`, message: `This node names the child \`${child}\`, which this screen does not have.` });
        continue;
      }
      parents.set(child, [...(parents.get(child) ?? []), node.id]);
    }
  });

  for (const [child, owners] of parents) {
    if (owners.length > 1) {
      issues.push({
        code: "multiple_parents",
        path: `${pathPrefix}.nodes`,
        message: `\`${child}\` is a child of ${String(owners.length)} nodes. A screen is a tree, so each node has one parent.`,
      });
    }
  }

  if (!byId.has(tree.rootNodeId)) {
    issues.push({ code: "missing_root", path: `${pathPrefix}.rootNodeId`, message: "The screen's root node is not one of its nodes." });
    return { ok: issues.length === 0, issues };
  }

  // Reachability and cycles in one walk from the root.
  const seen = new Set<string>();
  const stack: Array<{ id: string; ancestry: readonly string[] }> = [{ id: tree.rootNodeId, ancestry: [] }];
  let cycle = false;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.ancestry.includes(current.id)) {
      cycle = true;
      issues.push({ code: "cycle", path: `${pathPrefix}.nodes`, message: `\`${current.id}\` contains itself. A screen is a tree, so nothing may be its own ancestor.` });
      continue;
    }
    seen.add(current.id);
    const node = byId.get(current.id);
    if (!node) continue;
    const ancestry = [...current.ancestry, current.id];
    for (const child of node.children) {
      if (byId.has(child)) stack.push({ id: child, ancestry });
    }
  }
  if (!cycle) {
    for (const node of tree.nodes) {
      if (!seen.has(node.id)) {
        issues.push({
          code: "unreachable",
          path: `${pathPrefix}.nodes`,
          message: `\`${node.id}\` hangs off nothing: it is not the root and no node has it as a child.`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Every action the prototype may carry. Nothing else is executable at all. */
export const DESIGN_ACTION_TYPES = ["navigate", "overlay", "close", "setState", "setVariant", "switchTheme", "switchViewport"] as const;

/** The whole body: every screen's tree, plus the flows between them. */
export function validateDesignBody(body: DesignBody, vocabulary: DesignTreeVocabulary = {}): DesignTreeValidation {
  const issues: DesignTreeIssue[] = [];
  const nodeIds = new Set<string>();
  const screenIds = new Set(body.screens.map((screen) => screen.id));
  const fixtureIds = vocabulary.fixtureIds ?? body.fixtures.map((fixture) => fixture.id);

  body.screens.forEach((screen, index) => {
    if (!("tree" in screen.content)) return;
    const result = validateDesignTree(screen.content.tree, { ...vocabulary, fixtureIds }, `screens[${String(index)}]`);
    issues.push(...result.issues);
    for (const node of screen.content.tree.nodes) nodeIds.add(node.id);
  });

  body.flows.forEach((flow, index) => {
    const path = `flows[${String(index)}]`;
    if (!(DESIGN_ACTION_TYPES as readonly string[]).includes(flow.action.type)) {
      issues.push({ code: "unknown_screen", path, message: "A flow action is one of the declarative seven; a design carries no script." });
      return;
    }
    if (!screenIds.has(flow.fromScreenId)) {
      issues.push({ code: "unknown_screen", path: `${path}.fromScreenId`, message: "This flow starts on a screen this design does not have." });
    }
    if (flow.fromNodeId !== undefined && nodeIds.size > 0 && !nodeIds.has(flow.fromNodeId)) {
      issues.push({ code: "unknown_node", path: `${path}.fromNodeId`, message: "This flow starts on a node this design does not have." });
    }
    const action = flow.action;
    if ((action.type === "navigate" || action.type === "overlay") && !screenIds.has(action.screenId)) {
      issues.push({ code: "unknown_screen", path: `${path}.action`, message: "This flow points at a screen this design does not have." });
    }
    if ((action.type === "setState" || action.type === "setVariant") && nodeIds.size > 0 && !nodeIds.has(action.nodeId)) {
      issues.push({ code: "unknown_node", path: `${path}.action`, message: "This flow changes a node this design does not have." });
    }
  });

  return { ok: issues.length === 0, issues };
}

/** The conservative aggregate for one screen: its least grounded node decides. */
export function screenFidelity(screen: DesignScreen): DesignFidelity {
  if (!("tree" in screen.content)) return "sketch";
  const nodes = screen.content.tree.nodes;
  if (nodes.some((node) => node.fidelity === "sketch")) return "sketch";
  if (nodes.some((node) => node.fidelity === "proposed")) return "proposed";
  return "mapped";
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface DesignBodyMigration {
  body: DesignBody;
  /** What had to change, in the person's words. Empty when nothing did. */
  changes: string[];
}

/** Fields a renderer once put on a node and a protocol body must never carry. */
const RENDERER_FIELDS = ["className", "class", "style", "onClick", "onChange", "onSubmit", "ref", "key", "dangerouslySetInnerHTML", "html", "jsx"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a design body written by an older generation of this app.
 *
 * Three things have changed since the first shape and each is repaired rather
 * than refused, because a stored revision is history and history is not
 * rewritten by dropping it:
 *
 * - `fidelity: "native"` predates D-353. Native is Build evidence, never a
 *   Design record, so it reads as `proposed` and says so.
 * - React-shaped node fields (`className`, `style`, `onClick`, …) were never
 *   valid and are dropped, named one by one.
 * - `screens[].nodes` without a `content` wrapper is the pre-Sketch shape.
 *
 * A body already in the current shape comes back byte-identical: the helper is
 * idempotent, which is what makes a round-trip test meaningful.
 */
export function migrateDesignBody(value: unknown): DesignBodyMigration {
  const changes: string[] = [];
  if (!isRecord(value)) return { body: designBodySchema.parse(value) as DesignBody, changes };

  const draft: Record<string, unknown> = { ...value };

  const fixFidelity = (holder: Record<string, unknown>, where: string): void => {
    if (holder["fidelity"] === "native") {
      holder["fidelity"] = "proposed";
      changes.push(`${where} said Native, which is Build evidence rather than a design record; it now reads Proposed.`);
    }
  };
  fixFidelity(draft, "This design");

  const screens = Array.isArray(draft["screens"]) ? draft["screens"] : [];
  draft["screens"] = screens.map((rawScreen: unknown, index: number) => {
    if (!isRecord(rawScreen)) return rawScreen;
    const screen: Record<string, unknown> = { ...rawScreen };
    const name = typeof screen["name"] === "string" ? screen["name"] : `Screen ${String(index + 1)}`;
    fixFidelity(screen, `The screen “${name}”`);
    if (!isRecord(screen["content"])) {
      if (Array.isArray(screen["nodes"]) && typeof screen["rootNodeId"] === "string") {
        screen["content"] = { tree: { rootNodeId: screen["rootNodeId"], nodes: screen["nodes"] } };
        delete screen["nodes"];
        delete screen["rootNodeId"];
        changes.push(`The screen “${name}” was stored before a screen could be a sketch; its nodes moved under \`content.tree\`.`);
      } else if (typeof screen["sketchId"] === "string") {
        screen["content"] = { sketchId: screen["sketchId"] };
        delete screen["sketchId"];
        changes.push(`The screen “${name}” now names its sketch under \`content\`.`);
      }
    }
    if (!Array.isArray(screen["states"])) screen["states"] = [];
    const content = screen["content"];
    if (isRecord(content) && isRecord(content["tree"])) {
      const tree = content["tree"];
      const nodes = Array.isArray(tree["nodes"]) ? tree["nodes"] : [];
      tree["nodes"] = nodes.map((rawNode: unknown) => {
        if (!isRecord(rawNode)) return rawNode;
        const node: Record<string, unknown> = { ...rawNode };
        fixFidelity(node, `The node \`${String(node["id"] ?? "?")}\``);
        for (const field of RENDERER_FIELDS) {
          if (field in node) {
            delete node[field];
            changes.push(`The node \`${String(node["id"] ?? "?")}\` carried \`${field}\`, which a design body never holds; it was dropped.`);
          }
        }
        if (isRecord(node["props"])) {
          const props: Record<string, unknown> = { ...node["props"] };
          for (const propName of Object.keys(props)) {
            if (HANDLER_NAME.test(propName) || FORBIDDEN_PROP_NAMES.has(propName.toLowerCase())) {
              delete props[propName];
              changes.push(`The node \`${String(node["id"] ?? "?")}\` carried the prop \`${propName}\`, which is not composable; it was dropped.`);
            }
          }
          node["props"] = props;
        } else {
          node["props"] = {};
        }
        if (!Array.isArray(node["children"])) node["children"] = [];
        return node;
      });
    }
    return screen;
  });

  for (const list of ["flows", "sketches", "fixtures"] as const) {
    if (!Array.isArray(draft[list])) draft[list] = [];
  }

  const body = designBodySchema.parse(draft) as DesignBody;
  return { body, changes };
}

// ---------------------------------------------------------------------------
// DTCG tokens → CSS custom properties
// ---------------------------------------------------------------------------

/** The prefix every design token gets inside a frame's shadow root. */
export const DESIGN_TOKEN_PROPERTY_PREFIX = "--design-";

export interface FlatDesignToken {
  /** The DTCG path, dotted: `color.brand.500`. */
  path: string;
  /** The CSS custom property name: `--design-color-brand-500`. */
  property: string;
  /** The value, as CSS. An alias becomes `var(--design-…)`. */
  value: string;
  type?: string;
  description?: string;
}

export interface DesignTokenFlattening {
  tokens: FlatDesignToken[];
  /** Tokens that could not become a custom property, and why. */
  skipped: Array<{ path: string; reason: string }>;
}

function isToken(node: DesignToken | DesignTokenGroup): node is DesignToken {
  return typeof node === "object" && node !== null && "$value" in node;
}

/** `color.brand.500` → `--design-color-brand-500`, lowercased and safe. */
export function designTokenProperty(path: string): string {
  const safe = path
    .split(".")
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("-");
  return `${DESIGN_TOKEN_PROPERTY_PREFIX}${safe}`;
}

/**
 * A value that could close a declaration and open another one is not a token
 * value: it is an injection. Tokens come from a parsed index, and a parser can
 * be fed anything, so the frame refuses these rather than trusting the source.
 */
function unsafeValue(value: string): string | undefined {
  if (/[;{}]/.test(value)) return "it contains a character that would end the declaration";
  if (/url\s*\(/i.test(value)) return "it loads something from outside the design";
  if (/expression\s*\(/i.test(value)) return "it is a legacy CSS expression";
  if (/@import/i.test(value)) return "it imports a stylesheet";
  if (/<\s*\/?[a-zA-Z]/.test(value)) return "it contains markup";
  return undefined;
}

/** `{color.brand.500}` → `var(--design-color-brand-500)`. */
function resolveAliases(value: string): string {
  return value.replace(/\{([^}]+)\}/g, (_match, path: string) => `var(${designTokenProperty(path.trim())})`);
}

function composeValue(token: DesignToken): { value: string } | { reason: string } {
  const raw = token.$value;
  if (typeof raw === "number") return { value: String(raw) };
  if (typeof raw === "string") {
    // An alias is kept as an alias: resolving it would state a value the
    // project never wrote (the index keeps aliases for the same reason).
    const aliased = /^\{[^}]+\}$/.test(raw.trim()) ? `var(${designTokenProperty(raw.trim().slice(1, -1))})` : resolveAliases(raw);
    const unsafe = unsafeValue(aliased);
    return unsafe ? { reason: unsafe } : { value: aliased };
  }
  if (raw && typeof raw === "object") {
    const parts: string[] = [];
    const order = ["offsetX", "offsetY", "blur", "spread", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"];
    const keys = [...order.filter((key) => key in raw), ...Object.keys(raw).filter((key) => !order.includes(key))];
    for (const key of keys) {
      const part = raw[key];
      if (part === undefined) continue;
      parts.push(typeof part === "number" ? String(part) : resolveAliases(part));
    }
    if (parts.length === 0) return { reason: "it holds no value" };
    const composed = parts.join(" ");
    const unsafe = unsafeValue(composed);
    return unsafe ? { reason: unsafe } : { value: composed };
  }
  return { reason: "it holds no value" };
}

/** Every token of a DTCG document, flattened to a CSS custom property. */
export function flattenDesignTokens(document: DesignTokenGroup | undefined, prefix: readonly string[] = []): DesignTokenFlattening {
  const tokens: FlatDesignToken[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  if (!document) return { tokens, skipped };
  for (const [name, node] of Object.entries(document)) {
    if (name.startsWith("$")) continue; // `$description` and friends on a group.
    const path = [...prefix, name];
    const dotted = path.join(".");
    if (isToken(node)) {
      const composed = composeValue(node);
      if ("reason" in composed) {
        skipped.push({ path: dotted, reason: composed.reason });
        continue;
      }
      tokens.push({
        path: dotted,
        property: designTokenProperty(dotted),
        value: composed.value,
        ...(node.$type !== undefined ? { type: node.$type } : {}),
        ...(node.$description !== undefined ? { description: node.$description } : {}),
      });
    } else {
      const nested = flattenDesignTokens(node, path);
      tokens.push(...nested.tokens);
      skipped.push(...nested.skipped);
    }
  }
  return { tokens, skipped };
}

/** The custom properties a frame's shadow root carries, ready for `style`. */
export function designTokenCustomProperties(document: DesignTokenGroup | undefined): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const token of flattenDesignTokens(document).tokens) properties[token.property] = token.value;
  return properties;
}

// ---------------------------------------------------------------------------
// The nearest token
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_value, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row, ...Array.from({ length: columns - 1 }, () => 0)];
    for (let column = 1; column < columns; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1);
      const deletion = (previous[column] ?? 0) + 1;
      const insertion = (current[column - 1] ?? 0) + 1;
      current[column] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[columns - 1] ?? Math.max(a.length, b.length);
}

/**
 * The token a refused free value should become.
 *
 * Names compare by edit distance on the dotted path; colours and dimensions
 * compare by value, because "#1f2938" is nearest to the token whose value is
 * "#1f2937" and no amount of string distance on names will say so.
 */
export function suggestNearestToken(wanted: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates];
  if (list.length === 0) return undefined;
  const needle = wanted.trim().toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const candidate of list) {
    const score = editDistance(needle, candidate.toLowerCase());
    if (!best || score < best.score) best = { id: candidate, score };
  }
  if (!best) return undefined;
  // A suggestion nobody would accept is worse than none at all.
  return best.score <= Math.max(3, Math.ceil(needle.length * 0.6)) ? best.id : undefined;
}

/** Parse `#abc`, `#aabbcc`, `rgb(…)` to comparable channels. Pure, bounded. */
function channels(value: string): [number, number, number] | undefined {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1] ?? "";
    const full = digits.length === 3 ? digits.split("").map((d) => d + d).join("") : digits;
    return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (rgb) return [Number.parseFloat(rgb[1] ?? "0"), Number.parseFloat(rgb[2] ?? "0"), Number.parseFloat(rgb[3] ?? "0")];
  return undefined;
}

function dimension(value: string): number | undefined {
  const match = /^(-?[\d.]+)(px|rem|em|%)?$/.exec(value.trim());
  if (!match) return undefined;
  const size = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(size)) return undefined;
  return match[2] === "rem" || match[2] === "em" ? size * 16 : size;
}

/**
 * The token nearest a free value a person typed, by what the value *is*.
 *
 * This is the other half of "free values are refused with the nearest token
 * suggested" (`docs/design-phase.md`, Case B): the refusal names a token, and
 * the person applies it with one click.
 */
export function suggestTokenForValue(value: string, tokens: readonly FlatDesignToken[]): FlatDesignToken | undefined {
  const wantedColour = channels(value);
  if (wantedColour) {
    let best: { token: FlatDesignToken; distance: number } | undefined;
    for (const token of tokens) {
      const candidate = channels(token.value);
      if (!candidate) continue;
      const distance = Math.hypot(wantedColour[0] - candidate[0], wantedColour[1] - candidate[1], wantedColour[2] - candidate[2]);
      if (!best || distance < best.distance) best = { token, distance };
    }
    return best?.token;
  }
  const wantedSize = dimension(value);
  if (wantedSize !== undefined) {
    let best: { token: FlatDesignToken; distance: number } | undefined;
    for (const token of tokens) {
      const candidate = dimension(token.value);
      if (candidate === undefined) continue;
      const distance = Math.abs(wantedSize - candidate);
      if (!best || distance < best.distance) best = { token, distance };
    }
    return best?.token;
  }
  const byName = suggestNearestToken(value, tokens.map((token) => token.path));
  return tokens.find((token) => token.path === byName);
}

/** Every action type, for a surface that has to enumerate them. */
export type { DesignAction, DesignFlowEdge };
