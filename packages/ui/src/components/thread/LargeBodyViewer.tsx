"use client";
/**
 * The whole of a large body, read like what it is (M16-T60, D-275).
 *
 * A tool's output opens as that tool's output: its name, the command or the
 * arguments it ran with, how it ended and how long it took, and then the
 * decoded text on the terminal ground, with ANSI colour through the shared
 * `elements/ansi-text` decoder and real line breaks. Never the stored record's
 * JSON. A reply, reasoning or a prompt opens on the document ground and, when
 * the whole of it fits one reader's budget, formatted the way the transcript
 * draws it (`MarkdownBodyReader`, M16-T84) with Plain text one control away.
 *
 * The paged reader below is what a terminal body, and any body too large to
 * format as one document, is read with. It scrolls as one document, but the
 * window holds at most three segments of it — the one in view and its
 * neighbours (`OutputPager`). The rest of the
 * scroll height is estimated from the bytes and corrected as segments are
 * measured, holding the reader's place while it does. Copy and Download stream
 * the whole body from its authority and keep none of it afterwards; closing
 * the viewer drops everything it read.
 *
 * Full-screen on a phone, a large dialog on a desktop; Esc closes and focus
 * returns to the control that opened it.
 */
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { ansiSpanStyle } from "@/components/assistant-ui/elements/ansi-text";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { duration as formatDuration, formatBytes } from "@/format";
import { useCopy } from "@/hooks/use-copy";
import { parseAnsi, type AnsiStyle } from "@/lib/ansi";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import { type RangeRequest } from "@/runtime/body-reader";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import { registerEphemeralCache } from "@/runtime/pressure";
import { ViewerFooter, type BodyFind } from "./body-viewer-footer.js";
import { fitsMarkdownReader, MarkdownBodyReader } from "./MarkdownBodyReader.js";
import { charIndexAtByte, OUTPUT_SEGMENT_BYTES, OutputPager, type OutputSegment } from "./output-pager.js";
import type { copyWhole } from "./output-transfer.js";

/** What the viewer knows about the tool a body came from. Every field is optional. */
export interface OutputContext {
  toolName?: string | undefined;
  /** The command, or a readable summary of the arguments. */
  command?: string | undefined;
  state?: "running" | "awaiting" | "done" | "failed" | "nonzero" | "cancelled" | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
}

export interface LargeBodyViewerProps {
  ref_: BodyRef;
  path: string;
  /** The body's noun: "output", "reply", "reasoning", "message", "request". */
  label: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus?: HTMLElement | null | undefined;
  /** Look for this as soon as the viewer opens. */
  initialQuery?: string | undefined;
  tool?: OutputContext | undefined;
  tone?: "terminal" | "document" | undefined;
}

export function LargeBodyViewer({ ref_, path, label, open, onOpenChange, returnFocus, initialQuery, tool, tone = "terminal" }: LargeBodyViewerProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      data-slot="output-viewer"
      className={cn(
        "flex h-dvh max-h-dvh w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0",
        "sm:h-[calc(100dvh-var(--space-unit)*12)] sm:max-w-[min(calc(100%-var(--space-unit)*12),calc(var(--space-unit)*280))] sm:rounded-2xl sm:border",
        "pointer-coarse:[&>button]:size-11",
      )}
      onOpenAutoFocus={event => {
        // The output itself takes focus, so arrows and Page keys read it at once.
        const region = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]');
        if (region) { event.preventDefault(); region.focus({ preventScroll: true }); }
      }}
      onCloseAutoFocus={event => { if (returnFocus) { event.preventDefault(); returnFocus.focus(); } }}>
      {open ? <ViewerContents ref_={ref_} path={path} label={label} tool={tool} tone={tone} initialQuery={initialQuery} /> : null}
    </DialogContent>
  </Dialog>;
}

function toolStatus(tool: OutputContext | undefined): string | undefined {
  if (!tool) return undefined;
  if (tool.state === "running") return "Running";
  if (tool.state === "cancelled") return "Cancelled";
  if (tool.exitCode !== undefined) return `exit ${tool.exitCode}`;
  if (tool.state === "failed") return "Failed";
  if (tool.state === "done") return "Finished";
  return undefined;
}

function ViewerContents({ ref_, path, label, tool, tone, initialQuery }: {
  ref_: BodyRef; path: string; label: string; tool: OutputContext | undefined; tone: "terminal" | "document"; initialQuery: string | undefined;
}) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const body = isReadable(ref_) ? ref_ : undefined;
  const readable = body !== undefined;
  const revisionOf = useCallback(async (candidate: string) => (await client.request("session/revision", { path: candidate })).revision, [client]);
  const request = useCallback<RangeRequest>((params) => client.request("session/entry_range", params), [client]);
  const pager = useMemo(
    () => (body ? new OutputPager(request, path, body, environmentKey, revisionOf) : undefined),
    [body, request, path, environmentKey, revisionOf],
  );
  const transfer = useMemo<Parameters<typeof copyWhole>[0] | undefined>(
    () => (body ? { request, path, ref: body, environmentKey, revisionOf } : undefined),
    [body, request, path, environmentKey, revisionOf],
  );
  // A body written as prose is read formatted, unless it is larger than one
  // document may hold or the person asked for its characters. Both choices
  // last as long as the viewer is open, exactly like Wrap lines.
  const formattable = tone === "document" && readable && fitsMarkdownReader(ref_.totalBytes);
  const [formatted, setFormatted] = useState(true);
  const [wrap, setWrap] = useState(true);
  // Closing drops everything it read; memory pressure takes the neighbours.
  useEffect(() => {
    if (!pager) return;
    const forget = registerEphemeralCache({ clear: () => pager.releaseNeighbours() });
    return () => { forget(); pager.clear(); };
  }, [pager]);

  const status = toolStatus(tool);
  const title = `Full ${label}`;
  const fileBase = tool?.toolName ? `${tool.toolName} ${label}` : label;
  const { copy: copyCommand, copied: commandCopied } = useCopy();

  return <>
    <DialogHeader className="gap-1.5 border-b border-line px-4 pb-3 pt-4 pe-14 text-start">
      <DialogTitle className="text-base">{title}</DialogTitle>
      <DialogDescription className="typed flex min-w-0 flex-wrap items-center gap-x-2 text-ink-2">
        {[
          tool?.toolName ? <span key="tool" data-slot="output-viewer-tool" className="font-medium text-ink">{tool.toolName}</span> : null,
          status ? <span key="status" data-slot="output-viewer-status" className={cn(tool?.state === "failed" || tool?.state === "nonzero" ? "text-danger-quiet" : "text-ink-2")}>{status}</span> : null,
          tool?.durationMs !== undefined ? <span key="duration" className="tnum">{formatDuration(tool.durationMs)}</span> : null,
          <span key="size" className="tnum">{formatBytes(ref_.totalBytes)}</span>,
        ].filter(Boolean).flatMap((node, i) => i === 0 ? [node] : [<span key={`dot-${i}`} aria-hidden="true" className="text-ink-3">·</span>, node])}
      </DialogDescription>
      {tool?.command ? (
        <div data-slot="output-viewer-command" className="terminal mt-1 flex min-w-0 items-start gap-2 rounded-lg border border-terminal-line py-1.5 ps-3 pe-1">
          <span aria-hidden="true" className="select-none pt-0.5 text-terminal-ink-2">$</span>
          <pre dir="ltr" className="max-h-24 min-w-0 flex-1 overflow-auto whitespace-pre-wrap wrap-break-word pt-0.5 text-terminal-ink">{tool.command}</pre>
          <button
            type="button"
            aria-label={commandCopied ? "Command copied" : "Copy command"}
            onClick={() => void copyCommand(tool.command ?? "")}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-terminal-ink-2 outline-none transition-colors duration-(--motion-instant) hover:bg-terminal-line hover:text-terminal-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live pointer-coarse:size-11 motion-reduce:transition-none"
          >
            {commandCopied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
          </button>
        </div>
      ) : null}
    </DialogHeader>
    {pager && transfer
      ? formattable && formatted
        ? <MarkdownBodyReader source={transfer} label={label} fileBase={fileBase} initialQuery={initialQuery} onPlainText={() => setFormatted(false)} />
        : <OutputReader pager={pager} tone={tone} label={label} fileBase={fileBase} initialQuery={initialQuery} transfer={transfer}
            wrap={wrap} onWrap={() => setWrap(value => !value)}
            {...(formattable ? { format: { formatted: false, onChange: () => setFormatted(true) } } : {})}
            {...(tone === "document" && !formattable ? { note: `This ${label} is too long to format; showing plain text.` } : {})} />
      : <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <p className="typed text-ink-2">Full {label} available once it is saved.</p>
        </div>}
  </>;
}

interface Anchor { segment: number; within: number }

function OutputReader({ pager, tone, label, fileBase, initialQuery, transfer, wrap, onWrap, format, note }: {
  pager: OutputPager;
  tone: "terminal" | "document";
  label: string;
  fileBase: string;
  initialQuery: string | undefined;
  transfer: Parameters<typeof copyWhole>[0];
  wrap: boolean;
  onWrap(): void;
  format?: { formatted: boolean; onChange(formatted: boolean): void } | undefined;
  note?: string | undefined;
}) {
  const state = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getSnapshot);
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const metrics = useRef({ lineHeight: 16, charWidth: 7, padTop: 12, width: 600 });
  const [, setLayoutVersion] = useState(0);
  const anchor = useRef<Anchor>({ segment: 0, within: 0 });
  const stickToEnd = useRef(false);
  const programmaticTop = useRef<number | undefined>(undefined);
  const [hit, setHit] = useState<{ offset: number; length: number } | undefined>();
  const count = Math.max(1, Math.ceil(state.totalBytes / OUTPUT_SEGMENT_BYTES));
  const terminal = tone === "terminal";

  const bytesOf = (index: number) => Math.max(0, Math.min(OUTPUT_SEGMENT_BYTES, state.totalBytes - index * OUTPUT_SEGMENT_BYTES));

  // Estimated height per byte: what has been measured, or one wrapped line per
  // screen width of characters (one per eighty when lines are not wrapped).
  let measuredBytes = 0;
  let measuredPx = 0;
  for (const [index, px] of heights.current) { if (index < count) { measuredBytes += bytesOf(index); measuredPx += px; } }
  const { lineHeight, charWidth, width } = metrics.current;
  const perLine = wrap ? Math.max(20, Math.floor(width / Math.max(1, charWidth))) : 80;
  const pxPerByte = measuredBytes > 4096 ? measuredPx / measuredBytes : lineHeight / Math.min(perLine, 72);

  const tops: number[] = new Array(count + 1);
  tops[0] = 0;
  for (let index = 0; index < count; index++) {
    tops[index + 1] = tops[index]! + (heights.current.get(index) ?? Math.max(lineHeight, bytesOf(index) * pxPerByte));
  }
  const totalHeight = tops[count]!;

  const segmentAt = useCallback((y: number, list: number[]) => {
    let low = 0;
    let high = list.length - 2;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (list[mid]! <= y) low = mid; else high = mid - 1;
    }
    return Math.max(0, low);
  }, []);

  const topsRef = useRef(tops);
  topsRef.current = tops;

  const readMetrics = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    element.append(probe);
    const charWidth = probe.getBoundingClientRect().width / 10 || metrics.current.charWidth;
    probe.remove();
    metrics.current = {
      lineHeight: Number.parseFloat(style.lineHeight) || metrics.current.lineHeight,
      charWidth,
      padTop: Number.parseFloat(style.paddingTop) || 0,
      width: element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0),
    };
  }, []);

  const place = useCallback((top: number) => {
    const element = scroller.current;
    if (!element) return;
    const clamped = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
    // The reader's place moves with every programmatic scroll, so the next
    // layout pass holds this position and not the one before it.
    const list = topsRef.current;
    const y = clamped - metrics.current.padTop;
    const segment = segmentAt(Math.max(0, y), list);
    anchor.current = { segment, within: y - list[segment]! };
    programmaticTop.current = Math.round(clamped);
    element.scrollTop = clamped;
  }, [segmentAt]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const programmatic = programmaticTop.current !== undefined && Math.abs(element.scrollTop - programmaticTop.current) <= 1;
    programmaticTop.current = undefined;
    if (!programmatic && element.scrollHeight - element.scrollTop - element.clientHeight > 2) stickToEnd.current = false;
    const list = topsRef.current;
    const y = element.scrollTop - metrics.current.padTop;
    const top = segmentAt(Math.max(0, y), list);
    anchor.current = { segment: top, within: y - list[top]! };
    pager.show(segmentAt(Math.max(0, y + element.clientHeight / 2), list));
  }, [pager, segmentAt]);

  // Open at the start, measure the ground, and follow the window's size.
  useLayoutEffect(() => {
    readMetrics();
    setLayoutVersion(v => v + 1);
    pager.show(0);
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(element.clientWidth - lastWidth) < 1) return;
      lastWidth = element.clientWidth;
      readMetrics();
      heights.current.clear();
      setLayoutVersion(v => v + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pager, readMetrics]);

  // Wrapping changes every line's height: measure again from scratch, keeping
  // the reader on the segment they were reading.
  const firstWrap = useRef(true);
  useLayoutEffect(() => {
    if (firstWrap.current) { firstWrap.current = false; return; }
    heights.current.clear();
    setLayoutVersion(v => v + 1);
  }, [wrap]);

  // After every paint: measure the segments that are rendered, and if nothing
  // moved, hold the reader's place against whatever did change above it.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let changed = false;
    for (const run of element.querySelectorAll<HTMLElement>("[data-run]")) {
      const runTop = run.getBoundingClientRect().top;
      const marks = [...run.querySelectorAll<HTMLElement>("[data-segment]")];
      const starts = marks.map(mark => {
        const rect = mark.getClientRects()[0] ?? mark.getBoundingClientRect();
        return rect.top - runTop;
      });
      const runHeight = run.getBoundingClientRect().height;
      marks.forEach((mark, i) => {
        const index = Number(mark.dataset.segment);
        const height = Math.max(0, (i + 1 < marks.length ? starts[i + 1]! : runHeight) - (i === 0 ? 0 : starts[i]!));
        const previous = heights.current.get(index);
        if (height > 0 && (previous === undefined || Math.abs(previous - height) > 0.5)) {
          heights.current.set(index, height);
          changed = true;
        }
      });
    }
    if (changed) { setLayoutVersion(v => v + 1); return; }
    if (stickToEnd.current) { place(element.scrollHeight); return; }
    const list = topsRef.current;
    const desired = Math.max(0, Math.min((list[anchor.current.segment] ?? 0) + anchor.current.within + metrics.current.padTop, element.scrollHeight - element.clientHeight));
    if (Math.abs(element.scrollTop - desired) > 1) {
      programmaticTop.current = Math.round(desired);
      element.scrollTop = desired;
    }
  });

  const toStart = useCallback(() => {
    stickToEnd.current = false;
    place(0);
    pager.show(0);
  }, [pager, place]);
  const toEnd = useCallback(() => {
    stickToEnd.current = true;
    const element = scroller.current;
    const last = count - 1;
    if (element) place(element.scrollHeight);
    pager.show(last);
  }, [count, pager, place]);

  // Find: the hit's segment is read, then the hit is brought into view and marked.
  const revealHit = useCallback((offset: number, length: number) => {
    stickToEnd.current = false;
    const index = pager.segmentOf(offset);
    place((topsRef.current[index] ?? 0) + metrics.current.padTop);
    pager.show(index);
    setHit({ offset, length });
  }, [pager, place]);
  const reveal = useRef(revealHit);
  reveal.current = revealHit;

  // Looking through a body this reader does not hold: the authority is asked
  // for the next match from where the last one was, a slice at a time. Nothing
  // counts the matches, because counting them means reading all of it.
  const lastHit = useRef<{ query: string; offset: number } | undefined>(undefined);
  const find = useMemo<BodyFind>(() => ({
    reset() { lastHit.current = undefined; },
    async run(query, _direction, signal) {
      const from = lastHit.current?.query === query ? lastHit.current.offset + 1 : 0;
      let at = await pager.find(query, from, signal);
      // Past the last match, start again from the top once.
      if (at === undefined && from > 0 && !signal.aborted) at = await pager.find(query, 0, signal);
      if (signal.aborted) return { found: true };
      if (at === undefined) {
        lastHit.current = undefined;
        return { found: false, notice: `“${query}” is not in this ${label}.` };
      }
      lastHit.current = { query, offset: at };
      reveal.current(at, query.length);
      return { found: true };
    },
  }), [label, pager]);

  const held = [...state.segments.values()].sort((a, b) => a.index - b.index);
  const hitSegment = hit ? held.find(segment => hit.offset >= segment.start && hit.offset < segment.end) : undefined;
  // A hit inside the first bytes of a nominal segment may belong to the one before it.
  useEffect(() => {
    if (!hit || hitSegment) return;
    const index = pager.segmentOf(hit.offset);
    const segment = state.segments.get(index);
    if (segment && hit.offset < segment.start && index > 0) pager.show(index - 1);
  }, [hit, hitSegment, pager, state.segments]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    if (!hit || !hitSegment || !element) { highlights?.delete?.("output-viewer-find"); return; }
    const mark = element.querySelector<HTMLElement>(`[data-segment="${hitSegment.index}"]`);
    if (!mark) return;
    const raw = charIndexAtByte(hitSegment.text, hitSegment.start, hit.offset).index;
    // Escapes are not rendered, so the index is counted in what is.
    const rendered = terminal ? parseAnsi(hitSegment.text.slice(0, raw)).spans.reduce((sum, span) => sum + span.text.length, 0) : raw;
    const range = rangeAt(mark, rendered, hit.length);
    if (!range) return;
    const box = range.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) place(element.scrollTop + box.top - view.top - element.clientHeight / 3);
    if (highlights && typeof Highlight !== "undefined") highlights.set("output-viewer-find", new Highlight(range));
  }, [hit, hitSegment, place, terminal]);
  useEffect(() => () => { (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete?.("output-viewer-find"); }, []);

  // Contiguous held segments render as one flow, so a line that crosses a seam
  // stays one line.
  const runs: OutputSegment[][] = [];
  for (const segment of held) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.index === segment.index - 1) run.push(segment); else runs.push([segment]);
  }
  const placeholders = [...state.loading].filter(index => !state.segments.has(index));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home" && !event.shiftKey) { event.preventDefault(); toStart(); }
    else if (event.key === "End" && !event.shiftKey) { event.preventDefault(); toEnd(); }
  };

  const empty = state.totalBytes === 0;

  return <>
    <div
      ref={scroller}
      data-slot="output-viewer-scroller"
      data-wrap={wrap ? "true" : "false"}
      role="region"
      tabIndex={0}
      aria-label={`${label}, ${formatBytes(state.totalBytes)}`}
      aria-busy={state.loading.size > 0 || undefined}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      className={cn(
        "relative min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-3 outline-none [overflow-anchor:none]",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        terminal ? "terminal" : "bg-surface font-mono text-xs leading-sm text-ink",
      )}
    >
      <style>{"::highlight(output-viewer-find){background-color:var(--attention);color:var(--bg)}"}</style>
      {empty ? <p className={cn("typed", terminal ? "text-terminal-ink-2" : "text-ink-3")}>This {label} is empty.</p> : (
        <div className="relative" style={{ height: totalHeight }}>
          {runs.map(run => (
            <pre
              key={run[0]!.index}
              dir="ltr"
              data-run
              className={cn(
                "absolute inset-x-0 m-0 font-[inherit]",
                wrap ? "whitespace-pre-wrap wrap-break-word" : "w-max min-w-full whitespace-pre",
              )}
              style={{ top: tops[run[0]!.index] }}
            >
              <RunText run={run} ansi={terminal} />
            </pre>
          ))}
          {placeholders.map(index => (
            <div key={`loading-${index}`} data-slot="output-viewer-skeleton" aria-hidden="true" className="absolute inset-x-0 flex flex-col gap-2 pt-1" style={{ top: tops[index] }}>
              {SKELETON.map((share, i) => <div key={i} className={cn("h-3 rounded-xs", terminal ? "bg-terminal-line" : "bg-surface-2")} style={{ width: share }} />)}
            </div>
          ))}
        </div>
      )}
    </div>
    <ViewerFooter
      label={label}
      error={state.error}
      onRetry={() => pager.retry()}
      wrap={wrap}
      onWrap={onWrap}
      {...(format ? { format } : {})}
      {...(note ? { note } : {})}
      onStart={toStart}
      onEnd={toEnd}
      find={find}
      initialQuery={initialQuery}
      fileBase={fileBase}
      transfer={transfer}
    />
  </>;
}

const SKELETON = ["92%", "64%", "78%", "40%", "86%", "58%"];

/** One flow of contiguous segments; each starts with a mark the layout measures. */
function RunText({ run, ansi }: { run: OutputSegment[]; ansi: boolean }) {
  // Colour state carries across a seam inside the run, so a coloured line that
  // crosses one keeps its colour.
  const rendered = useMemo(() => {
    let style: AnsiStyle = {};
    return run.map(segment => {
      if (!ansi) return { segment, nodes: segment.text as ReactNode };
      const parsed = parseAnsi(segment.text, style);
      style = parsed.style;
      return {
        segment,
        nodes: parsed.spans.map((span, i) => (
          <span key={i} style={ansiSpanStyle(span)} className={cn(span.bold && "font-semibold", span.dim && "opacity-60", span.italic && "italic", span.underline && "underline", span.strike && "line-through")}>{span.text}</span>
        )) as ReactNode,
      };
    });
  }, [run, ansi]);
  return <>{rendered.map(({ segment, nodes }) => <span key={segment.index} data-segment={segment.index}>{nodes}</span>)}</>;
}

/** A DOM range over `length` rendered characters starting `at` inside `root`. */
function rangeAt(root: Node, at: number, length: number): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let start: { node: Text; offset: number } | undefined;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const size = node.data.length;
    if (!start && at < seen + size) start = { node, offset: at - seen };
    if (start && at + length <= seen + size) {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(node, at + length - seen);
      return range;
    }
    seen += size;
  }
  return undefined;
}

/**
 * What the clipboard gets when a person copies a part of a body: the text
 * itself, and an exact, unmistakable line saying what it is not.
 */
export function partial(text: string, from: number, to: number, total: number): string {
  if (total <= 0 || (from === 0 && to >= total)) return text;
  const before = from > 0 ? `[…${formatBytes(from)} earlier in this message is not included]\n` : "";
  const after = to < total ? `\n[…${formatBytes(total - to)} more of this message is not included]` : "";
  return `${before}${text}${after}`;
}
