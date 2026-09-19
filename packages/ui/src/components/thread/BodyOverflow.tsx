"use client";
/**
 * The end of a body this window holds only part of (RP-5b, M16-T60, D-275).
 *
 * Not a box of its own between rows: it is the last thing inside the surface
 * that shows the body — a terminal block, a result, a reply — a fade over the
 * part that is shown and one quiet action that opens the whole of it,
 * "Show full output · 93 KB". While the body is still being written there is
 * nothing to open yet, and the fold says when there will be, without an
 * action.
 *
 * The noun is the body's own: output, request, reply, reasoning, message.
 */
import { Maximize2, Search } from "lucide-react";
import { useRef, useState } from "react";

import { formatBytes } from "@/format";
import { cn } from "@/lib/utils";
import { isReadable, omittedBytes, type BodyRef } from "@/runtime/body-excerpt";
import { useDialogPresence } from "./dialog-presence.js";
import { LargeBodyViewer, type OutputContext } from "./LargeBodyViewer.js";
import { useFindQuery } from "./search-state.js";

/** The ground the fold sits on, so the fade dissolves into the right colour. */
export type FoldGround = "terminal" | "surface" | "surface-2" | "bg";

export interface BodyOverflowProps {
  body: BodyRef | undefined;
  path: string | undefined;
  /** What this body is, in a person's words: "output", "request", "reply", "reasoning", "message". */
  label: string;
  ground?: FoldGround | undefined;
  /** Draw the fade over what is shown above. Off when nothing is shown above. */
  fade?: boolean | undefined;
  /** What finishing means for this body: "the command finishes", "the reply finishes". */
  finishes?: string | undefined;
  /** The tool this body belongs to, for the viewer's header. */
  tool?: OutputContext | undefined;
  className?: string | undefined;
}

const FADE: Record<FoldGround, string> = {
  terminal: "before:from-terminal",
  surface: "before:from-surface",
  "surface-2": "before:from-surface-2",
  bg: "before:from-bg",
};

const ACTION: Record<FoldGround, string> = {
  terminal: "text-terminal-ink-2 hover:text-terminal-ink hover:bg-terminal-line active:bg-terminal-line",
  surface: "text-ink-2 hover:text-ink hover:bg-surface-2 active:bg-surface-2",
  "surface-2": "text-ink-2 hover:text-ink hover:bg-surface active:bg-surface",
  bg: "text-ink-2 hover:text-ink hover:bg-surface-2 active:bg-surface-2",
};

export function BodyOverflow({ body, path, label, ground = "surface", fade = true, finishes, tool, className }: BodyOverflowProps) {
  // A closed Radix dialog only leaves the document when its exit animation
  // ends, and with motion reduced there is none (`dialog-presence.ts`).
  const viewer = useDialogPresence();
  const [query, setQuery] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const finding = useRef<HTMLButtonElement>(null);
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null);
  const conversationQuery = useFindQuery().trim();
  const missing = omittedBytes(body);
  if (!body || missing <= 0 || path === undefined) return null;
  const readable = isReadable(body);
  const terminal = ground === "terminal";
  const quiet = cn("typed px-3 py-1.5", terminal ? "text-terminal-ink-2" : "text-ink-3");

  return (
    <div
      data-slot="body-overflow"
      data-state={readable ? "readable" : body.live ? "live" : "pending"}
      className={cn(
        "relative flex min-w-0 flex-wrap items-center gap-x-1",
        fade && readable && "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-10 before:bg-linear-to-t before:to-transparent",
        fade && readable && FADE[ground],
        className,
      )}
    >
      {readable ? (
        <>
          <button
            ref={trigger}
            type="button"
            data-slot="body-overflow-open"
            onClick={() => { setQuery(undefined); setReturnTo(trigger.current); viewer.show(); }}
            className={cn(
              "inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-3 text-start text-sm font-medium outline-none pointer-coarse:min-h-11",
              "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              ACTION[ground],
            )}
          >
            <Maximize2 aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              Show full {label}
              <span className="font-normal"> · <span className="tnum">{formatBytes(body.totalBytes)}</span></span>
            </span>
          </button>
          {conversationQuery ? (
            <button
              ref={finding}
              type="button"
              data-slot="body-overflow-find"
              onClick={() => { setQuery(conversationQuery); setReturnTo(finding.current); viewer.show(); }}
              className={cn(
                "inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-3 text-start text-sm outline-none pointer-coarse:min-h-11",
                "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                ACTION[ground],
              )}
            >
              <Search aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">Find “{conversationQuery}” in full {label}</span>
            </button>
          ) : null}
          {viewer.mounted ? <LargeBodyViewer
            ref_={body}
            path={path}
            label={label}
            open={viewer.open}
            onOpenChange={(next) => { if (!next) viewer.hide(); }}
            returnFocus={returnTo}
            initialQuery={query}
            tool={tool}
            tone={terminal ? "terminal" : "document"}
          /> : null}
        </>
      ) : body.live ? (
        <p className={quiet}>Full {label} available when {finishes ?? "it finishes"}</p>
      ) : (
        <p className={quiet}>Full {label} available once it is saved</p>
      )}
    </div>
  );
}
