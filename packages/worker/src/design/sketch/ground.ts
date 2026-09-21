/**
 * Ground it: one Sketch becomes a Tree (M21-T13, `docs/design-phase.md`
 * "Sketch", D-354).
 *
 * A Sketch is model-written HTML/JS that only ever renders inside a sandboxed
 * frame. Grounding is the one door out of that frame, and the contract is
 * exact:
 *
 * - the document is **untrusted text**. Nothing here executes it, evaluates an
 *   expression in it, follows a URL out of it or keeps a byte of its script;
 * - what the project's index can account for becomes a node that references an
 *   index entry, `Mapped`;
 * - everything else becomes a kit primitive, `Proposed`, and is listed in
 *   `unmapped` with the reason — the contract's "records what did not map";
 * - the logic the sketch ran becomes **states**, never script: a filter, a
 *   sort or a calculation is recorded as a state the Tree can show, or as a
 *   state that was skipped with the reason why (`docs/design-phase.md`,
 *   "Interactivity: declarative prototypes");
 * - the answer is validated with `validateDesignBody` before it is returned,
 *   so a grounding can never hand a surface a tree the renderer would refuse.
 *
 * Deterministic on purpose (decision 2 in `docs/leap/m21-design-plan.md`
 * M21-T13): the same sketch grounds the same way every time, a project with no
 * model profile can still ground, and the unmapped list is a fact rather than
 * a model's opinion. A model rewrite of the result is a later, separate step —
 * it would compose through `compose_design`, which is already the tool for it.
 */
import {
  DESIGN_KIT_PRIMITIVES,
  validateDesignBody,
  type DesignBody,
  type DesignFidelity,
  type DesignIndex,
  type DesignIndexEntry,
  type DesignNode,
  type DesignScreen,
  type DesignSketchGroundResult,
  type DesignUnmappedPart,
} from "@lasercode/protocol";

/** Nodes one grounding may produce. A sketch past this is truncated and says so. */
export const GROUND_SKETCH_MAX_NODES = 400;
/** How deep the parse follows a document. */
const MAX_DEPTH = 24;
/** Bytes of text one node keeps. */
const TEXT_MAX = 400;

export interface GroundSketchInput {
  /** The sketch document, exactly as the frame was given it. Untrusted. */
  document: string;
  /** The reviewed index, when the project has one. */
  index?: DesignIndex | undefined;
  /** The name the grounded screen takes. */
  screenName?: string | undefined;
  /** The era to compose in. Defaults to the one marked for new work. */
  eraId?: string | undefined;
  /** The screen id. Injected in tests; derived from the document otherwise. */
  screenId?: string | undefined;
}

// --------------------------------------------------------------- the parse

interface Element {
  tag: string;
  classes: string[];
  id?: string;
  type?: string;
  text: string;
  children: Element[];
  /** Style attribute values, for the free-value report. */
  inlineStyle?: string;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Tags that carry no structure worth a node of its own. */
const SKIP_TAGS = new Set(["html", "head", "meta", "link", "title", "base", "br", "script", "style", "noscript", "template", "svg", "path"]);

function attributeOf(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

/**
 * A bounded tag scanner. It is not an HTML parser and does not pretend to be
 * one: it walks tags and text, keeps a stack, and stops at its budget. Nothing
 * it reads is resolved, fetched or run.
 */
function parseDocument(document: string): { root: Element; truncated: boolean } {
  const root: Element = { tag: "body", classes: [], text: "", children: [] };
  const stack: Element[] = [root];
  let truncated = false;
  let nodes = 0;
  // Script and style bytes never become nodes: they are read separately, as
  // text, for the states report.
  const markup = document.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  const pattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>|([^<]+)/g;
  for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
    const whole = match[0];
    const tag = match[1]?.toLowerCase();
    const attributes = match[2] ?? "";
    const text = match[3];
    const top = stack[stack.length - 1] ?? root;
    if (text !== undefined) {
      const cleaned = text.replace(/\s+/g, " ");
      if (cleaned.trim() !== "") top.text = `${top.text}${top.text === "" ? "" : " "}${cleaned.trim()}`.slice(0, TEXT_MAX);
      continue;
    }
    if (tag === undefined) continue;
    if (whole.startsWith("</")) {
      const index = stack.map((element) => element.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (SKIP_TAGS.has(tag)) continue;
    if (nodes >= GROUND_SKETCH_MAX_NODES) {
      truncated = true;
      continue;
    }
    const identifier = attributeOf(attributes, "id");
    const type = attributeOf(attributes, "type");
    const style = attributeOf(attributes, "style");
    const element: Element = {
      tag,
      classes: (attributeOf(attributes, "class") ?? "").split(/\s+/).filter((name) => name !== ""),
      text: "",
      children: [],
      ...(identifier !== undefined ? { id: identifier } : {}),
      ...(type !== undefined ? { type: type.toLowerCase() } : {}),
      ...(style !== undefined ? { inlineStyle: style } : {}),
    };
    nodes += 1;
    top.children.push(element);
    if (!VOID_TAGS.has(tag) && !whole.endsWith("/>") && stack.length < MAX_DEPTH) stack.push(element);
  }
  return { root, truncated };
}

// -------------------------------------------------------------- the mapping

const TAG_PRIMITIVE: Readonly<Record<string, string>> = {
  h1: "text",
  h2: "text",
  h3: "text",
  h4: "text",
  h5: "text",
  h6: "text",
  p: "text",
  span: "text",
  strong: "text",
  em: "text",
  small: "text",
  label: "text",
  li: "text",
  td: "text",
  th: "text",
  button: "button",
  a: "button",
  input: "input",
  textarea: "input",
  select: "select",
  option: "text",
  table: "table",
  thead: "stack",
  tbody: "stack",
  tr: "stack",
  ul: "stack",
  ol: "stack",
  nav: "nav",
  header: "nav",
  footer: "stack",
  dialog: "dialog",
  img: "image",
  figure: "image",
  form: "stack",
  section: "card",
  article: "card",
  aside: "card",
  main: "stack",
  div: "stack",
  body: "stack",
  fieldset: "stack",
};

/** The primitive a tag draws, before the index gets a say. */
function primitiveFor(element: Element): string {
  if (element.tag === "input" && (element.type === "checkbox" || element.type === "radio")) return "checkbox";
  const byTag = TAG_PRIMITIVE[element.tag];
  if (byTag !== undefined) return byTag;
  const words = [...element.classes, element.id ?? ""].join(" ").toLowerCase();
  for (const [pattern, primitive] of [
    [/(dialog|modal|sheet)/, "dialog"],
    [/(toast|snackbar|banner)/, "toast"],
    [/(empty|placeholder)/, "empty"],
    [/(spinner|loading|skeleton)/, "loading"],
    [/(error|failure)/, "error"],
    [/(card|panel|tile)/, "card"],
    [/(grid|columns)/, "grid"],
  ] as Array<[RegExp, string]>) {
    if (pattern.test(words)) return primitive;
  }
  return "stack";
}

/** Normalised words of a name, for matching a class or a tag to an entry. */
function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The index component this element is, when the index has one.
 *
 * Matched on the element's own names — its classes, its id, its tag — against
 * the entry's name, and never on anything the sketch asserted about itself. A
 * one-word class like `btn` matching an entry called `Button` is the common
 * case and the one worth getting right; anything looser would produce a
 * `Mapped` label that is not true, which is the one thing this must not do.
 */
function entryFor(element: Element, components: readonly DesignIndexEntry[], eraId: string | undefined): DesignIndexEntry | undefined {
  const candidates = element.classes.concat(element.id ?? "", element.tag).map(words).filter((value) => value !== "");
  if (candidates.length === 0) return undefined;
  const inEra = (entry: DesignIndexEntry): boolean => eraId === undefined || entry.eraId === undefined || entry.eraId === eraId;
  for (const entry of components) {
    if (!inEra(entry) || entry.review.state === "rejected") continue;
    const name = words(entry.name);
    if (name === "") continue;
    for (const candidate of candidates) {
      if (candidate === name) return entry;
      // `btn-primary` for `Button`: the entry's whole name as a word of the class.
      if (candidate.split(" ").includes(name)) return entry;
    }
  }
  return undefined;
}

const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/g;

/** Free colour values, the thing a Tree may never carry (`docs/design-phase.md`). */
function freeValues(document: string): string[] {
  const found = new Set<string>();
  for (const match of document.matchAll(HEX_COLOUR)) found.add(match[0]);
  return [...found].slice(0, 20);
}

// --------------------------------------------------------------- the states

interface LogicSignal {
  pattern: RegExp;
  state: string;
  included: boolean;
  reason?: string;
}

/**
 * What the sketch's script did, read as text.
 *
 * Two answers only: a behaviour a Tree can *show* becomes an included state,
 * and a behaviour a Tree cannot express becomes a skipped state carrying the
 * reason. Nothing is executed to find out, and no script survives the
 * grounding — the contract's "logic is not a Tree's job; that is what a Sketch
 * is for".
 */
const LOGIC_SIGNALS: readonly LogicSignal[] = [
  { pattern: /\b(loading|isLoading|pending|spinner)\b/, state: "loading", included: true },
  { pattern: /\b(empty|noResults|no_results|placeholder)\b/, state: "empty", included: true },
  { pattern: /\b(error|failed|catch\s*\()/, state: "error", included: true },
  { pattern: /\b(disabled)\b/, state: "disabled", included: true },
  { pattern: /\b(selected|active|current)\b/, state: "selected", included: true },
  {
    pattern: /\.(filter|includes)\s*\(|\binput\.addEventListener\s*\(\s*["']input/,
    state: "filtered",
    included: false,
    reason: "the sketch filtered the list live; a Tree shows the filtered result as a state and leaves the filtering to the build",
  },
  {
    pattern: /\.sort\s*\(/,
    state: "sorted",
    included: false,
    reason: "the sketch sorted in script; a Tree records the sorted state and fixture rather than running a comparator",
  },
  {
    pattern: /(\btotal\b|\bsum\b|toFixed\s*\(|\*\s*quantity)/,
    state: "calculated",
    included: false,
    reason: "the sketch calculated values in script; a Tree binds a fixture instead, and the real arithmetic belongs to the build",
  },
  {
    pattern: /\b(draggable|dragstart|dragover)\b/,
    state: "reordered",
    included: false,
    reason: "the sketch reordered by dragging; a Tree cannot express drag logic, so the order is a fixture",
  },
];

function statesFrom(document: string, markupText: string): DesignSketchGroundResult["states"] {
  const script = [...document.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1] ?? "").join("\n");
  const haystack = `${script}\n${markupText}`;
  const states: DesignSketchGroundResult["states"] = [{ name: "default", included: true }];
  for (const signal of LOGIC_SIGNALS) {
    if (!signal.pattern.test(haystack)) continue;
    if (states.some((state) => state.name === signal.state)) continue;
    states.push({ name: signal.state, included: signal.included, ...(signal.reason !== undefined ? { skipReason: signal.reason } : {}) });
  }
  return states.slice(0, 32);
}

// ------------------------------------------------------------------ grounding

/** A stable, opaque node id: `n` plus its position in the walk. */
function nodeId(counter: number): string {
  return `gs${String(counter).padStart(3, "0")}`;
}

export function groundSketch(input: GroundSketchInput): DesignSketchGroundResult {
  const { root, truncated } = parseDocument(input.document);
  const components = (input.index?.entries ?? []).filter((entry) => entry.kind === "component");
  const eraId = input.eraId ?? input.index?.eras.find((era) => era.useForNewWork)?.id;
  const nodes: DesignNode[] = [];
  const unmapped: DesignUnmappedPart[] = [];
  const usedEntryIds = new Set<string>();
  const notes: string[] = [];
  const unmappedTags = new Set<string>();
  let counter = 0;

  const visit = (element: Element, depth: number): string => {
    const id = nodeId((counter += 1));
    const primitive = primitiveFor(element);
    const entry = entryFor(element, components, eraId);
    const children = depth >= MAX_DEPTH ? [] : element.children.map((child) => visit(child, depth + 1));
    const text = element.text.trim();
    let fidelity: DesignFidelity = "proposed";
    if (entry) {
      usedEntryIds.add(entry.id);
      fidelity = "mapped";
    } else if (!unmappedTags.has(element.tag) && element.tag !== "body") {
      unmappedTags.add(element.tag);
      unmapped.push({
        what: `<${element.tag}>`,
        why:
          components.length === 0
            ? "This project has no reviewed component in its design index to draw this with, so it is proposed."
            : "No component in this project's design index matches this element, so it is proposed rather than claimed as the project's own.",
        primitive,
      });
    }
    const node: DesignNode = {
      id,
      component: entry ? { indexEntryId: entry.id } : { primitive },
      fidelity,
      ...(entry && entry.review.state === "unreviewed" ? { unreviewed: true } : {}),
      props: {},
      children,
      ...(text !== "" && !text.includes("<") ? { text: text.slice(0, TEXT_MAX) } : {}),
    };
    nodes.push(node);
    return id;
  };

  const rootId = visit(root, 0);

  for (const value of freeValues(input.document)) {
    unmapped.push({
      what: value,
      why: "A literal colour is not a token in this project's index; the grounded tree draws the index's own token and records this value as proposed.",
    });
  }
  if (truncated) notes.push(`This sketch is larger than ${String(GROUND_SKETCH_MAX_NODES)} elements; the grounding stopped there and the rest is not in the tree.`);
  if (!input.index) notes.push("This project has no design index yet, so nothing in this tree could be mapped to it. Build the index and ground it again to get Mapped nodes.");

  const markupText = nodes.map((node) => node.text ?? "").join(" ");
  const states = statesFrom(input.document, markupText);

  const screen: DesignScreen = {
    id: input.screenId ?? "gsscreen",
    name: (input.screenName ?? "Grounded sketch").slice(0, 200),
    content: { tree: { rootNodeId: rootId, nodes } },
    states,
    // The conservative aggregate: one proposed node makes the screen proposed.
    fidelity: nodes.every((node) => node.fidelity === "mapped") ? "mapped" : "proposed",
  };

  // The answer is validated before it leaves: a grounding that produced a tree
  // the renderer would refuse is a failure here, not a surprise there.
  const body: DesignBody = {
    brief: "grounded sketch",
    screens: [screen],
    flows: [],
    sketches: [],
    fidelity: screen.fidelity,
    fixtures: [],
  };
  const validation = validateDesignBody(body, {
    primitives: DESIGN_KIT_PRIMITIVES,
    ...(input.index ? { entryIds: input.index.entries.map((candidate) => candidate.id) } : {}),
  });
  if (!validation.ok) {
    const issue = validation.issues[0];
    throw new GroundSketchRefused(
      issue?.message ?? "This sketch could not be rebuilt as a tree.",
      "ask for the sketch to be rewritten, or compose the screen from the index in the chat",
    );
  }

  return { screen, unmapped: unmapped.slice(0, 200), states, usedEntryIds: [...usedEntryIds], notes };
}

/** A grounding that could not produce a valid tree. Carries what to do next. */
export class GroundSketchRefused extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(message);
    this.name = "GroundSketchRefused";
    this.next = next;
  }
}
