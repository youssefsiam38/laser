"use client";
/**
 * The body of a `document` island (M8-T3) — one component the dock mounts for
 * every document panel, whatever it turns out to hold.
 *
 * It owns exactly two decisions and no chrome. The island's header, its four
 * sizes and the morph between them belong to the panel system; a body only
 * fills the space it is given and scrolls inside it (R13: nothing overflows,
 * the page never scrolls sideways).
 *
 *   1. **Which renderer.** `media.ts` maps the panel's media type — broken ties
 *      by path — onto markdown, diff, image or text, and refuses to guess for
 *      anything else. A panel that declares `renderable: false` is taken at its
 *      word even when the media type looks familiar: the producer knows
 *      something we do not.
 *
 *   2. **What "not here yet" looks like.** Loading, failed-to-read and empty
 *      are drawn on purpose, in the same words a person would use, because a
 *      panel reading a 4 MB file over a relay spends real time in each of them.
 *
 * Content arrives already read. Ranged reads over `pi/panel/read` — including
 * the base64 → data URL step for images — belong to whoever owns the panel
 * store; keeping them out of here is what makes every state below testable and
 * every renderer reusable outside a panel.
 */
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { DocumentPanel } from "@piorbit/protocol";

import { DiffPreview } from "./DiffPreview.js";
import { ImagePreview } from "./ImagePreview.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { OpenExternally } from "./OpenExternally.js";
import { TextPreview } from "./TextPreview.js";
import { previewKindFor } from "./media.js";

/**
 * What the panel reader has for us. `text` for utf8 refs and `inline`; `src`
 * (a data: or blob: URL) for the binary ones. `truncated` says the read stopped
 * at the cap — the bodies say so rather than implying the file ends there.
 */
export type DocumentContent =
  | { status: "loading" }
  | { status: "ready"; text?: string | undefined; src?: string | undefined; truncated?: boolean | undefined }
  | { status: "error"; message: string };

export interface DocumentBodyProps {
  panel: DocumentPanel;
  content: DocumentContent;
  /** Read it again, after a failure. Omitted when the caller cannot retry. */
  onRetry?: (() => void) | undefined;
  /** Open with the OS handler — desktop only, so absent elsewhere (R2). */
  onOpenExternally?: (() => void) | undefined;
  className?: string | undefined;
}

export function DocumentBody({ panel, content, onRetry, onOpenExternally, className }: DocumentBodyProps) {
  const frame = cn("flex min-h-0 min-w-0 flex-1 flex-col", className);
  const kind = previewKindFor(panel.mediaType, panel.path);

  // The producer said not to draw it. That wins over our own table: it knows
  // its content, we only know its label.
  if (!panel.renderable || kind === "none") {
    return (
      <div data-slot="document-body" className={frame}>
        <OpenExternally
          mediaType={panel.mediaType}
          {...(panel.path !== undefined ? { path: panel.path } : {})}
          {...(onOpenExternally ? { onOpen: onOpenExternally } : {})}
        />
      </div>
    );
  }

  if (content.status === "loading") {
    return (
      <div data-slot="document-body" className={frame} aria-busy="true">
        <LoadingBody kind={kind} />
      </div>
    );
  }

  if (content.status === "error") {
    return (
      <div data-slot="document-body" className={frame}>
        <ReadFailed message={content.message} {...(onRetry ? { onRetry } : {})} />
      </div>
    );
  }

  if (kind === "image") {
    if (!content.src) {
      return (
        <div data-slot="document-body" className={frame}>
          <ReadFailed
            message="The image arrived without any bytes. Reading it again usually fixes this."
            {...(onRetry ? { onRetry } : {})}
          />
        </div>
      );
    }
    return (
      <div data-slot="document-body" className={frame}>
        <ImagePreview src={content.src} alt={panel.title} className="flex-1" />
      </div>
    );
  }

  const text = content.text ?? "";
  if (text.trim() === "") {
    return (
      <div data-slot="document-body" className={frame}>
        <Empty />
      </div>
    );
  }

  return (
    <div data-slot="document-body" className={frame}>
      {kind === "markdown" ? (
        <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
          <MarkdownPreview text={text} />
          {content.truncated ? <TruncationNote /> : null}
        </div>
      ) : kind === "diff" ? (
        <DiffPreview
          patch={text}
          {...(panel.path !== undefined ? { path: panel.path } : {})}
          {...(content.truncated !== undefined ? { truncated: content.truncated } : {})}
          className="flex-1"
        />
      ) : (
        <TextPreview
          text={text}
          {...(content.truncated !== undefined ? { truncated: content.truncated } : {})}
          className="flex-1"
        />
      )}
    </div>
  );
}

/**
 * The loading state is shaped like what is coming — prose lines for markdown,
 * a dense block for a diff, one rectangle for an image — so the body does not
 * jump when the content lands.
 */
function LoadingBody({ kind }: { kind: "markdown" | "diff" | "image" | "text" }) {
  if (kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <SkeletonText className="h-40 w-full max-w-sm rounded-md" />
      </div>
    );
  }
  const widths =
    kind === "markdown"
      ? ["55%", "100%", "92%", "97%", "40%", "100%", "88%"]
      : ["100%", "84%", "96%", "72%", "100%", "90%", "63%", "100%"];
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2 px-4 py-3", kind === "markdown" ? "gap-2.5" : "gap-1.5")}>
      <span className="sr-only">Loading the document</span>
      {widths.map((width, i) => (
        <SkeletonText key={i} width={width} />
      ))}
    </div>
  );
}

/** Written for a person: what went wrong, and the one thing to do next. */
function ReadFailed({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <div className="flex max-w-[46ch] flex-col items-center gap-3 text-center">
        <p className="text-md font-semibold text-ink">This document could not be read</p>
        <p className="text-sm text-ink-2">{message}</p>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCw />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p className="max-w-[42ch] text-center text-sm text-ink-2">
        This document is empty. It exists, and there is nothing in it yet.
      </p>
    </div>
  );
}

function TruncationNote() {
  return (
    <p className="typed px-4 py-2 text-ink-3 hairline-t">
      This is the beginning of the document; it is longer than one read.
    </p>
  );
}
