"use client";
/** Adopted elements-artifact-card. The produced file now has an explicit neutral
 * Open action and an optional editor action; the container is no longer a button
 * because nesting those controls would make keyboard activation ambiguous. */
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { paper } from "./surfaces.js";

export function ArtifactCard({ title, path, description, children }: {
  title: string; path: string; description: string; children: ReactNode;
}) {
  return <div data-slot="artifact-card" className={cn(paper, "flex min-w-0 items-start gap-3 rounded-xl p-3")}>
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3"><FileText className="size-4" aria-hidden="true" /></span>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="break-all text-sm font-medium text-ink">{title}</span>
      <TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="typed truncate text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-live">{path}</span></TooltipTrigger>
        <TooltipContent className="max-w-(--measure-prose) break-all">{path}</TooltipContent>
      </Tooltip></TooltipProvider>
      <p className="text-xs text-ink-2">{description}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  </div>;
}
