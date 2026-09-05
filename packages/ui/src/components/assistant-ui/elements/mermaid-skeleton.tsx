"use client";
/**
 * The Mermaid fence's waiting state: three boxes and two connectors, in
 * hairline ink, the shape of what is coming. Shown while the part streams and
 * while the renderer chunk loads, so the fence never jumps between the two.
 *
 * Built from `Skeleton`, and therefore quiet: a skeleton holds a shape, it
 * does not pulse. There is one skeleton in the app, not two.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function MermaidSkeleton({ className }: { className?: string | undefined }) {
  return (
    <div
      data-slot="mermaid-skeleton"
      role="status"
      aria-label="Waiting for the diagram to finish"
      className={cn("mb-4 flex h-32 items-center justify-center gap-3 rounded-b-lg border border-line bg-surface-2 p-4 last:mb-0", className)}
    >
      <Skeleton className="h-8 w-20" />
      <span aria-hidden="true" className="h-px w-10 bg-line" />
      <Skeleton className="h-8 w-20" />
      <span aria-hidden="true" className="h-px w-10 bg-line" />
      <Skeleton className="h-8 w-20" />
    </div>
  );
}
