/**
 * The structural outline of a host page, parsed as text (M21-T12).
 *
 * `docs/design-phase.md` asks for "a structural outline of the page (regions,
 * headings, lists, forms)" plus the partials and components it pulls in, each
 * with something an insertion region can anchor to. That is what a node is
 * here: a **role**, a **structural path** and a **text hash**.
 *
 * Two properties matter more than completeness, because a region anchors to
 * them:
 *
 * 1. **The path survives cosmetics.** Only structural elements take a path
 *    segment, so wrapping a section in another `div`, re-ordering its
 *    attributes or re-indenting the file does not move it.
 * 2. **The hash is the text, and only the text.** Attributes, tags, comments
 *    and template expressions are out; whitespace is collapsed. An attribute
 *    change leaves the hash alone; an edit to the words changes it, which is
 *    exactly the signal "this anchor is about something else now".
 *
 * The parse is tolerant on purpose: ERB, Blade, Jinja/Twig, SSI comments,
 * JSX, Vue and Svelte all reach it as text with unbalanced tags, and it
 * degrades to fewer nodes rather than throwing. Nothing is evaluated — a
 * template expression is erased, never run (D-353).
 */
import type { HostOutlineAnchor } from "@lasercode/protocol";
import type { HostPage } from "@lasercode/protocol";
import { stableId, type Gap } from "../index/facts.js";
import { basenameOf, hashText } from "./files.js";

export const HOST_OUTLINE_ROLES = [
  "template",
  "header",
  "navigation",
  "main",
  "aside",
  "footer",
  "section",
  "article",
  "heading",
  "list",
  "table",
  "form",
  "dialog",
  "component",
  "partial",
  "slot",
] as const;
export type HostOutlineRole = (typeof HOST_OUTLINE_ROLES)[number];

export interface HostOutlineNode {
  /** Stable for a template path and a structural path. */
  id: string;
  role: HostOutlineRole;
  label?: string;
  /** Depth inside its own template; the composed outline adds the file level. */
  depth: number;
  /** `/main[0]/section[1]/form[0]` — what an insertion region anchors to. */
  structuralPath: string;
  /** sha256 of the node's own text, whitespace-collapsed, expressions erased. */
  textHash: string;
  templatePath: string;
  /** 1-based line the node opens on, for "open source file". */
  line: number;
  /** For a partial or component node: the file it resolves to, when it does. */
  sourcePath?: string;
}

export interface HostOutline {
  /** The template the outline starts from, when there is one. */
  templatePath?: string;
  nodes: HostOutlineNode[];
  gaps: Gap[];
  /** True when the node budget stopped the parse. */
  truncated: boolean;
}

export interface OutlineOptions {
  /** How many nodes one template may contribute. */
  maxNodes?: number;
  /** A partial name → the file it renders, when the caller resolved it. */
  resolvePartial?: (name: string) => string | undefined;
  /** A component tag → the file it renders, when the caller resolved it. */
  resolveComponent?: (name: string) => string | undefined;
}

const DEFAULT_MAX_NODES = 400;
const LABEL_MAX = 200;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const TAG_ROLES: Record<string, HostOutlineRole> = {
  header: "header",
  nav: "navigation",
  main: "main",
  aside: "aside",
  footer: "footer",
  section: "section",
  article: "article",
  form: "form",
  table: "table",
  ul: "list",
  ol: "list",
  dl: "list",
  dialog: "dialog",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};

const PARTIAL_TAG = "host-partial";
const SLOT_TAG = "host-slot";

type TemplateSyntax = "erb" | "blade" | "jinja" | "jsx" | "vue" | "svelte" | "html";

/** Which template language this file is written in, by extension. */
export function templateSyntaxOf(path: string): TemplateSyntax {
  const lower = path.toLowerCase();
  if (lower.endsWith(".blade.php")) return "blade";
  if (/\.(erb|haml|slim)$/.test(lower)) return "erb";
  if (/\.(twig|jinja|jinja2|j2)$/.test(lower)) return "jinja";
  if (/\.(tsx|jsx|astro)$/.test(lower)) return "jsx";
  if (lower.endsWith(".vue")) return "vue";
  if (lower.endsWith(".svelte")) return "svelte";
  return "html";
}

/** True when this file is markup worth outlining at all. */
export function isMarkupPath(path: string): boolean {
  return /\.(html|htm|erb|haml|slim|twig|jinja|jinja2|j2|hbs|handlebars|ejs|liquid|blade\.php|vue|svelte|astro|tsx|jsx)$/i.test(path);
}

function partialTag(name: string): string {
  return `<${PARTIAL_TAG} data-name="${name.replace(/"/g, "")}"></${PARTIAL_TAG}>`;
}

function slotOpen(name: string): string {
  return `<${SLOT_TAG} data-name="${name.replace(/"/g, "")}">`;
}

/**
 * Template syntax out, structure in.
 *
 * Includes and yields become pseudo-tags so they take their place in the
 * outline; every other expression is replaced by a space. Replacing rather
 * than evaluating is the whole point: `<%= @invoice.total %>` contributes
 * nothing to the text hash, so a rename in the controller does not orphan an
 * anchor, and no project code is read for its value.
 */
export function normaliseTemplate(path: string, text: string): string {
  const syntax = templateSyntaxOf(path);
  let out = text;
  // SSI and comment includes, before comments are dropped wholesale.
  out = out.replace(/<!--\s*(?:#include\s+(?:file|virtual)\s*=\s*["']([^"']+)["']|@?include:?\s+([\w./-]+))\s*-->/g, (_match, file: string | undefined, name: string | undefined) =>
    partialTag(file ?? name ?? "include"),
  );
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  if (syntax === "vue" || syntax === "svelte") {
    out = out.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  }
  if (syntax === "erb") {
    out = out
      .replace(/<%=?-?\s*render\s*\(?\s*(?:partial:\s*)?["']([\w./-]+)["'][\s\S]*?%>/g, (_match, name: string) => partialTag(name))
      .replace(/<%=?-?\s*yield[^%]*%>/g, `${slotOpen("content")}</${SLOT_TAG}>`)
      .replace(/<%[\s\S]*?%>/g, " ");
  }
  if (syntax === "blade") {
    out = out
      .replace(/@(?:include|includeIf|includeWhen|includeFirst|each)\s*\(\s*\[?\s*["']([\w.\-/]+)["'][^)]*\)/g, (_match, name: string) => partialTag(name))
      .replace(/@yield\s*\(\s*["']([\w.\-]+)["'][^)]*\)/g, (_match, name: string) => `${slotOpen(name)}</${SLOT_TAG}>`)
      .replace(/@section\s*\(\s*["']([\w.\-]+)["']\s*,[^)]*\)/g, (_match, name: string) => `${slotOpen(name)}</${SLOT_TAG}>`)
      .replace(/@section\s*\(\s*["']([\w.\-]+)["']\s*\)/g, (_match, name: string) => slotOpen(name))
      // Only the directives that closed a pseudo-tag close one: `@endforeach`
      // ends a loop, not a section, and closing a section on it would cut the
      // outline in half.
      .replace(/@(?:endsection|stop|show)\b/g, `</${SLOT_TAG}>`)
      .replace(/@php[\s\S]*?@endphp/g, " ")
      .replace(/@[A-Za-z]+\s*(?:\([^)]*\))?/g, " ")
      .replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g, " ");
  }
  if (syntax === "jinja") {
    out = out
      .replace(/\{%-?\s*(?:include|import)\s+["']([^"']+)["'][^%]*%\}/g, (_match, name: string) => partialTag(name))
      .replace(/\{%-?\s*block\s+([\w-]+)[^%]*%\}/g, (_match, name: string) => slotOpen(name))
      .replace(/\{%-?\s*endblock[^%]*%\}/g, `</${SLOT_TAG}>`)
      .replace(/\{%[\s\S]*?%\}/g, " ")
      .replace(/\{\{[\s\S]*?\}\}/g, " ");
  }
  if (syntax === "vue") {
    out = out.replace(/\{\{[\s\S]*?\}\}/g, " ");
  }
  if (syntax === "svelte") {
    out = out.replace(/\{[#:/][\s\S]*?\}/g, " ").replace(/\{[^{}<>]*\}/g, " ");
  }
  if (syntax === "jsx") {
    // JSX keeps its braces: `{items.map(…)}` contains real markup, and the
    // scanner ignores everything that is not a tag anyway.
    out = out.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ").replace(/\{\s*children\s*\}/g, `${slotOpen("children")}</${SLOT_TAG}>`);
  }
  return out;
}

function attribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return pattern.exec(attributes)?.[1];
}

/** Tags out, entities left alone, whitespace collapsed. The hashed text. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roleOf(tag: string, attributes: string): HostOutlineRole | undefined {
  const lower = tag.toLowerCase();
  if (lower === PARTIAL_TAG) return "partial";
  if (lower === SLOT_TAG) return "slot";
  if (lower === "template") return undefined;
  const byRole = attribute(attributes, "role")?.toLowerCase();
  if (byRole === "dialog" || byRole === "alertdialog") return "dialog";
  if (byRole === "navigation") return "navigation";
  if (byRole === "main") return "main";
  if (byRole === "banner") return "header";
  if (byRole === "contentinfo") return "footer";
  const mapped = TAG_ROLES[lower];
  if (mapped !== undefined) return mapped;
  if (/^[A-Z]/.test(tag) || /^x-/.test(tag)) return "component";
  return undefined;
}

interface OpenFrame {
  tag: string;
  node: MutableNode | undefined;
}

interface MutableNode extends HostOutlineNode {
  contentStart: number;
  /** The node's own text, set when it closes. Labels are read from it. */
  text: string;
  childRoles: Map<HostOutlineRole, number>;
}

const TAG_PATTERN = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** One template's outline. Text in, nodes out; nothing else happens. */
export function outlineTemplate(file: { path: string; text: string }, options: OutlineOptions = {}): HostOutline {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const markup = normaliseTemplate(file.path, file.text);
  const nodes: MutableNode[] = [];
  const gaps: Gap[] = [];
  const stack: OpenFrame[] = [];
  const rootRoles = new Map<HostOutlineRole, number>();
  let truncated = false;

  const lineAt = (index: number): number => markup.slice(0, index).split("\n").length;

  const close = (node: MutableNode, end: number): void => {
    node.text = textOf(markup.slice(node.contentStart, Math.max(end, node.contentStart)));
    // A partial or a component contributes a name, not a body, so its name is
    // what is hashed: two different includes must not share one empty hash.
    const named = node.role === "partial" || node.role === "component" || node.role === "slot";
    node.textHash = hashText(named && node.text === "" ? `${node.role}:${node.label ?? ""}` : node.text);
  };

  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(markup)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2] ?? "";
    const attributes = match[3] ?? "";
    const lower = tag.toLowerCase();
    if (closing) {
      const index = [...stack].reverse().findIndex((frame) => frame.tag === lower);
      if (index === -1) continue;
      const cut = stack.length - 1 - index;
      for (let position = stack.length - 1; position >= cut; position -= 1) {
        const frame = stack[position];
        if (frame?.node) close(frame.node, match.index);
      }
      stack.length = cut;
      continue;
    }
    const selfClosing = attributes.trimEnd().endsWith("/") || VOID_TAGS.has(lower);
    const role = roleOf(tag, attributes);
    if (role === undefined) {
      if (!selfClosing) stack.push({ tag: lower, node: undefined });
      continue;
    }
    if (nodes.length >= maxNodes) {
      if (!truncated) {
        truncated = true;
        gaps.push({ path: file.path, reason: `this template has more structure than one outline carries (${String(maxNodes)} nodes); the rest is not outlined.` });
      }
      if (!selfClosing) stack.push({ tag: lower, node: undefined });
      continue;
    }
    const parent = [...stack].reverse().find((frame) => frame.node !== undefined)?.node;
    const siblings = parent?.childRoles ?? rootRoles;
    const ordinal = siblings.get(role) ?? 0;
    siblings.set(role, ordinal + 1);
    const structuralPath = `${parent?.structuralPath ?? ""}/${role}[${String(ordinal)}]`;
    const contentStart = match.index + match[0].length;
    const name = attribute(attributes, "data-name") ?? (role === "component" ? tag : undefined);
    const node: MutableNode = {
      id: stableId("hn", file.path, structuralPath),
      role,
      depth: parent === undefined ? 0 : parent.depth + 1,
      structuralPath,
      textHash: hashText(""),
      templatePath: file.path,
      line: lineAt(match.index),
      contentStart,
      text: "",
      childRoles: new Map(),
    };
    const label =
      name ??
      attribute(attributes, "aria-label") ??
      attribute(attributes, "id") ??
      (role === "form" ? attribute(attributes, "action") : undefined);
    if (label !== undefined && label !== "") node.label = label.slice(0, LABEL_MAX);
    const source = role === "partial" && name !== undefined ? options.resolvePartial?.(name) : role === "component" && name !== undefined ? options.resolveComponent?.(name) : undefined;
    if (source !== undefined) node.sourcePath = source;
    nodes.push(node);
    // A self-closing node is closed where it opened: it has no body.
    if (selfClosing) close(node, contentStart);
    else stack.push({ tag: lower, node });
  }
  for (const frame of stack) if (frame.node) close(frame.node, markup.length);

  // A heading is named by its own words, once its own text is known.
  for (const node of nodes) {
    if (node.label !== undefined || node.role !== "heading" || node.text === "") continue;
    node.label = node.text.slice(0, LABEL_MAX);
  }

  return {
    templatePath: file.path,
    nodes: nodes.map(({ contentStart: _start, childRoles: _roles, text: _text, ...node }) => node),
    gaps,
    truncated,
  };
}

export interface ComposeOutlineInput {
  /** Outermost layout first, then the page's own template, then partials. */
  files: ReadonlyArray<{ path: string; text: string }>;
  options?: OutlineOptions;
  /** How many nodes the composed outline may carry, protocol bound included. */
  maxNodes?: number;
}

const COMPOSED_MAX_NODES = 500;

/**
 * One outline for the whole page: a `template` node per file, its structure
 * beneath it.
 *
 * The files are kept apart on purpose. A region records `{ templatePath,
 * structuralPath }`, so a path has to mean something inside one file — if the
 * layout and the view were spliced into a single tree, editing the layout
 * would renumber the view's anchors.
 */
export function composeHostOutline(input: ComposeOutlineInput): HostOutline {
  const budget = input.maxNodes ?? COMPOSED_MAX_NODES;
  const nodes: HostOutlineNode[] = [];
  const gaps: Gap[] = [];
  let truncated = false;
  for (const file of input.files) {
    if (nodes.length >= budget) {
      truncated = true;
      gaps.push({ path: file.path, reason: "the outline reached its node budget before this file; ground a narrower route to see it." });
      break;
    }
    const outline = outlineTemplate(file, { ...input.options, maxNodes: Math.min(input.options?.maxNodes ?? COMPOSED_MAX_NODES, budget - nodes.length) });
    gaps.push(...outline.gaps);
    truncated = truncated || outline.truncated;
    nodes.push({
      id: stableId("hn", file.path, "/"),
      role: "template",
      label: basenameOf(file.path),
      depth: 0,
      structuralPath: "/",
      textHash: hashText(textOf(normaliseTemplate(file.path, file.text))),
      templatePath: file.path,
      line: 1,
    });
    for (const node of outline.nodes) nodes.push({ ...node, depth: node.depth + 1 });
  }
  const first = input.files[0]?.path;
  return { ...(first !== undefined ? { templatePath: first } : {}), nodes: nodes.slice(0, budget), gaps, truncated };
}

/** The anchors of one template, for `resolveInsertionRegion`. */
export function outlineAnchors(outline: HostOutline, templatePath?: string): HostOutlineAnchor[] {
  return outline.nodes
    .filter((node) => templatePath === undefined || node.templatePath === templatePath)
    .map((node) => ({
      id: node.id,
      structuralPath: node.structuralPath,
      textHash: node.textHash,
      ...(node.label !== undefined ? { label: node.label } : {}),
    }));
}

/** The outline as a `HostPage` carries it. Bounded by the protocol's own cap. */
export function toProtocolOutline(outline: HostOutline): HostPage["outline"] {
  return outline.nodes.slice(0, COMPOSED_MAX_NODES).map((node) => ({
    id: node.id,
    role: node.role,
    ...(node.label !== undefined ? { label: node.label } : {}),
    depth: Math.min(node.depth, 32),
    structuralPath: node.structuralPath,
    textHash: node.textHash,
    ...(node.sourcePath !== undefined ? { sourcePath: node.sourcePath } : {}),
  }));
}

/** One node by its structural path, inside one template. */
export function outlineNodeAt(outline: HostOutline, templatePath: string, structuralPath: string): HostOutlineNode | undefined {
  return outline.nodes.find((node) => node.templatePath === templatePath && node.structuralPath === structuralPath);
}
