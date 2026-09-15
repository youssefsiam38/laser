"use client";
/**
 * Reading the part of a message this window does not hold (RP-5b).
 *
 * A transcript keeps a bounded excerpt of a very large reply, reasoning trace
 * or tool result; the rest lives with the conversation's own authority. This
 * viewer reads it a slice at a time and never holds more than
 * {@link BODY_VIEWER_AGGREGATE_MAX_BYTES}: paging forward drops what is
 * furthest behind, so a thirty-megabyte output is readable without ever
 * building a thirty-megabyte string or a DOM to match.
 *
 * It is deliberately the same shape as `FileViewer`: one dialog, one preview,
 * designed loading, error and end states, a copy control that says exactly
 * what it copied, and a keyboard path for everything the pointer can do.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { TextPreview } from "@/components/preview/TextPreview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCopy } from "@/hooks/use-copy";
import { useLaserStable, useLaserState } from "@/runtime";
import { bodyReadMessage, BodyWindow, BODY_VIEWER_AGGREGATE_MAX_BYTES } from "@/runtime/body-reader";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import { formatBytes } from "@/format";

export interface LargeBodyViewerProps {
  ref_: BodyRef;
  path: string;
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus?: HTMLElement | null | undefined;
  /** Where to start reading, when a search hit named a place. */
  startOffset?: number | undefined;
}

export function LargeBodyViewer({ ref_, path, title, open, onOpenChange, returnFocus, startOffset }: LargeBodyViewerProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className="flex h-dvh max-h-dvh w-full max-w-full flex-col gap-0 rounded-none p-0 sm:max-w-[calc(100%-var(--space-unit)*8)] sm:rounded-xl pointer-coarse:[&>button]:size-11"
      onCloseAutoFocus={event => { if (returnFocus) { event.preventDefault(); returnFocus.focus(); } }}>
      {open ? <ViewerContents ref_={ref_} path={path} title={title} startOffset={startOffset} /> : null}
    </DialogContent>
  </Dialog>;
}

function ViewerContents({ ref_, path, title, startOffset }: { ref_: BodyRef; path: string; title: string; startOffset?: number | undefined }) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const { copy, copied } = useCopy();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const body = useMemo(
    () => isReadable(ref_)
      ? new BodyWindow(
          (params) => client.request("session/entry_range", params),
          path,
          ref_,
          BODY_VIEWER_AGGREGATE_MAX_BYTES,
          environmentKey,
          async (candidate) => (await client.request("session/revision", { path: candidate })).revision,
        )
      : undefined,
    [client, path, ref_, environmentKey],
  );
  const state = useSyncExternalStore(
    body?.subscribe ?? noStore,
    body?.getSnapshot ?? emptyState,
    body?.getSnapshot ?? emptyState,
  );
  const region = useRef<HTMLDivElement>(null);

  const step = useCallback(async (run: () => Promise<void>) => {
    setLoading(true);
    setError(undefined);
    try { await run(); } catch (failure) { setError(bodyReadMessage(failure)); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!body) { setLoading(false); return; }
    void step(() => startOffset === undefined ? body.more() : body.jump(startOffset));
    return () => body.clear();
  }, [body, startOffset, step]);

  const shown = state.slices.map(slice => slice.text).join("");
  const from = state.slices[0]?.offset ?? ref_.excerpt.offset;
  const to = from + state.heldBytes;
  const atEnd = state.next === undefined && state.slices.length > 0;

  if (!isReadable(ref_)) {
    return <Unreadable title={title} />;
  }

  return <>
    <DialogHeader className="border-b border-line px-4 py-3">
      <DialogTitle className="text-base">{title}</DialogTitle>
      <DialogDescription className="typed text-sm text-ink-2">
        {state.totalBytes > 0
          ? `Showing ${formatBytes(from)}–${formatBytes(to)} of ${formatBytes(state.totalBytes)}${state.evicted > 0 ? " · earlier parts were released to keep this window small" : ""}`
          : "Reading this message from the conversation it belongs to."}
      </DialogDescription>
    </DialogHeader>
    <div
      ref={region}
      tabIndex={0}
      role="region"
      aria-label={`${title}, ${formatBytes(state.totalBytes)}`}
      className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-live"
      onKeyDown={event => {
        if (event.key === "PageDown" || event.key === "End") { event.preventDefault(); if (!atEnd) void step(() => body!.more()); }
        if (event.key === "Home") { event.preventDefault(); void step(() => body!.jump(0)); }
      }}>
      {error ? <ErrorState message={error} onRetry={() => void step(() => body!.more())} />
        : shown ? <TextPreview text={shown} className="min-h-0" />
        : loading ? <GenerationLoader label="Reading this message…" />
        : <p className="p-4 text-sm text-ink-2">There is nothing more to read here.</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
      <span className="typed text-sm text-ink-2" role="status">
        {atEnd ? "You have reached the end of this message." : loading ? "Reading…" : `${formatBytes(Math.max(0, state.totalBytes - to))} more`}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" className="min-h-11" onClick={() => copy(shown)}>{copied ? "Copied what is shown" : "Copy what is shown"}</Button>
        <Button className="min-h-11" disabled={atEnd || loading} onClick={() => void step(() => body!.more())}>Show more</Button>
      </div>
    </footer>
  </>;
}

function Unreadable({ title }: { title: string }) {
  return <>
    <DialogHeader className="border-b border-line px-4 py-3">
      <DialogTitle className="text-base">{title}</DialogTitle>
      <DialogDescription className="text-sm text-ink-2">
        This reply is still being written. The whole of it can be read as soon as it finishes.
      </DialogDescription>
    </DialogHeader>
    <div className="flex-1 p-4 text-sm text-ink-2">Nothing to read yet.</div>
  </>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry(): void }) {
  return <div className="flex flex-col items-start gap-3 p-4">
    <p className="text-sm text-ink" role="alert">{message}</p>
    <Button variant="ghost" className="min-h-11" onClick={onRetry}>Try again</Button>
  </div>;
}

const noStore = () => () => {};
const emptyState = () => ({ slices: [], totalBytes: 0, heldBytes: 0, evicted: 0 });
