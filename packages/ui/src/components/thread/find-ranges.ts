/**
 * The one walker that turns a query into DOM ranges over drawn text.
 *
 * Every find surface in the app looks through what is on screen rather than
 * through a copy of it: a range spans markup boundaries and changes nothing
 * about the tree React owns, so a match inside `**bold**`, across a link or
 * inside a file chip is one highlight and no re-render (§6b).
 *
 * It lives in a leaf module of its own — nothing here imports a viewport, a
 * row or a store — so the conversation's find (`use-conversation-find`), the
 * request inspector (`use-request-find`) and the full-body reader
 * (`MarkdownBodyReader`) share one policy and one set of exceptions. A second
 * copy of this walker is a second set of exceptions, and the exceptions are
 * the whole of the contract: a correction made here is made everywhere.
 */
import { matchExcerpt, textMatches } from "./search-text.js";

/** Build ranges across markup boundaries without changing React-owned DOM. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  return findTextMatches(root, query).map(match => match.range);
}

/** Diagnostics opt into literal JSON; chat keeps its value-only display policy. */
export function findTextMatches(root: HTMLElement, query: string, mode: "conversation" | "literal" = "conversation") {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  type TextRun = { text: string; nodes: Array<{ node: Text; start: number; end: number }> };
  const runs: TextRun[] = [];
  let region: Element | null = null;
  let run: TextRun | undefined;
  let next: Node | null;
  while ((next = walker.nextNode())) {
    const parent = next.parentElement;
    const content = mode === "conversation" ? parent?.closest("[data-search-content]") ?? null : null;
    // Tool bodies are opt-in. JSON keys, status labels, gutters and transport
    // wrappers must never consume the occurrence assigned to a real value.
    const button = parent?.closest("button");
    const authoredFileLabel = mode === "conversation" && content && button?.matches('[data-slot="file-chip"]');
    if (!parent || (button && !authoredFileLabel) || parent.closest("[hidden], [aria-hidden=true], [data-search-exclude], textarea, script, style") ||
      (mode === "conversation" && parent.closest('[data-search-tool], [data-slot="json-viewer"]') && !content)) {
      run = undefined;
      continue;
    }
    const nextRegion = content ?? root;
    if (!run || region !== nextRegion) { run = { text: "", nodes: [] }; runs.push(run); region = nextRegion; }
    const value = next.textContent ?? "";
    run.nodes.push({ node: next as Text, start: run.text.length, end: run.text.length + value.length });
    run.text += value;
  }
  return runsToMatches(runs, query);
}

export type FindMatch = { range: Range; before: string; match: string; after: string };

function runsToMatches(
  runs: Array<{ text: string; nodes: Array<{ node: Text; start: number; end: number }> }>,
  query: string,
): FindMatch[] {
  return runs.flatMap(({ text, nodes }) => textMatches(text, query).flatMap(m => {
    const first = nodes.find(n => n.end > m.start);
    const last = nodes.find(n => n.end >= m.end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, m.start - first.start);
    range.setEnd(last.node, m.end - last.start);
    return [{ range, ...matchExcerpt(text, m) }];
  }));
}

/**
 * A value-region policy for trees we do not own. Conversation find keeps
 * `[data-search-content]`; the changes overlay's Pierre roots use `[data-line]`.
 */
export type FindRegionPolicy = {
  /** Concatenate text inside this selector. One region is one searchable string. */
  region: string;
  skip: string;
};

/** Overlay diffs: `[data-line]` is the value region. Gutters, separators and headers are chrome. */
export const DIFF_LINE_FIND_POLICY: FindRegionPolicy = {
  region: "[data-line]",
  skip: "style, script, template, [data-gutter], [data-separator], [data-diffs-header], [aria-hidden=true]",
};

export const OVERLAY_FIND_HIGHLIGHTS = { matches: "overlay-matches", current: "overlay-current" } as const;

/** Every open shadow root at or under `node`, depth-first, including nested ones. */
export function collectOpenShadowRoots(node: Node): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visit = (start: Node) => {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = start.nodeType === Node.ELEMENT_NODE ? start : walker.nextNode();
    while (current) {
      const shadow = (current as Element).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        visit(shadow);
      }
      current = walker.nextNode();
    }
  };
  visit(node);
  return roots;
}

const OVERLAY_HIGHLIGHT_CSS = `
::highlight(${OVERLAY_FIND_HIGHLIGHTS.matches}) {
  background-color: color-mix(in oklab, var(--attention) 25%, transparent);
  color: var(--ink);
}
::highlight(${OVERLAY_FIND_HIGHLIGHTS.current}) {
  background-color: var(--attention);
  color: var(--bg);
}
`;

let overlaySheet: CSSStyleSheet | undefined;

/** One constructed sheet, appended into each Pierre root. Never replace their sheets. */
export function overlayFindHighlightSheet(): CSSStyleSheet | undefined {
  if (typeof CSSStyleSheet === "undefined") return undefined;
  if (!overlaySheet) {
    overlaySheet = new CSSStyleSheet();
    overlaySheet.replaceSync(OVERLAY_HIGHLIGHT_CSS);
  }
  return overlaySheet;
}

/** Adopt the highlight stylesheet into a root without disturbing its own sheets. */
export function adoptHighlightSheet(root: ShadowRoot, sheet: CSSStyleSheet): boolean {
  if (!("adoptedStyleSheets" in root)) return false;
  if (root.adoptedStyleSheets.includes(sheet)) return true;
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return true;
}

export function adoptOverlayFindStyles(root: ShadowRoot): boolean {
  const sheet = overlayFindHighlightSheet();
  if (!sheet) return false;
  return adoptHighlightSheet(root, sheet);
}

/** Concatenate text per value region and build ranges. A match may span many spans. */
export function findTextMatchesIn(
  root: Document | ShadowRoot | Element,
  query: string,
  policy: FindRegionPolicy,
): FindMatch[] {
  if (!query.trim()) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  type TextRun = { text: string; nodes: Array<{ node: Text; start: number; end: number }> };
  const runs: TextRun[] = [];
  let region: Element | null = null;
  let run: TextRun | undefined;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = (node as Text).parentElement;
    if (!parent || parent.closest(policy.skip)) {
      run = undefined;
      continue;
    }
    const nextRegion = parent.closest(policy.region);
    if (!nextRegion) {
      run = undefined;
      continue;
    }
    if (!run || region !== nextRegion) {
      run = { text: "", nodes: [] };
      runs.push(run);
      region = nextRegion;
    }
    const value = node.textContent ?? "";
    run.nodes.push({ node: node as Text, start: run.text.length, end: run.text.length + value.length });
    run.text += value;
  }
  return runsToMatches(runs, query);
}

export type RootMatch = FindMatch & { root: Document | ShadowRoot };

function insideShadow(range: Range, roots: ShadowRoot[]): boolean {
  return roots.some(root => root.contains(range.startContainer));
}

/**
 * Find across the host and every open shadow root under it. Adopts the overlay
 * highlight sheet into each root (Pierre's constructor assigns `[coreSheet]`;
 * replacing would wipe it).
 */
export function findTextMatchesAcrossRoots(
  host: Element,
  query: string,
  policy: FindRegionPolicy = DIFF_LINE_FIND_POLICY,
): RootMatch[] {
  const roots = collectOpenShadowRoots(host);
  for (const root of roots) adoptOverlayFindStyles(root);
  const fromRoots = roots.flatMap(root => findTextMatchesIn(root, query, policy).map(match => ({ ...match, root })));
  const fromHost = findTextMatchesIn(host, query, policy)
    .filter(match => !insideShadow(match.range, roots))
    .map(match => ({ ...match, root: host.getRootNode() as Document | ShadowRoot }));
  return [...fromRoots, ...fromHost];
}
