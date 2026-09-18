"use client";
/**
 * A whole document of Markdown, drawn the way the transcript draws prose, with
 * find that survives the document settling (M16-T84).
 *
 * This is the reusable element: any surface that has the text of something a
 * person wrote or a model wrote — the full-body viewer, a file preview, a
 * note, an agent's instructions — mounts it and gets the same renderer, the
 * same component map, the same code headers, highlighting and math, the same
 * file links, and the same find behaviour. It renders through
 * {@link MarkdownText}: there is exactly one Markdown pipeline in this app and
 * this element does not fork it.
 *
 * Two things belong here rather than in any one surface:
 *
 * **Find on what is drawn.** DOM ranges over the rendered text and the
 * browser's own highlights, through the walker every find surface shares
 * (`thread/find-ranges`), never wrapping or replacing a text node React owns.
 *
 * **The document keeps changing after it is drawn.** Shiki replaces every
 * fence's nodes when its tokenizer lands, KaTeX replaces the math when its
 * renderer does. A range into a replaced node highlights nothing while still
 * being counted, and measures as a zero-sized box, so stepping onto it scrolls
 * somewhere unrelated. Nothing is kept but the query: the marks and the count
 * are derived again from it each time the document settles, coalesced to one
 * frame, so the number a surface shows always means the marks on screen.
 *
 * What stays outside: loading, size policy, transport, dialogs, footers,
 * scroll containers. The surface owns those, hands the element `text`, and
 * drives its search through {@link DocumentFind}.
 */
import { TextMessagePartProvider } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { findTextRanges } from "@/components/thread/find-ranges";
import { cn } from "@/lib/utils";
import { ExcerptedMessage, MarkdownText } from "./markdown-text.js";

/** Where a search stands inside a mounted document: "3 of 12". */
export interface DocumentFindPosition {
  index: number;
  total: number;
}

/** How a surface's find bar drives the document it has mounted. */
export interface DocumentFind {
  /**
   * Move to a match of `query` and reveal it: the first one when the query is
   * new, the next or previous one when it is the same. `undefined` when the
   * drawn document does not contain it.
   */
  step(query: string, direction: 1 | -1): DocumentFindPosition | undefined;
  /** Forget the search and take its marks off the document. */
  clear(): void;
  /**
   * Where the search stands now, and again whenever the document settles under
   * it. A surface that shows a count subscribes, so the count and the marks
   * can never disagree.
   */
  subscribe(listener: (position: DocumentFindPosition | undefined) => void): () => void;
}

export interface MarkdownDocumentFind {
  /**
   * The two highlight registry names this surface owns. Every find surface has
   * its own pair, so two documents on screen never fight over one (§6b).
   */
  highlight: { matches: string; current: string };
  /** The mounted document's controller, and `undefined` when it goes away. */
  publish(find: DocumentFind | undefined): void;
  /**
   * Bring a match into view. The surface owns its own scrolling — a dialog's
   * reading region places a match a third of the way down, a page may not
   * scroll at all — and the browser's own `scrollIntoView` is the default.
   */
  reveal?(range: Range): void;
}

export interface MarkdownDocumentProps {
  /** The whole text, as its author wrote it. */
  text: string;
  /**
   * How wide the reading column is. `prose` is one reading measure, centred:
   * a wide window puts the margin on both sides rather than all of it on the
   * right. Typography itself is the shared `md-body` scale, never a per-surface
   * value.
   */
  measure?: "prose" | "thread" | "full";
  /** Part of a longer message, so code copied out of it is marked as an excerpt. */
  excerpted?: boolean;
  /**
   * Resolve file paths and links through the project opener, as the transcript
   * does. The opener and the owning directory come from context
   * (`FileOpenerProvider`, `FileLinkDirectory`): there is one way to open a
   * file in this app and this element does not add a second.
   */
  nativeFiles?: boolean;
  /** Reading direction, as `MarkdownText` takes it: `auto` follows the text. */
  dir?: "ltr" | "auto";
  /** Find, when this surface offers it. */
  find?: MarkdownDocumentFind | undefined;
  className?: string;
}

const MEASURE: Record<NonNullable<MarkdownDocumentProps["measure"]>, string> = {
  prose: "mx-auto min-w-0 max-w-(--measure-prose)",
  thread: "mx-auto min-w-0 max-w-(--measure-thread)",
  full: "min-w-0 max-w-none [&>*]:max-w-none",
};

/** Names are supplied by the embedding surface, not by message text. */
const highlightCss = (names: { matches: string; current: string }): string | undefined => {
  if (![names.matches, names.current].every(name => /^[A-Za-z0-9_-]+$/.test(name))) return undefined;
  return `::highlight(${names.matches}){background-color:color-mix(in oklab,var(--attention) 25%,transparent);color:var(--ink)}::highlight(${names.current}){background-color:var(--attention);color:var(--bg)}`;
};

const registryOf = (): Map<string, unknown> | undefined =>
  (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;

export function MarkdownDocument({ text, measure = "prose", excerpted = false, nativeFiles = false, dir, find, className }: MarkdownDocumentProps) {
  const root = useRef<HTMLDivElement>(null);
  const query = useRef<string | undefined>(undefined);
  const at = useRef(0);
  const watchers = useRef(new Set<(position: DocumentFindPosition | undefined) => void>());
  // The surface may hand a new object every render; what it asks for is read
  // when something happens, never depended upon.
  const options = useRef(find);
  options.current = find;

  const drop = useCallback((override?: { matches: string; current: string }) => {
    const registry = registryOf();
    const names = override ?? options.current?.highlight;
    if (!registry || !names) return;
    registry.delete?.(names.matches);
    registry.delete?.(names.current);
  }, []);

  const publish = useCallback((position: DocumentFindPosition | undefined) => {
    for (const watcher of watchers.current) watcher(position);
  }, []);

  const paint = useCallback((ranges: Range[], index: number, reveal: boolean) => {
    const registry = registryOf();
    const names = options.current?.highlight;
    const current = ranges[index];
    if (registry && names && typeof Highlight !== "undefined") {
      registry.set(names.matches, new Highlight(...ranges));
      registry.set(names.current, new Highlight(...(current ? [current] : [])));
    }
    if (!reveal || !current) return;
    const show = options.current?.reveal;
    if (show) { show(current); return; }
    const element = current.startContainer.parentElement;
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
  }, []);

  /** Mark the current query again over the document as it is now. */
  const repaint = useCallback((reveal: boolean) => {
    const needle = query.current;
    const element = root.current;
    if (!needle || !element) return;
    const ranges = findTextRanges(element, needle);
    if (ranges.length === 0) {
      query.current = undefined;
      at.current = 0;
      drop();
      publish(undefined);
      return;
    }
    const index = Math.min(at.current, ranges.length - 1);
    at.current = index;
    paint(ranges, index, reveal);
    publish({ index: index + 1, total: ranges.length });
  }, [drop, paint, publish]);

  const controller = useMemo<DocumentFind>(() => ({
    step(needle, direction) {
      const element = root.current;
      if (!element || !needle.trim()) return undefined;
      const ranges = findTextRanges(element, needle);
      if (ranges.length === 0) {
        query.current = undefined;
        at.current = 0;
        drop();
        publish(undefined);
        return undefined;
      }
      const index = query.current === needle ? (at.current + direction + ranges.length) % ranges.length : 0;
      query.current = needle;
      at.current = index;
      paint(ranges, index, true);
      const position = { index: index + 1, total: ranges.length };
      publish(position);
      return position;
    },
    clear() {
      query.current = undefined;
      at.current = 0;
      drop();
      publish(undefined);
    },
    subscribe(listener) {
      watchers.current.add(listener);
      return () => { watchers.current.delete(listener); };
    },
  }), [drop, paint, publish]);

  // The document is the surface's to search for exactly as long as it is drawn.
  useEffect(() => {
    const handed = options.current;
    handed?.publish(controller);
    return () => { handed?.publish(undefined); drop(handed?.highlight); };
  }, [controller, drop, find]);

  // Every settling of the document redraws the marks, coalesced to one frame,
  // exactly as the conversation's own find does over the transcript.
  useEffect(() => {
    const element = root.current;
    if (!element || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const schedule = () => {
      if (typeof requestAnimationFrame !== "function") { repaint(false); return; }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => repaint(false));
    };
    const observer = new MutationObserver(schedule);
    observer.observe(element, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["hidden", "aria-hidden", "data-search-content", "data-search-exclude"],
    });
    return () => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame); observer.disconnect(); };
  }, [repaint]);

  return (
    <div ref={root} data-slot="markdown-document" className={cn(MEASURE[measure], className)}>
      {find ? <style>{highlightCss(find.highlight)}</style> : null}
      <ExcerptedMessage.Provider value={excerpted}>
        <TextMessagePartProvider text={text} isRunning={false}>
          <MarkdownText nativeFiles={nativeFiles} {...(dir ? { dir } : {})} />
        </TextMessagePartProvider>
      </ExcerptedMessage.Provider>
    </div>
  );
}
