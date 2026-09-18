"use client";
/**
 * A reply, a reasoning trail or a prompt read as what it is: a document (M16-T84).
 *
 * The transcript draws prose with `markdown-text`; opening the whole of it used
 * to drop the person into a monospace pane where `**a heading**` was three
 * words and two pairs of asterisks. What draws the document is the shared
 * element, {@link MarkdownDocument} — the same renderer, component map, code
 * headers, highlighting, math and file links the transcript uses, with find on
 * what is drawn and the repaint that keeps it honest while Shiki and KaTeX
 * settle. This file is the adapter between that element and one body of one
 * message: getting the bytes, deciding how many of them a document may hold,
 * and the reading region they are read in.
 *
 * What it holds: one body, once, up to {@link MARKDOWN_BODY_MAX_BYTES} — four
 * of the paged reader's segments. A document is a single parsed tree; there is
 * no honest way to render a quarter of a Markdown body and call it formatted,
 * so anything larger stays with the paged plain reader and is told so in one
 * sentence. The bytes arrive through the same `session/entry_range` contract
 * the paged reader and Copy use ({@link streamBody}), behind the same revision
 * fence, and the read is abandoned the moment the reader goes away.
 *
 * Copy and Download stay raw text: what is copied is what the message is made
 * of, formatted or not.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { MarkdownDocument, type DocumentFind, type MarkdownDocumentFind } from "@/components/assistant-ui/elements/markdown-document";
import { SkeletonText } from "@/components/ui/skeleton";
import { formatBytes } from "@/format";
import { cn } from "@/lib/utils";
import { bodyReadMessage, streamBody } from "@/runtime/body-reader";
import { OUTPUT_SEGMENT_BYTES } from "./output-pager.js";
import type { copyWhole } from "./output-transfer.js";
import type { BodyFind, BodyFindPosition, ReaderControls } from "./body-viewer-footer.js";

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

/** This viewer's own pair, shared with no other find surface (§6b). */
const HIGHLIGHT = { matches: "output-viewer-matches", current: "output-viewer-current" };

export interface MarkdownBodyReaderProps {
  source: BodySource;
  /** The body's noun: "reply", "reasoning", "message". */
  label: string;
  /** Hand the viewer's footer this reader's find, its reading keys and its state. */
  publish(controls: ReaderControls): void;
}

export function MarkdownBodyReader({ source, label, publish }: MarkdownBodyReaderProps) {
  const [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState<{ text?: string; error?: string }>({});
  const scroller = useRef<HTMLDivElement>(null);
  /** The mounted document's find, once it is drawn. */
  const document_ = useRef<DocumentFind | undefined>(undefined);
  const detach = useRef<(() => void) | undefined>(undefined);
  /** Where the count is published, so the document's own repaint corrects it. */
  const watchers = useRef(new Set<(position: BodyFindPosition | undefined) => void>());
  /** Searches asked for before the body arrived (see `waitForDocument`). */
  const waiting = useRef<Array<() => void>>([]);

  const release = useCallback(() => {
    const waiters = waiting.current;
    waiting.current = [];
    for (const resolve of waiters) resolve();
  }, []);

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
        // A quarter of a megabyte of Markdown is a large tree to build. As a
        // transition it is built in slices the browser can interrupt, so the
        // window stays alive — the skeleton keeps drawing, another session
        // keeps streaming, the composer keeps taking keys — while it does.
        const text = parts.join("");
        startTransition(() => setBody({ text }));
      } catch (failure) {
        if (!signal.aborted) setBody({ error: bodyReadMessage(failure) });
      } finally {
        parts = [];
      }
    })();
    // Leaving the formatted view abandons the read and releases anyone waiting
    // on a document that will never be drawn.
    return () => { signal.aborted = true; release(); };
  }, [source, attempt, label, release]);

  const empty = body.text !== undefined && body.text.trim() === "";
  // A body that could not be read, or that has nothing in it, draws no
  // document: a search waiting for one is answered now rather than never.
  useEffect(() => { if (body.error !== undefined || empty) release(); }, [body.error, empty, release]);

  const place = useCallback((top: number) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
  }, []);
  const toStart = useCallback(() => place(0), [place]);
  const toEnd = useCallback(() => { const element = scroller.current; if (element) place(element.scrollHeight); }, [place]);

  const publishPosition = useCallback((position: BodyFindPosition | undefined) => {
    for (const watcher of watchers.current) watcher(position);
  }, []);

  // What the element hands up, and what this reader wants back from it: its
  // own highlight names, and its own idea of where a match should sit in the
  // reading region.
  const documentFind = useMemo<MarkdownDocumentFind>(() => ({
    highlight: HIGHLIGHT,
    publish(found) {
      detach.current?.();
      detach.current = undefined;
      document_.current = found;
      if (!found) return;
      detach.current = found.subscribe(publishPosition);
      release();
    },
    reveal(range) {
      const element = scroller.current;
      if (!element || typeof range.getBoundingClientRect !== "function") return;
      const box = range.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      // A match already in view is left where it is; the reader's eye does not
      // move for a match it is looking at.
      if (box.top < view.top || box.bottom > view.bottom) place(element.scrollTop + box.top - view.top - element.clientHeight / 3);
    },
  }), [place, publishPosition, release]);

  // The footer asks for the first search as soon as the viewer opens — which is
  // before the body has arrived. Waiting for the document is part of finding in
  // it, and the wait ends when the document is drawn, not on a clock. A search
  // that outlives the reader is dropped.
  const waitForDocument = useCallback(async (signal: { aborted: boolean }): Promise<DocumentFind | undefined> => {
    if (document_.current) return document_.current;
    await new Promise<void>(resolve => { waiting.current.push(resolve); });
    return signal.aborted ? undefined : document_.current;
  }, []);

  // The two worlds are named, because they differ: the formatted reader looks
  // through what is drawn, the plain one through the characters. `**bold**`,
  // a fence's backticks and a link's URL are in one and not in the other.
  const missing = useCallback(
    (query: string) => `“${query}” is not in this ${label} as it is drawn. Plain text searches its characters.`,
    [label],
  );
  // And nothing can be looked for in a body that could not be read: say that
  // instead of saying the phrase is not in it.
  const unread = useRef<string | undefined>(undefined);
  unread.current = body.error;

  const find = useMemo<BodyFind>(() => ({
    stepsBack: true,
    reset() { document_.current?.clear(); },
    subscribe(listener) {
      watchers.current.add(listener);
      return () => { watchers.current.delete(listener); };
    },
    async run(query, direction, signal) {
      const found = await waitForDocument(signal);
      if (signal.aborted || !found) return { found: false, notice: unread.current ?? missing(query) };
      const position = found.step(query, direction);
      if (!position) return { found: false, notice: missing(query) };
      return { found: true, position };
    },
  }), [missing, waitForDocument]);

  // What the footer drives in this reader. A formatted document has no lines
  // to wrap, so it offers no Wrap.
  const controls = useMemo<ReaderControls>(
    () => ({ find, onStart: toStart, onEnd: toEnd, error: body.error, onRetry: () => setAttempt(value => value + 1) }),
    [find, toStart, toEnd, body.error],
  );
  useEffect(() => publish(controls), [publish, controls]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home" && !event.shiftKey) { event.preventDefault(); toStart(); }
    else if (event.key === "End" && !event.shiftKey) { event.preventDefault(); toEnd(); }
  };

  const total = source.ref.totalBytes;

  return <div
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
    {body.text !== undefined ? (
      empty
        ? <p className="typed text-ink-3">This {label} is empty.</p>
        : <div data-slot="body-viewer-document">
            {/* The whole of it: nothing here is an excerpt, so code copied out
                of it is the code, unmarked. */}
            <MarkdownDocument text={body.text} measure="prose" excerpted={false} nativeFiles find={documentFind} />
          </div>
    ) : body.error !== undefined ? null : (
      <div data-slot="output-viewer-skeleton" aria-hidden="true" className="mx-auto flex max-w-(--measure-prose) flex-col gap-3">
        {SKELETON.map((share, index) => <SkeletonText key={index} width={share} />)}
      </div>
    )}
  </div>;
}

const SKELETON = ["46%", "92%", "88%", "70%", "30%", "84%", "78%"];
