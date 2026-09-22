"use client";
/**
 * A Sketch, in the only frame it is allowed to exist in (D-354, M21-T11).
 *
 * Everything that makes this safe is in `design/sketch.ts` and asserted in
 * `test/design/sketch.test.tsx`: `srcdoc` (never a URL), `sandbox` exactly
 * `allow-scripts` (never `allow-same-origin`, so the document has an opaque
 * origin with no storage and no reach into this app), a CSP meta injected
 * ahead of anything that could load, a sanitised title and a size ceiling.
 *
 * Nothing is read back out of the frame. The parent sees an opaque box with a
 * bounded title, and the one path from these bytes to a design is
 * `ground_sketch`, which treats them as untrusted text.
 */
import { ShieldCheck } from "lucide-react";
import type { DesignSketch } from "@lasercode/protocol";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { sanitiseSketchTitle, sketchFrameSize, sketchSrcDoc, sketchTooLargeMessage, sketchWithinBounds, SKETCH_SANDBOX } from "@/design/sketch";

export function SketchFrame({
  sketch,
  document: html,
  loading = false,
  error,
  className,
}: {
  sketch: DesignSketch;
  /** The sketch's bytes, once the blob has been read. */
  document: string | undefined;
  loading?: boolean;
  /** Why the bytes could not be read, in the host's own sentence. */
  error?: string | undefined;
  className?: string;
}) {
  const size = sketchFrameSize(sketch.bounds);
  const title = sanitiseSketchTitle(sketch.title);
  const oversize = !sketchWithinBounds(sketch.bytes);

  return (
    <div
      data-slot="design-sketch-frame"
      data-sketch-id={sketch.id}
      className={cn("flex flex-col overflow-hidden bg-surface", className)}
      style={{ width: `${String(size.width)}px` }}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <Badge variant="attention">Sketch</Badge>
        <span className="min-w-0 flex-1 truncate text-xs leading-xs text-ink-2" title={title}>
          {title}
        </span>
        <span className="typed shrink-0 tnum text-ink-3">{Math.round(sketch.bytes / 1024)} KB</span>
      </div>

      <div className="relative" style={{ height: `${String(size.height)}px` }}>
        {oversize ? (
          <FrameNotice role="alert" title="This sketch is too large to open" detail={sketchTooLargeMessage(sketch.bytes)} />
        ) : error ? (
          <FrameNotice role="alert" title="This sketch could not be read" detail={error} />
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <GenerationLoader label="Opening the sketch" />
          </div>
        ) : html === undefined ? (
          <FrameNotice
            title="Nothing to draw yet"
            detail="The sketch is on this revision but its content is not on this machine. It arrives with the next read."
          />
        ) : (
          <iframe
            data-slot="sketch-document"
            title={title}
            srcDoc={sketchSrcDoc(html)}
            sandbox={SKETCH_SANDBOX}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="size-full border-0 bg-surface"
          />
        )}
      </div>

      <p className="flex items-center gap-1.5 border-t border-line px-2 py-1 text-xs leading-xs text-ink-3">
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
        Sandboxed: no network, no storage, and no way back into this app.
      </p>
    </div>
  );
}

function FrameNotice({ title, detail, role = "status" }: { title: string; detail: string; role?: "status" | "alert" }) {
  return (
    <div role={role} className="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-(--measure-prose) text-xs leading-xs text-ink-2">{detail}</p>
    </div>
  );
}
