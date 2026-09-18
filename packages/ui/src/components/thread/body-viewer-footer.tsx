"use client";
/**
 * The controls under a large body's reading area (M16-T60, M16-T84).
 *
 * One footer for both readers, because a person reading a reply and a person
 * reading a command's output want the same five things: find something in it,
 * go to its start or its end, copy it, save it, and — for a body written as
 * prose — choose between reading it formatted and reading exactly the
 * characters it is made of.
 *
 * Finding is the reader's own work, behind {@link BodyFind}: the paged plain
 * reader looks for the next match in the body's bytes through its authority,
 * a slice at a time; the formatted reader looks in the document it has already
 * rendered, counts every match and can step backwards through them. The footer
 * owns only the field, the state of the last search and the words said about
 * it. Copy and Download never change: they stream the whole body from its
 * authority as the raw text it is, formatted or not.
 *
 * It is mounted once per viewer opening, above both readers, and the reader
 * that is showing hands up its {@link ReaderControls} (M16-T84). Choosing
 * Plain text therefore changes the reading area and nothing else: the phrase
 * the person typed, the match they are on and the focused control all stay
 * where they were, and the query the viewer was opened with is run once, on
 * opening, never again.
 */
import { ArrowDownToLine, ArrowUpToLine, Check, ChevronDown, ChevronUp, Copy, Download, Search, Type, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";
import { bodyReadMessage } from "@/runtime/body-reader";
import { copyWhole, downloadWhole, outputFileName } from "./output-transfer.js";

/** What one search answered: where it landed, or why it landed nowhere. */
export type BodyFindOutcome =
  | { found: true; position?: { index: number; total: number } | undefined }
  | { found: false; notice: string };

/** Where the current search stands: "3 of 12". */
export type BodyFindPosition = { index: number; total: number };

/** How one reader looks through the body it is showing. */
export interface BodyFind {
  /** Move to the next (or previous) match and reveal it. */
  run(query: string, direction: 1 | -1, signal: { aborted: boolean }): Promise<BodyFindOutcome>;
  /** Whether this reader can step backwards through its matches. */
  stepsBack?: boolean | undefined;
  /** The query changed: forget where the last search stopped. */
  reset?(): void;
  /**
   * A reader whose document settles after it is drawn — highlighted code,
   * rendered math — republishes where the search stands each time it repaints,
   * so the count and the marks can never disagree.
   */
  subscribe?(listener: (position: BodyFindPosition | undefined) => void): () => void;
}

/** What the reader that is showing gives the footer to work with. */
export interface ReaderControls {
  find: BodyFind;
  onStart(): void;
  onEnd(): void;
  /** What went wrong reading this body, in the person's words. */
  error: string | undefined;
  onRetry(): void;
  /** Absent when the reading area has no lines to wrap (a formatted document). */
  wrap?: { wrap: boolean; onWrap(): void } | undefined;
}

export interface ViewerFooterProps {
  label: string;
  /** The reader that is showing, and everything the footer drives in it. */
  controls: ReaderControls;
  /** The choice between the formatted document and its characters. Absent when there is no choice. */
  format?: { formatted: boolean; onChange(formatted: boolean): void } | undefined;
  /** One quiet sentence about how this body is being shown. */
  note?: string | undefined;
  initialQuery: string | undefined;
  fileBase: string;
  transfer: Parameters<typeof copyWhole>[0];
}

export function ViewerFooter({ label, controls, format, note, initialQuery, fileBase, transfer }: ViewerFooterProps) {
  const { find: finder, onStart, onEnd, error, onRetry, wrap } = controls;
  const { copy, copied, markCopied } = useCopy();
  const [busy, setBusy] = useState<"copy" | "download" | "find" | undefined>();
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [found, setFound] = useState<string>();
  const [position, setPosition] = useState<{ index: number; total: number }>();
  const findAbort = useRef<{ aborted: boolean } | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);

  const find = useCallback(async (value: string, direction: 1 | -1 = 1) => {
    const needle = value.trim();
    if (!needle) return;
    findAbort.current && (findAbort.current.aborted = true);
    const signal = { aborted: false };
    findAbort.current = signal;
    setBusy("find");
    setNotice(undefined);
    try {
      const outcome = await finder.run(needle, direction, signal);
      if (signal.aborted) return;
      if (outcome.found) {
        setFound(needle);
        setPosition(outcome.position);
        setNotice(undefined);
      } else {
        setFound(undefined);
        setPosition(undefined);
        setNotice(outcome.notice);
      }
    } catch (failure) {
      if (!signal.aborted) setNotice(bodyReadMessage(failure));
    } finally {
      if (!signal.aborted) setBusy(undefined);
    }
  }, [finder]);

  useEffect(() => {
    if (initialQuery) void find(initialQuery);
    return () => { if (findAbort.current) findAbort.current.aborted = true; };
    // Only on open, and this footer is mounted once per opening: the query the
    // viewer was opened with belongs to that moment, not to every later change
    // of reader. Later searches are the person's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The reader changed underneath the same search (Plain text, and back). The
  // person keeps their phrase, and the new reader is asked for the match they
  // were on — never for the query the viewer happened to open with.
  const lastFinder = useRef(finder);
  const lastFound = useRef(found);
  lastFound.current = found;
  useEffect(() => {
    if (lastFinder.current === finder) return;
    lastFinder.current = finder;
    setPosition(undefined);
    if (lastFound.current) void find(lastFound.current);
  }, [finder, find]);

  // A document settles after it is drawn — code is highlighted, math is laid
  // out — and the reader republishes where the search stands when it does.
  useEffect(() => finder.subscribe?.(setPosition), [finder]);

  const copyAll = async () => {
    setBusy("copy");
    setNotice(undefined);
    try {
      const outcome = await copyWhole(transfer, copy);
      if (outcome.ok) markCopied();
      else if ("message" in outcome) setNotice(outcome.message);
    } catch (failure) {
      setNotice(bodyReadMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };
  const download = async () => {
    setBusy("download");
    setNotice(undefined);
    try {
      const outcome = await downloadWhole(transfer, outputFileName(fileBase));
      if (!outcome.ok && "message" in outcome) setNotice(outcome.message);
    } catch (failure) {
      setNotice(bodyReadMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const searching = found === query.trim() && query.trim().length > 0;
  const control = "pointer-coarse:min-h-11";
  return <footer data-slot="output-viewer-footer" className="flex flex-col gap-2 border-t border-line bg-surface px-3 py-2 pb-[max(var(--space-unit)*2,env(safe-area-inset-bottom))]">
    {error || notice ? (
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-1">
        <p role={error ? "alert" : "status"} className="min-w-0 flex-1 text-sm text-ink">{error ?? notice}</p>
        {error ? <Button variant="outline" size="sm" className={control} onClick={onRetry}>Try again</Button> : null}
      </div>
    ) : null}
    {note ? <p data-slot="output-viewer-note" className="px-1 text-sm text-ink-2">{note}</p> : null}
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <form
        role="search"
        className="flex min-w-0 flex-1 basis-56 items-center gap-1"
        onSubmit={event => { event.preventDefault(); void find(query); }}
      >
        <label className="relative flex min-w-0 flex-1 items-center">
          <span className="sr-only">Find in {label}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute start-2.5 size-3.5 text-ink-3" />
          <input
            ref={field}
            type="search"
            value={query}
            maxLength={1024}
            onChange={event => { setQuery(event.target.value); setFound(undefined); setPosition(undefined); finder.reset?.(); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.key !== "Enter" || !finder.stepsBack || !event.shiftKey) return;
              event.preventDefault();
              void find(query, -1);
            }}
            placeholder={`Find in ${label}`}
            className="h-8 w-full min-w-0 rounded-lg border border-line bg-surface ps-8 pe-2.5 text-sm text-ink outline-none transition-[border-color] duration-(--motion-instant) placeholder:text-ink-3 focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25 pointer-coarse:h-11"
          />
        </label>
        {position ? (
          <span data-slot="output-viewer-find-count" role="status" className="shrink-0 whitespace-nowrap text-sm text-ink-2 tnum">
            {position.index} of {position.total}
          </span>
        ) : null}
        {finder.stepsBack ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Previous match in ${label}`} aria-keyshortcuts="Shift+Enter" className={cn(control, "pointer-coarse:size-11")}
            disabled={!searching || busy === "find"} onClick={() => void find(query, -1)}>
            <ChevronUp aria-hidden="true" />
          </Button>
        ) : null}
        {finder.stepsBack ? (
          <Button type="submit" variant="ghost" size="icon-sm" aria-label={searching ? `Next match in ${label}` : `Find in ${label}`} aria-keyshortcuts="Enter" className={cn(control, "pointer-coarse:size-11")}
            disabled={!query.trim() || busy === "find"}>
            <ChevronDown aria-hidden="true" />
          </Button>
        ) : (
          <Button type="submit" variant="ghost" size="sm" className={control} disabled={!query.trim() || busy === "find"}>
            {busy === "find" ? "Finding…" : searching ? "Next" : "Find"}
          </Button>
        )}
      </form>
      <div className="flex flex-wrap items-center gap-1 max-sm:w-full max-sm:justify-between">
        {format ? (
          <Button variant="ghost" size="sm" aria-pressed={!format.formatted} aria-label="Plain text"
            className={cn(control, !format.formatted && "bg-surface-2 text-ink")} onClick={() => format.onChange(!format.formatted)}>
            <Type aria-hidden="true" />
            <span>Plain text</span>
          </Button>
        ) : null}
        {wrap ? (
          <Button variant="ghost" size="sm" aria-pressed={wrap.wrap} aria-label="Wrap lines" className={cn(control, wrap.wrap && "bg-surface-2 text-ink")} onClick={wrap.onWrap}>
            <WrapText aria-hidden="true" />
            <span>Wrap lines</span>
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Go to start" className={cn(control, "pointer-coarse:size-11")} onClick={onStart}><ArrowUpToLine aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Go to end" className={cn(control, "pointer-coarse:size-11")} onClick={onEnd}><ArrowDownToLine aria-hidden="true" /></Button>
        <Button variant="ghost" size="sm" className={control} disabled={busy === "copy"} onClick={() => void copyAll()}
          aria-label={busy === "copy" ? `Copying the full ${label}` : copied ? "Copied" : `Copy full ${label}`}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span className="max-sm:sr-only">{busy === "copy" ? "Copying…" : copied ? "Copied" : "Copy"}</span>
        </Button>
        <Button variant="outline" size="sm" className={control} disabled={busy === "download"} onClick={() => void download()}
          aria-label={busy === "download" ? `Saving the full ${label}` : "Download .txt"}>
          <Download aria-hidden="true" />
          <span className="max-sm:sr-only">{busy === "download" ? "Saving…" : "Download .txt"}</span>
        </Button>
      </div>
    </div>
  </footer>;
}
