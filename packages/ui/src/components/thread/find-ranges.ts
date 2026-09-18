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
