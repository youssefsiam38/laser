"use client";
/** assistant-ui confidence-marker, adapted for recorded source identity (D-135).
 * Retains the registry's inline markers and hover/focus basis disclosure. There
 * are deliberately no confidence grades: provenance says who supplied text,
 * not whether it is true. No demo width, extra spaces or raw visual values.
 */
import type { ReactNode } from "react";
import { FileText, Layers, Puzzle, BookOpen, Monitor, Info } from "lucide-react";
import type { InstructionSource } from "@lasercode/protocol";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SourceClaim { id: string; text: string; source: InstructionSource }
const style = {
  agent: { icon: Layers, ink: "text-ink-2", underline: "decoration-ink-3/50" },
  file: { icon: FileText, ink: "text-live", underline: "decoration-live/60" },
  skill: { icon: BookOpen, ink: "text-live", underline: "decoration-live/60 decoration-dashed" },
  extension: { icon: Puzzle, ink: "text-attention", underline: "decoration-attention/60" },
  environment: { icon: Monitor, ink: "text-ink-2", underline: "decoration-ink-3/50 decoration-dashed" },
  unrecorded: { icon: Info, ink: "text-ink-3", underline: "decoration-ink-3/50 decoration-dotted" },
} as const;

function SourceInfo({ source }: { source: InstructionSource }) {
  const Icon = style[source.kind].icon;
  return <div className="flex min-w-0 flex-col gap-1 text-xs">
    <span className={cn("flex items-center gap-2 font-medium", style[source.kind].ink)}><Icon className="size-4 shrink-0" />{source.label}</span>
    {source.path && <span className="wrap-anywhere font-mono text-ink-2">{source.path}</span>}
    {source.kind === "skill" && <span className="text-ink-2">Skill name, description and location. The full skill body is loaded separately when used.</span>}
    {source.kind === "extension" && <span className="text-ink-2">This contribution was recorded when the extension changed the instructions.</span>}
  </div>;
}

export function ConfidenceMarker({ claims, children }: { claims: readonly SourceClaim[]; children?: ReactNode }) {
  const sources = [...new Map(claims.filter(claim => claim.text.trim()).map(claim => [JSON.stringify(claim.source), claim.source])).entries()];
  return <div data-slot="confidence-marker" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2" aria-label="Recorded instruction sources">
      <Popover><PopoverTrigger asChild><button type="button" className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live">
        <Layers className="size-3 shrink-0" />{sources.length} recorded sources
      </button></PopoverTrigger><PopoverContent className="max-h-80 overflow-y-auto overscroll-contain">
        {sources.map(([key,source])=><div key={key} className="border-b border-line pb-2 last:border-0 last:pb-0"><SourceInfo source={source}/></div>)}
      </PopoverContent></Popover>
      {!children&&<span className="text-xs text-ink-3">Hover or focus text to inspect its source.</span>}
    </div>
    {children ? <><p className="text-xs text-ink-3">Sources are recorded above. Plain view shows their exact boundaries.</p><div data-request-search-content>{children}</div></>
      : <p data-request-search-content className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">{claims.map(claim => claim.text.trim() ?
        <Tooltip key={claim.id}><TooltipTrigger asChild><span tabIndex={0} data-request-source-text title={claim.source.path ?? claim.source.label}
          className={cn("cursor-help select-text rounded-sm text-start whitespace-pre-wrap underline decoration-2 underline-offset-2 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live", style[claim.source.kind].underline)}>{claim.text}</span></TooltipTrigger>
          <TooltipContent className="max-w-sm bg-surface text-ink"><SourceInfo source={claim.source} /></TooltipContent></Tooltip> : claim.text)}</p>}
  </div>;
}
