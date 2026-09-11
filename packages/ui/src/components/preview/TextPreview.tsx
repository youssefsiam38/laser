"use client";
/**
 * Plain text, JSON, YAML — a document body for everything that is legible as
 * source and is not markdown, a diff or an image.
 *
 * It exists so `renderable: true` never over-promises: a producer that sends
 * `application/json` gets its content readable, in Martian Mono at 12px, with
 * line numbers off (they belong to a diff, where alignment carries meaning) and
 * a wrap toggle for the two habits people actually have with logs and JSON.
 *
 * Wrapping off is the default: a JSON line or a stack frame is easier to scan
 * when the indentation holds still, and the body owns its own horizontal
 * scrollbar so the page never scrolls sideways (R13).
 */
import { WrapText } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { boundedPreviewText } from "./display.js";

export interface TextPreviewProps {
  text: string;
  /** The read stopped short of the end of the file. */
  truncated?: boolean | undefined;
  className?: string | undefined;
}

export function TextPreview({ text, truncated, className }: TextPreviewProps) {
  const [wrap, setWrap] = useState(false);
  const shown = useMemo(() => boundedPreviewText(text), [text]);
  const clipped = shown.length < text.length;

  return (
    <div data-slot="text-preview" className={cn("flex min-h-0 flex-col", className)}>
      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        <pre
          className={cn(
            "px-4 py-3 font-mono text-xs leading-sm text-ink",
            wrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre",
          )}
        >
          {shown}
        </pre>
      </div>
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 hairline-t">
        {/*
          Short enough to survive a 280px island without truncating (R13: drop
          content, never shrink type); the whole sentence is in the tooltip.
        */}
        <span
          className="typed min-w-0 flex-1 truncate text-ink-3 tnum"
          title={
            clipped || truncated
              ? `Showing the first ${shown.length.toLocaleString()} characters of this document`
              : `${text.length.toLocaleString()} characters`
          }
        >
          {clipped || truncated ? `first ${shown.length.toLocaleString()} chars` : `${text.length.toLocaleString()} chars`}
        </span>
        <Button variant="ghost" size="xs" onClick={() => setWrap((v) => !v)} aria-pressed={wrap} className="shrink-0 pointer-coarse:min-h-11">
          <WrapText />
          {wrap ? "No wrap" : "Wrap"}
        </Button>
      </div>
    </div>
  );
}
