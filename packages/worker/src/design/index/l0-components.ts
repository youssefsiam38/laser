/**
 * L0 · the component inventory, from exports and prop types.
 *
 * What the docgen family does — react-docgen, vue-docgen, Svelte types,
 * Angular decorators — is read a component's *declaration* and its props. This
 * does the same by reading the source as text, which is what D-353 requires
 * and what keeps the parse free of a compiler, a module resolver and a
 * dependency tree.
 *
 * - An exported component whose props are typed is `declared`: the project
 *   states its contract.
 * - A component found only by its export, with untyped or runtime props, is
 *   `observed`, and the props that could not be read statically are a gap.
 * - Stories (`*.stories.*`), Ladle and Cosmos fixtures and MDX docs are parsed
 *   **as text** for examples; none of them is executed, so an example is
 *   whatever the file literally says, never what it would render.
 */
import { excerpt, factId, sourceAt, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";

/** A prop as the source declares it. */
export interface ParsedProp {
  name: string;
  type: string;
  required: boolean;
  /** String-union members: the component's variants. */
  options?: string[];
  defaultValue?: string;
  description?: string;
}

const COMPONENT_EXPORTS: readonly RegExp[] = [
  /export\s+default\s+function\s+([A-Z][\w$]*)/g,
  /export\s+function\s+([A-Z][\w$]*)/g,
  /export\s+const\s+([A-Z][\w$]*)\s*[:=]/g,
  /export\s+class\s+([A-Z][\w$]*)\s+extends\s+(?:React\.)?(?:Pure)?Component/g,
  /export\s*\{\s*([A-Z][\w$,\s]*)\}/g,
];

/** `.stories.`, `.story.`, Ladle and Cosmos fixtures — all read as text. */
export function isStoryPath(path: string): boolean {
  return /\.(stories|story)\.[jt]sx?$/.test(path) || /\.fixture\.[jt]sx?$/.test(path) || /\.(stories|story)\.(mdx|svelte|vue)$/.test(path);
}

export function isComponentSourcePath(path: string): boolean {
  if (isStoryPath(path)) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  return /\.(tsx|jsx|vue|svelte)$/.test(path) || (/\.[jt]s$/.test(path) && /components?\//i.test(path));
}

function statusOf(path: string, text: string, name: string): "active" | "deprecated" | "internal" {
  const declaration = new RegExp(`(?:@deprecated[^\\n]*\\n(?:[^\\n]*\\n){0,6}?)?(?:export[^\\n]*\\b${name}\\b)`).exec(text);
  const before = declaration ? text.slice(Math.max(0, declaration.index - 400), declaration.index + 80) : "";
  if (/@deprecated/.test(before)) return "deprecated";
  if (/(^|\/)(internal|private|_)[^/]*\//i.test(path) || name.startsWith("_")) return "internal";
  return "active";
}

/** The block of a `type X = {…}` / `interface X {…}` declaration, as text. */
function typeBlock(text: string, name: string): { body: string; offset: number } | undefined {
  const start = new RegExp(`(?:interface\\s+${name}\\s*(?:extends[^{]+)?|type\\s+${name}\\s*=\\s*)\\{`).exec(text);
  if (!start) return undefined;
  const open = text.indexOf("{", start.index);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), offset: open + 1 };
    }
  }
  return undefined;
}

/** Members of a TypeScript object type, as props. */
export function parseTypeMembers(body: string): ParsedProp[] {
  const props: ParsedProp[] = [];
  const lines = body.split(/\r?\n/);
  let pendingDoc: string | undefined;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^\/\*\*/.test(line)) {
      pendingDoc = line.replace(/^\/\*+\s*/, "").replace(/\s*\*+\/$/, "").trim();
      continue;
    }
    if (/^\*/.test(line)) {
      const text = line.replace(/^\*+\s?/, "").replace(/\s*\*+\/$/, "").trim();
      if (text !== "") pendingDoc = pendingDoc === undefined ? text : `${pendingDoc} ${text}`;
      continue;
    }
    if (/^\/\//.test(line)) continue;
    const member = /^(readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?);?$/.exec(line);
    const opens = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth > 0) {
      depth += opens;
      continue;
    }
    if (!member) {
      depth += Math.max(0, opens);
      continue;
    }
    depth += Math.max(0, opens);
    const name = member[2] ?? "";
    const type = (member[4] ?? "").trim();
    const options = type.includes("|")
      ? type
        .split("|")
        .map((part) => part.trim())
        .filter((part) => /^["'].*["']$/.test(part))
        .map((part) => part.slice(1, -1))
      : [];
    props.push({
      name,
      type: type.slice(0, 200),
      required: member[3] !== "?",
      ...(options.length > 0 ? { options } : {}),
      ...(pendingDoc !== undefined ? { description: pendingDoc.slice(0, 300) } : {}),
    });
    pendingDoc = undefined;
  }
  return props;
}

/** Destructuring defaults: `({ variant = "primary", size = "md" })`. */
function defaultsFor(text: string, name: string): Record<string, string> {
  const declaration = new RegExp(`\\b${name}\\b[^\\n]*?\\(\\s*\\{([^}]*)\\}`).exec(text);
  const defaults: Record<string, string> = {};
  if (!declaration) return defaults;
  for (const part of (declaration[1] ?? "").split(",")) {
    const assignment = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*$/.exec(part);
    if (assignment) defaults[assignment[1] ?? ""] = (assignment[2] ?? "").replace(/^["']|["']$/g, "").slice(0, 120);
  }
  return defaults;
}

function componentFact(file: SourceFile, name: string, line: number, props: ParsedProp[], typed: boolean, status: string, extra: Record<string, string> = {}): DesignFact {
  const variants = props.flatMap((prop) => (prop.options ?? []).map((option) => `${prop.name}=${option}`));
  return {
    id: factId("component", name, file.path),
    kind: "component",
    name,
    value: props.map((prop) => `${prop.name}${prop.required ? "" : "?"}: ${prop.type}`).join("; ").slice(0, 1800),
    detail: {
      status,
      typed: typed ? "true" : "false",
      props: String(props.length),
      ...(variants.length > 0 ? { variants: variants.join(", ").slice(0, 600) } : {}),
      ...extra,
    },
    source: sourceAt(file, line),
    confidence: typed ? "declared" : "observed",
  };
}

function lineOf(file: SourceFile, offset: number): number {
  return file.text.slice(0, offset).split(/\r?\n/).length - 1;
}

/** React / plain TS-JS components in one file. */
function parseReactFile(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const names = new Map<string, number>();
  for (const pattern of COMPONENT_EXPORTS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.text)) !== null) {
      for (const part of (match[1] ?? "").split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
        if (!/^[A-Z][\w$]*$/.test(name)) continue;
        if (!names.has(name)) names.set(name, match.index);
      }
    }
  }
  for (const [name, offset] of names) {
    const block = typeBlock(file.text, `${name}Props`) ?? typeBlock(file.text, "Props");
    const inline = /\(\s*\{[^}]*\}\s*:\s*\{([^}]*)\}\s*\)/.exec(file.text.slice(offset, offset + 1200));
    const props = block ? parseTypeMembers(block.body) : inline ? parseTypeMembers(inline[1] ?? "") : [];
    const defaults = defaultsFor(file.text, name);
    for (const prop of props) {
      const value = defaults[prop.name];
      if (value !== undefined) prop.defaultValue = value;
    }
    const typed = props.length > 0;
    facts.push(
      componentFact(file, name, lineOf(file, offset), props, typed, statusOf(file.path, file.text, name), {
        framework: /\.tsx$|\.jsx$/.test(file.path) ? "React" : "JavaScript",
        ...(Object.keys(defaults).length > 0 ? { defaults: Object.entries(defaults).map(([key, value]) => `${key}=${value}`).join(", ").slice(0, 400) } : {}),
      }),
    );
    for (const prop of props) {
      facts.push({
        id: factId("prop", `${name}.${prop.name}`, file.path),
        kind: "prop",
        name: `${name}.${prop.name}`,
        value: prop.type,
        detail: {
          component: name,
          required: prop.required ? "true" : "false",
          ...(prop.options ? { options: prop.options.join(", ").slice(0, 400) } : {}),
          ...(prop.defaultValue !== undefined ? { default: prop.defaultValue } : {}),
          ...(prop.description !== undefined ? { description: prop.description } : {}),
        },
        source: sourceAt(file, lineOf(file, offset)),
        confidence: "declared",
      });
    }
    // A component that takes no props has no contract to miss. The gap is for
    // one that clearly *has* props and does not say what they are.
    const takesProps = new RegExp(`\\b${name}\\b[^\\n]*\\(\\s*(?:\\{|props\\b)`).test(file.text);
    if (!typed && takesProps && !/\.jsx?$/.test(file.path)) {
      gaps.push({ path: file.path, reason: `${name}'s props are not declared in a type this parse can read, so the component is in the index without its contract.` });
    }
  }
  return { facts, gaps };
}

/** A Vue single-file component: `defineProps<{…}>()` or the options object. */
function parseVueFile(file: SourceFile): L0Result {
  const gaps: Gap[] = [];
  const name = (file.path.split("/").pop() ?? file.path).replace(/\.vue$/, "");
  const typed = /defineProps\s*<\s*\{/.exec(file.text);
  let props: ParsedProp[] = [];
  let declared = false;
  if (typed) {
    const open = file.text.indexOf("{", typed.index);
    let depth = 0;
    let close = open;
    for (let index = open; index < file.text.length; index += 1) {
      const character = file.text[index];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    props = parseTypeMembers(file.text.slice(open + 1, close));
    declared = props.length > 0;
  } else {
    const options = /defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(file.text) ?? /props\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(file.text);
    if (options) {
      const body = options[1] ?? "";
      const entries = /([A-Za-z_$][\w$]*)\s*:\s*\{([^}]*)\}/g;
      let entry: RegExpExecArray | null;
      while ((entry = entries.exec(body)) !== null) {
        const detail = entry[2] ?? "";
        const type = /type\s*:\s*([A-Za-z]+)/.exec(detail)?.[1] ?? "unknown";
        const required = /required\s*:\s*true/.test(detail);
        const fallback = /default\s*:\s*(["']?)([^,"'\n]*)\1/.exec(detail)?.[2];
        props.push({
          name: entry[1] ?? "",
          type: type.toLowerCase(),
          required,
          ...(fallback !== undefined ? { defaultValue: fallback } : {}),
        });
      }
      declared = props.length > 0;
    } else {
      gaps.push({ path: file.path, reason: `${name}'s props are built at runtime; the component is in the index without its contract.` });
    }
  }
  const facts: DesignFact[] = [
    componentFact(file, name, Math.max(0, file.lines.findIndex((line) => line.includes("<script"))), props, declared, statusOf(file.path, file.text, name), { framework: "Vue" }),
    ...props.map((prop): DesignFact => ({
      id: factId("prop", `${name}.${prop.name}`, file.path),
      kind: "prop",
      name: `${name}.${prop.name}`,
      value: prop.type,
      detail: {
        component: name,
        required: prop.required ? "true" : "false",
        ...(prop.options ? { options: prop.options.join(", ") } : {}),
        ...(prop.defaultValue !== undefined ? { default: prop.defaultValue } : {}),
        ...(prop.description !== undefined ? { description: prop.description } : {}),
      },
      source: sourceAt(file, Math.max(0, file.lines.findIndex((line) => line.includes(prop.name)))),
      confidence: "declared",
    })),
  ];
  return { facts, gaps };
}

/** A Svelte component: `export let x: T = default`. */
function parseSvelteFile(file: SourceFile): L0Result {
  const name = (file.path.split("/").pop() ?? file.path).replace(/\.svelte$/, "");
  const props: ParsedProp[] = [];
  const pattern = /export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=\n;]+))?(?:=\s*([^;\n]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(file.text)) !== null) {
    const type = (match[2] ?? "unknown").trim();
    const options = type.includes("|")
      ? type.split("|").map((part) => part.trim()).filter((part) => /^["'].*["']$/.test(part)).map((part) => part.slice(1, -1))
      : [];
    props.push({
      name: match[1] ?? "",
      type: type.slice(0, 200),
      required: match[3] === undefined,
      ...(options.length > 0 ? { options } : {}),
      ...(match[3] !== undefined ? { defaultValue: match[3].trim().replace(/^["']|["']$/g, "") } : {}),
    });
  }
  const facts: DesignFact[] = [componentFact(file, name, 0, props, props.some((prop) => prop.type !== "unknown"), statusOf(file.path, file.text, name), { framework: "Svelte" })];
  return { facts, gaps: [] };
}

/** One component source file, whatever its framework. */
export function parseComponentFile(file: SourceFile): L0Result {
  if (file.path.endsWith(".vue")) return parseVueFile(file);
  if (file.path.endsWith(".svelte")) return parseSvelteFile(file);
  return parseReactFile(file);
}

/**
 * A story file, as text: which component it documents and which examples it
 * names, with the args each example sets. Nothing is rendered.
 */
export function parseStoryFile(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const title = /title\s*:\s*["'`]([^"'`]+)["'`]/.exec(file.text)?.[1];
  const component = /component\s*:\s*([A-Za-z_$][\w$]*)/.exec(file.text)?.[1];
  const subject = component ?? title?.split("/").pop() ?? (file.path.split("/").pop() ?? file.path).replace(/\.(stories|story|fixture)\.[jt]sx?$/, "");
  const exports_ = /export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/g;
  let match: RegExpExecArray | null;
  while ((match = exports_.exec(file.text)) !== null) {
    const name = match[1] ?? "";
    if (name === "default" || name === "meta") continue;
    const after = file.text.slice(match.index, match.index + 600);
    const args = /args\s*:\s*\{([^}]*)\}/.exec(after)?.[1];
    facts.push({
      id: factId("example", `${subject}.${name}`, file.path),
      kind: "example",
      name: `${subject}.${name}`,
      value: args ? excerpt(args) : "",
      detail: {
        component: subject,
        example: name,
        form: "story",
        ...(title !== undefined ? { title } : {}),
      },
      source: sourceAt(file, lineOf(file, match.index)),
      confidence: "declared",
    });
  }
  if (facts.length === 0) gaps.push({ path: file.path, reason: "this story file names no exported example this parse could read." });
  return { facts, gaps };
}

/** MDX documentation: headings and the components it mentions. */
export function parseMdxDoc(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const headings = file.lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => /^#{1,3}\s+\S/.test(entry.line));
  for (const heading of headings.slice(0, 40)) {
    const title = heading.line.replace(/^#+\s*/, "").trim();
    facts.push({
      id: factId("doc", title, file.path),
      kind: "doc",
      name: title.slice(0, 200),
      value: excerpt(file.lines.slice(heading.index + 1, heading.index + 4).join(" ")),
      detail: { form: "mdx" },
      source: sourceAt(file, heading.index, Math.min(heading.index + 3, file.lines.length - 1)),
      confidence: "declared",
    });
  }
  return { facts, gaps: [] };
}
