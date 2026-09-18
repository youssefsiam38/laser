"use client";
/**
 * A reply, a reasoning trail or a prompt read as what it is: a document (M16-T84).
 *
 * The transcript draws prose with `markdown-text`; opening the whole of it used
 * to drop the person into a monospace pane where `**a heading**` was three
 * words and two pairs of asterisks. This reader is the same element, the same
 * component map, the same code headers and highlighting and the same math, put
 * in front of the body read back from its authority — so the full reply reads
 * exactly like the part of it that was already on screen.
 *
 * What it holds: one body, once, up to {@link MARKDOWN_BODY_MAX_BYTES} — four
 * of the paged reader's segments. A document is a single parsed tree; there is
 * no honest way to render a quarter of a Markdown body and call it formatted,
 * so anything larger stays with the paged plain reader and is told so in one
 * sentence. The bytes arrive through the same `session/entry_range` contract
 * the paged reader and Copy use ({@link streamBody}), behind the same revision
 * fence, and the read is abandoned the moment the reader goes away.
 *
 * Find works on what is drawn, not on what was read: DOM ranges over the
 * rendered text and the browser's own highlights, exactly as conversation find
 * does (`use-conversation-find`), never wrapping or replacing a text node
 * React owns. Copy and Download stay raw text: what is copied is what the
 * message is made of.
 */
import { TextMessagePartProvider } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { ExcerptedMessage, MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { SkeletonText } from "@/components/ui/skeleton";
import { formatBytes } from "@/format";
import { cn } from "@/lib/utils";
import { bodyReadMessage, streamBody } from "@/runtime/body-reader";
import { textMatches } from "./search-text.js";
import { OUTPUT_SEGMENT_BYTES } from "./output-pager.js";
import type { copyWhole } from "./output-transfer.js";
import { ViewerFooter, type BodyFind } from "./body-viewer-footer.js";

/**
 * The most of a body this reader formats as one document: four of the paged
 * reader's segments, a quarter of a megabyte. Past it the paged plain reader
 * keeps the body, three segments at a time, as it always has.
 */
export const MARKDOWN_BODY_MAX_BYTES = 4 * OUTPUT_SEGMENT_BYTES;

/** Whether this body can be read as one formatted document. */
export const fitsMarkdownReader = (totalBytes: number): boolean => totalBytes <= MARKDOWN_BODY_MAX_BYTES;

type BodySource = Parameters<typeof copyWhole>[0];

const SHORT = "Only part of this could be read just now. Try again in a moment.";
const corrupt = (label: string): string => `What came back was not this ${label}. Open the conversation again.`;

const HIGHLIGHT_CSS =
  "::highlight(output-viewer-matches){background-color:color-mix(in oklab,var(--attention) 25%,transparent);color:var(--ink)}" +
  "::highlight(output-viewer-current){background-color:var(--attention);color:var(--bg)}";

const highlights = (): Map<string, unknown> | undefined =>
  (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;

const dropHighlights = (): void => {
  const registry = highlights();
  registry?.delete?.("output-viewer-matches");
  registry?.delete?.("output-viewer-current");
};

export interface MarkdownBodyReaderProps {
  source: BodySource;
  /** The body's noun: "reply", "reasoning", "message". */
  label: string;
  fileBase: string;
  initialQuery: string | undefined;
  /** Read this body as its characters instead. */
  onPlainText(): void;
}

export function MarkdownBodyReader({ source, label, fileBase, initialQuery, onPlainText }: MarkdownBodyReaderProps) {
  const [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState<{ text?: string; error?: string }>({});
  const scroller = useRef<HTMLDivElement>(null);
  const lastQuery = useRef<string | undefined>(undefined);
  const at = useRef(0);
  /** Searches asked for before the body arrived (see `waitForDocument`). */
  const waiting = useRef<Array<() => void>>([]);

  // One read of the whole body, through the range contract every other reader
  // here uses. Leaving the formatted view abandons it; nothing is kept.
  useEffect(() => {
    const signal = { aborted: false };
    let parts: string[] = [];
    setBody({});
    void (async () => {
      try {
        const outcome = await streamBody(
          source.request,
          source.path,
          source.ref,
          { environmentKey: source.environmentKey, ...(source.revisionOf ? { revisionOf: source.revisionOf } : {}), signal },
          slice => { parts.push(slice); },
        );
        if (signal.aborted) return;
        if (outcome.bytes !== outcome.totalBytes) { setBody({ error: SHORT }); return; }
        if (!outcome.verified) { setBody({ error: corrupt(label) }); return; }
        setBody({ text: parts.join("") });
      } catch (failure) {
        if (!signal.aborted) setBody({ error: bodyReadMessage(failure) });
      } finally {
        parts = [];
      }
    })();
    // Leaving the formatted view abandons the read and releases anyone waiting
    // on a document that will never be drawn.
    return () => {
      signal.aborted = true;
      const waiters = waiting.current;
      waiting.current = [];
      for (const resolve of waiters) resolve();
    };
  }, [source, attempt, label]);

  useEffect(() => () => dropHighlights(), []);

  const place = useCallback((top: number) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
  }, []);
  const toStart = useCallback(() => place(0), [place]);
  const toEnd = useCallback(() => { const element = scroller.current; if (element) place(element.scrollHeight); }, [place]);

  // The footer asks for the first search as soon as the viewer opens — which is
  // before the body has arrived. Waiting for the document is part of finding in
  // it, and the wait ends on the paint that draws it, not on a clock. A search
  // that outlives the reader is dropped.
  useEffect(() => {
    if (body.text === undefined && body.error === undefined) return;
    const waiters = waiting.current;
    waiting.current = [];
    for (const resolve of waiters) resolve();
  }, [body]);
  const documentRoot = useCallback(
    () => scroller.current?.querySelector<HTMLElement>('[data-slot="body-viewer-document"]') ?? undefined,
    [],
  );
  const waitForDocument = useCallback(async (signal: { aborted: boolean }): Promise<HTMLElement | undefined> => {
    const drawn = documentRoot();
    if (drawn) return drawn;
    await new Promise<void>(resolve => { waiting.current.push(resolve); });
    if (signal.aborted) return undefined;
    return documentRoot();
  }, [documentRoot]);

  const paint = useCallback((ranges: Range[], index: number) => {
    const registry = highlights();
    const element = scroller.current;
    const current = ranges[index];
    if (registry && typeof Highlight !== "undefined") {
      registry.set("output-viewer-matches", new Highlight(...ranges));
      registry.set("output-viewer-current", new Highlight(...(current ? [current] : [])));
    }
    if (!current || !element || typeof current.getBoundingClientRect !== "function") return;
    const box = current.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    // A match already in view is left where it is; the reader's eye does not
    // move for a match it is looking at.
    if (box.top < view.top || box.bottom > view.bottom) place(element.scrollTop + box.top - view.top - element.clientHeight / 3);
  }, [place]);

  const find = useMemo<BodyFind>(() => ({
    stepsBack: true,
    reset() { lastQuery.current = undefined; at.current = 0; dropHighlights(); },
    async run(query, direction, signal) {
      const root = await waitForDocument(signal);
      if (signal.aborted || !root) return { found: false, notice: `“${query}” is not in this ${label}.` };
      const ranges = documentRanges(root, query);
      if (ranges.length === 0) {
        lastQuery.current = undefined;
        dropHighlights();
        return { found: false, notice: `“${query}” is not in this ${label}.` };
      }
      const index = lastQuery.current === query ? (at.current + direction + ranges.length) % ranges.length : 0;
      lastQuery.current = query;
      at.current = index;
      paint(ranges, index);
      return { found: true, position: { index: index + 1, total: ranges.length } };
    },
  }), [label, paint, waitForDocument]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home" && !event.shiftKey) { event.preventDefault(); toStart(); }
    else if (event.key === "End" && !event.shiftKey) { event.preventDefault(); toEnd(); }
  };

  const total = source.ref.totalBytes;
  const empty = body.text !== undefined && body.text.trim() === "";

  return <>
    <div
      ref={scroller}
      data-slot="output-viewer-scroller"
      data-format="markdown"
      role="region"
      tabIndex={0}
      aria-label={`${label}, ${formatBytes(total)}`}
      aria-busy={body.text === undefined && body.error === undefined ? true : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "relative min-h-0 flex-1 overflow-auto overscroll-contain bg-surface px-4 py-3 text-ink outline-none [overflow-anchor:none]",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
      )}
    >
      <style>{HIGHLIGHT_CSS}</style>
      {body.text !== undefined ? (
        empty
          ? <p className="typed text-ink-3">This {label} is empty.</p>
          // A reading column, centred: the measure is the transcript's, and a
          // wide window puts the margin on both sides of it rather than all of
          // it on the right.
          : <div data-slot="body-viewer-document" className="mx-auto min-w-0 max-w-(--measure-prose)">
              {/* The whole of it: nothing here is an excerpt, so code copied
                  out of it is the code, unmarked. */}
              <ExcerptedMessage.Provider value={false}>
                <TextMessagePartProvider text={body.text} isRunning={false}>
                  <MarkdownText nativeFiles />
                </TextMessagePartProvider>
              </ExcerptedMessage.Provider>
            </div>
      ) : body.error !== undefined ? null : (
        <div data-slot="output-viewer-skeleton" aria-hidden="true" className="mx-auto flex max-w-(--measure-prose) flex-col gap-3">
          {SKELETON.map((share, index) => <SkeletonText key={index} width={share} />)}
        </div>
      )}
    </div>
    <ViewerFooter
      label={label}
      error={body.error}
      onRetry={() => setAttempt(value => value + 1)}
      format={{ formatted: true, onChange: () => onPlainText() }}
      onStart={toStart}
      onEnd={toEnd}
      find={find}
      initialQuery={initialQuery}
      fileBase={fileBase}
      transfer={source}
    />
  </>;
}

const SKELETON = ["46%", "92%", "88%", "70%", "30%", "84%", "78%"];

/**
 * Every match of `query` in what is drawn under `root`, as DOM ranges.
 *
 * The same approach as conversation find, and for the same reason: a range
 * spans markup boundaries and changes nothing about the tree React owns, so a
 * match inside `**bold**` or across a link is one highlight and no re-render.
 * Controls (a code block's copy button), hidden regions and anything marked as
 * not content — a fence's language label — are not text of the message.
 *
 * It is written here rather than imported from `use-conversation-find` because
 * that module reaches the transcript viewport, which reaches the message rows
 * this viewer is opened from.
 */
export function documentRanges(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const parent = next.parentElement;
    if (!parent || parent.closest("button, [hidden], [aria-hidden=true], [data-search-exclude], textarea, script, style")) continue;
    const value = next.textContent ?? "";
    if (!value) continue;
    nodes.push({ node: next as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  // Matches come out in order, so the node they start in is never behind the
  // one before it: a document of ten thousand text nodes is walked once in
  // total, not once per match.
  const ranges: Range[] = [];
  let cursor = 0;
  for (const match of textMatches(text, query)) {
    while (cursor < nodes.length && nodes[cursor]!.end <= match.start) cursor += 1;
    const first = nodes[cursor];
    if (!first) break;
    let end = cursor;
    while (end < nodes.length && nodes[end]!.end < match.end) end += 1;
    const last = nodes[end];
    if (!last) break;
    const range = document.createRange();
    range.setStart(first.node, match.start - first.start);
    range.setEnd(last.node, match.end - last.start);
    ranges.push(range);
  }
  return ranges;
}
