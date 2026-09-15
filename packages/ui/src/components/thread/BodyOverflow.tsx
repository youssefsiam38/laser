"use client";
/**
 * "There is more of this message than this window is holding" (RP-5b).
 *
 * Never a silent truncation: the row says exactly how much is not shown, and
 * opening it reads the rest from the conversation's own authority, a bounded
 * slice at a time. While a reply is still being written the row says so
 * instead of offering something that cannot be read yet.
 */
import { useRef, useState } from "react";
import { useLaserStable, useLaserState } from "@/runtime";
import { findInBody } from "@/runtime/body-reader";
import { useFindQuery } from "./search-state.js";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/format";
import { cn } from "@/lib/utils";
import { isReadable, omittedBytes, type BodyRef } from "@/runtime/body-excerpt";
import { LargeBodyViewer } from "./LargeBodyViewer.js";

export interface BodyOverflowProps {
  body: BodyRef | undefined;
  path: string | undefined;
  /** What this body is, in a person's words: "reply", "reasoning", "output". */
  label: string;
  className?: string;
}

export function BodyOverflow({ body, path, label, className }: BodyOverflowProps) {
  const [open, setOpen] = useState(false);
  const [startOffset, setStartOffset] = useState<number | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const finding = useRef<HTMLButtonElement>(null);
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const query = useFindQuery();
  const missing = omittedBytes(body);
  if (!body || missing <= 0 || path === undefined) return null;
  const readable = isReadable(body);
  const title = `The whole ${label}`;
  return <div data-slot="body-overflow" className={cn("my-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2", className)}>
    <span className="typed text-sm text-ink-2">
      {readable
        ? `${formatBytes(missing)} more of this ${label} is not kept in this window.`
        : body.live
          ? `${formatBytes(missing)} of this ${label} is not kept while it is being written. It will be readable when the reply finishes.`
          : `${formatBytes(missing)} more of this ${label} is not kept in this window. Open this conversation again to read all of it.`}
    </span>
    {readable
      ? <>
          <Button ref={trigger} variant="ghost" className="min-h-11 px-2 underline underline-offset-2" onClick={() => { setStartOffset(undefined); setOpen(true); }}>
            Read all of it
          </Button>
          {query.trim()
            ? <Button ref={finding} variant="ghost" className="min-h-11 px-2 underline underline-offset-2" disabled={searching}
                onClick={() => {
                  setSearching(true);
                  setNotFound(false);
                  // The match is found in the conversation's own bytes, a slice
                  // at a time: nothing of the body comes back into this view.
                  void findInBody(
                    (params) => client.request("session/entry_range", params),
                    path,
                    body as typeof body & { entryId: string },
                    query.trim(),
                    { environmentKey, revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision },
                  ).then(at => {
                    setSearching(false);
                    if (at === undefined) { setNotFound(true); return; }
                    setStartOffset(at);
                    setOpen(true);
                  }, () => { setSearching(false); setNotFound(true); });
                }}>
                {searching ? "Looking…" : `Find “${query.trim()}” in the rest`}
              </Button>
            : null}
          {notFound ? <span role="status" className="typed text-sm text-ink-2">Not in the part of this {label} that is not shown.</span> : null}
          <LargeBodyViewer ref_={body} path={path} title={title} open={open} onOpenChange={setOpen} returnFocus={(startOffset === undefined ? trigger.current : finding.current) ?? trigger.current} startOffset={startOffset} />
        </>
      : null}
  </div>;
}
