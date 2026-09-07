"use client";
/** assistant-ui confidence-marker, adapted for recorded source identity (D-135).
 * Retains the registry's inline markers and hover/focus basis disclosure. There
 * are deliberately no confidence grades: provenance says who supplied text,
 * not whether it is true. No demo width, extra spaces or raw visual values.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Layers, Puzzle, BookOpen, Monitor, Info, ChevronDown, ArrowUpRight, Copy } from "lucide-react";
import type { InstructionSource } from "@lasercode/protocol";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
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
  const root = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState<{ claim: SourceClaim; rect: DOMRect }>();
  const pointer = useRef(false);
  useEffect(() => {
    const clear = () => { pointer.current = false; setHover(undefined); };
    document.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);
    return () => { document.removeEventListener("scroll", clear, true); window.removeEventListener("blur", clear); };
  }, []);
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => hover?.rect ?? new DOMRect() } }), [hover]);
  // Keep floating layers inside the modal's scroll lock. A body portal appears
  // correct but its wheel/touch events are blocked by the parent Dialog.
  const container = root.current?.closest<HTMLElement>('[data-slot="dialog-content"]');
  const native = hasSourceEditor();
  const FileAction = native ? ArrowUpRight : Copy;
  return <div ref={root} data-slot="confidence-marker" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2" aria-label="Recorded instruction sources">
      <Popover open={menu} onOpenChange={open => { setMenu(open); setHover(undefined); }}><PopoverTrigger asChild><button type="button" className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live">
        <Layers className="size-3 shrink-0" />{sources.length} recorded sources<ChevronDown className="size-3" />
      </button></PopoverTrigger><PopoverContent container={container} align="start" className="w-96 max-w-[calc(100vw-var(--spacing)*4)] max-h-(--radix-popover-content-available-height) gap-0 overflow-hidden p-0">
        <Command className="min-h-0" label="Recorded sources">
          <CommandInput placeholder="Find a source or file…" aria-label="Find a source or file" />
          <CommandList className="min-h-0 overscroll-contain" aria-label="Instruction sources">
            <CommandEmpty>No sources match. Try a filename or source name.</CommandEmpty>
            {Object.keys(style).map(kind => {
              const rows = sources.filter(([, source]) => source.kind === kind);
              return rows.length ? <CommandGroup key={kind} heading={`${({agent:"Agent instructions",file:"Project files",skill:"Skills",extension:"Features",environment:"Environment",unrecorded:"Unrecorded"})[kind]} · ${rows.length}`}>
                {rows.map(([key,source]) => { const Icon = style[source.kind].icon; return <CommandItem key={key} value={key} disabled={!source.path} onSelect={() => {
                  if (source.path) void openSourcePath(source.path);
                }} className="items-start gap-3 py-2 data-[disabled=true]:opacity-100">
                  <Icon className={cn("mt-0.5 size-4", style[source.kind].ink)} />
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{source.label}</span>{source.path && <span className="mt-1 block wrap-anywhere font-mono text-xs text-ink-3">{source.path}</span>}</span>
                  {source.path && <FileAction className="mt-0.5 size-3.5 text-ink-3" />}
                </CommandItem>; })}
              </CommandGroup> : null;
            })}
          </CommandList>
        </Command>
        <p className="shrink-0 border-t border-line px-3 py-2 text-xs text-ink-3">{native ? "Select a file to open in your default text editor." : "Select a file to copy its path for the project computer."}</p>
      </PopoverContent></Popover>
      {!children&&<span className="text-xs text-ink-3">Hover or focus text to inspect its source.</span>}
    </div>
    {children ? <><p className="text-xs text-ink-3">Sources are recorded above. Plain view shows their exact boundaries.</p><div data-request-search-content>{children}</div></>
      : <p data-request-search-content className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">{claims.map(claim => claim.text.trim() ?
        <span key={claim.id} tabIndex={0} data-request-source-text data-file-path={claim.source.path} role={claim.source.path ? "link" : undefined}
          aria-describedby={hover?.claim.id === claim.id ? tooltipId : undefined}
          onPointerMove={event => { if (event.pointerType !== "touch" && !menu) { pointer.current = true; setHover({claim,rect:new DOMRect(event.clientX,event.clientY,0,0)}); } }}
          onPointerLeave={() => { pointer.current = false; setHover(undefined); }}
          onFocus={event => { if (!pointer.current && !menu) setHover({claim,rect:event.currentTarget.getClientRects()[0] ?? event.currentTarget.getBoundingClientRect()}); }}
          onBlur={() => setHover(undefined)}
          onClick={() => { if (claim.source.path && !window.getSelection()?.toString()) { setHover(undefined); void openSourcePath(claim.source.path); } }}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setHover(undefined); } else if (claim.source.path && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void openSourcePath(claim.source.path); } }}
          className={cn("cursor-help select-text rounded-sm text-start whitespace-pre-wrap underline decoration-2 underline-offset-2 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live", claim.source.path && "cursor-pointer", style[claim.source.kind].underline)}>{claim.text}</span> : claim.text)}</p>}
    <Popover open={!!hover && !menu} onOpenChange={open => { if (!open) setHover(undefined); }}>
      <PopoverAnchor virtualRef={anchor}/>
      <PopoverContent container={container} id={tooltipId} role="tooltip" side="bottom" align="start" updatePositionStrategy="always"
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        className="pointer-events-none w-80 max-w-[calc(100vw-var(--spacing)*4)] rounded-lg p-3 motion-reduce:animate-none">
        {hover && <><SourceInfo source={hover.claim.source}/>{hover.claim.source.path && <p className="text-xs text-ink-3">{native ? "Click to open in your text editor" : "Click to copy the file path"}</p>}</>}
      </PopoverContent>
    </Popover>
  </div>;
}
