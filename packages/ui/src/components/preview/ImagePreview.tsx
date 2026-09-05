"use client";
/**
 * An image as a document-panel body (M8-T3) — the native replacement for
 * @xynogen/pix-display, which draws into a terminal and does nothing in a
 * GUI host (docs/research/findings.md).
 *
 * Two states, and they are the whole design: **fit**, where the image is
 * `object-contain` inside the pane and never scrolls, and **actual size**,
 * where it is drawn at its own pixel dimensions and the body scrolls in both
 * axes. Zoom steps in between would need a gesture model, a focal point and a
 * reset affordance for something you look at for four seconds; two states with
 * one control is the honest amount of design for this.
 *
 * The toggle only appears when it would do something — an image smaller than
 * the pane is already at actual size (R2: a control that does nothing is not
 * shown disabled, it is not shown).
 *
 * `src` is a data: or blob: URL the panel reader produced from `pi/panel/read`.
 * `alt` comes from the panel title, rendered as text, never as markup.
 */
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ImagePreviewProps {
  src: string;
  /** What the image is, in words. Falls back to a generic label, never to "".*/
  alt?: string | undefined;
  className?: string | undefined;
}

interface Natural {
  width: number;
  height: number;
}

export function ImagePreview({ src, alt, className }: ImagePreviewProps) {
  const [natural, setNatural] = useState<Natural | undefined>(undefined);
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    const update = (): void => {
      if (!node.naturalWidth) return;
      setNatural({ width: node.naturalWidth, height: node.naturalHeight });
      const box = node.parentElement;
      if (box) setOverflows(node.naturalWidth > box.clientWidth || node.naturalHeight > box.clientHeight);
    };
    if (node.complete) update();
    else node.addEventListener("load", update, { once: true });
  }, []);

  if (failed) {
    return (
      <div data-slot="image-preview" className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}>
        <p className="max-w-[42ch] text-center text-sm text-ink-2">
          The image could not be decoded. It may be a format this browser does not draw, or the bytes may be incomplete.
        </p>
      </div>
    );
  }

  return (
    <div data-slot="image-preview" className={cn("flex min-h-0 flex-col", className)}>
      <div
        className={cn(
          "flex min-h-0 flex-1 bg-surface-2",
          actual ? "overflow-auto" : "items-center justify-center overflow-hidden p-3",
        )}
      >
        <img
          ref={measure}
          src={src}
          alt={alt && alt.trim() !== "" ? alt : "Image"}
          onError={() => setFailed(true)}
          draggable={false}
          className={cn(
            actual ? "max-w-none shrink-0" : "max-h-full max-w-full object-contain",
            // A transparent PNG on a light ground and on a dark one both need
            // to read; a hairline is enough to show where the image ends.
            "rounded-sm ring-1 ring-line",
          )}
        />
      </div>

      <div className="flex shrink-0 items-center gap-3 px-4 py-2 hairline-t">
        <span className="typed min-w-0 flex-1 truncate text-ink-3 tnum">
          {natural ? `${natural.width} × ${natural.height}` : "…"}
        </span>
        {overflows ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setActual((v) => !v)}
            aria-pressed={actual}
            className="shrink-0"
          >
            {actual ? <Minimize2 /> : <Maximize2 />}
            {actual ? "Fit" : "Actual size"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
