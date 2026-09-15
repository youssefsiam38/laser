"use client";
/**
 * The files a prompt carries that its row does not show (RP-5b §2).
 *
 * A prompt this window only points at can hold more attachments than a row
 * should ever list. This is where the rest of them are: **one page at a time**,
 * asked for from the conversation's own authority, shown as the same chips the
 * row shows, and opened the same way — read back as a verified region.
 *
 * One page is held. Moving on discards the one before it, closing discards all
 * of it, and a reply that arrives after any of that is dropped rather than
 * shown: there is no page history here, and nothing accumulates.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import { bodyReadMessage, readAttachmentRegions } from "@/runtime/body-reader";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import type { AttachmentRegions } from "@lasercode/protocol";

export interface AttachmentBrowserProps {
  /** The prompt body whose attachments these are. */
  body: BodyRef;
  path: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when this closes. */
  returnFocus?: HTMLElement | null | undefined;
  /** Open one of them, exactly as a chip in the row is opened. */
  onOpen?: ((file: { name: string; mediaType: string; ref: BodyRef }, trigger: HTMLElement) => void) | undefined;
}

export function AttachmentBrowser({ body, path, open, onOpenChange, returnFocus, onOpen }: AttachmentBrowserProps) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const [page, setPage] = useState<AttachmentRegions>();
  const [from, setFrom] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  /**
   * Which read owns this surface. A page that was asked for before a close, an
   * environment change or a step to another page belongs to nobody when it
   * lands, and is dropped without touching what is on screen.
   */
  const generation = useRef(0);
  /** A person asking again for the same page. */
  const [attempt, setAttempt] = useState(0);

  const discard = useCallback(() => {
    generation.current += 1;
    setPage(undefined);
    setFrom(undefined);
    setError(undefined);
    setLoading(false);
    setAttempt(0);
  }, []);

  // Closing, a different prompt, a different environment: nothing survives.
  useEffect(() => { if (!open) discard(); }, [discard, open]);
  useEffect(() => discard, [discard, body.entryId, body.revision, environmentKey, path]);

  useEffect(() => {
    if (!open || path === undefined || !isReadable(body)) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(undefined);
    void readAttachmentRegions(
      (params) => client.request("session/entry_regions", params),
      (params) => client.request("session/entry_range", params),
      path,
      body,
      {
        environmentKey,
        revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision,
        ...(from !== undefined ? { from } : {}),
      },
    ).then(
      (answer) => {
        if (mine !== generation.current) return;
        // The page before this one goes now, not when the next arrives.
        setPage(answer);
        setLoading(false);
      },
      (failure) => {
        if (mine !== generation.current) return;
        setError(bodyReadMessage(failure));
        setLoading(false);
      },
    );
  }, [attempt, body, client, environmentKey, from, open, path]);

  const more = page?.truncated
    ? "More attachments in this message"
    : page?.omitted
      ? `${page.omitted} more ${page.omitted === 1 ? "attachment" : "attachments"} in this message`
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80dvh] w-full flex-col gap-0 p-0 sm:max-w-lg"
        onCloseAutoFocus={event => { if (returnFocus) { event.preventDefault(); returnFocus.focus(); } }}
      >
        <DialogHeader className="shrink-0 border-b border-line p-4 pe-12">
          <DialogTitle>Files in this message</DialogTitle>
          <DialogDescription>{more ?? "Everything this message carries."}</DialogDescription>
        </DialogHeader>
        <div data-slot="attachment-browser-list" className="min-h-0 flex-1 overflow-auto p-4">
          {error ? (
            <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center text-ink-2">
              <p>{error}</p>
              <Button variant="outline" className="min-h-11" onClick={() => setAttempt(value => value + 1)}>
                Try again
              </Button>
            </div>
          ) : loading && !page ? (
            <div role="status" className="flex items-center justify-center py-6"><GenerationLoader label="Reading this message" /></div>
          ) : page && page.items.length === 0 ? (
            <p className="py-6 text-center text-ink-3">No files in this message.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(page?.items ?? []).map(item => (
                <li key={`${item.offset}:${item.bytes}`}>
                  <button
                    type="button"
                    data-slot="attachment-browser-item"
                    onClick={event => onOpen?.({ name: item.name, mediaType: item.mediaType, ref: { ...body, region: { offset: item.offset, bytes: item.bytes }, contentDigest: item.contentDigest } }, event.currentTarget)}
                    className={cn(paper, "flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-ink-2 outline-none transition-colors duration-(--motion-instant) hover:border-ink-3 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}
                  >
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate" title={item.name}>{item.name}</span>
                      <span className="truncate text-xs text-ink-3">{item.mediaType} · {formatBytes(item.bytes)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line p-4">
          <span className="text-xs text-ink-3">{more ?? ""}</span>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading || page?.next === undefined}
            onClick={() => { const next = page?.next; if (next !== undefined) { setPage(undefined); setFrom(next); } }}
          >
            {loading ? "Reading…" : "Next"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
