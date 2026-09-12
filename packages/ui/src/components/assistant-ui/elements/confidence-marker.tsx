"use client";
/** assistant-ui confidence-marker, adapted to captured provenance, not certainty.
 * The document owns the text once. Controls and captured excerpts never enter find. */
import { memo, useId, useEffect, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { INSTRUCTION_APP_ORIGIN, PRODUCT_DISPLAY_NAME, type InstructionOrigin, type InstructionSource } from "@lasercode/protocol";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { MarkdownText } from "./markdown-text";
import { cn } from "@/lib/utils";

export interface SourceClaim { id: string; text: string; source: InstructionSource }
const origins: Record<InstructionOrigin, string> = { engine: "Engine", project: "Project", skill: "Skills", agent: "Agent", variable: "Variables", [INSTRUCTION_APP_ORIGIN]: PRODUCT_DISPLAY_NAME, extension: "Extensions", environment: "Environment", unrecorded: "Not recorded" };
const originOf = (source: InstructionSource): InstructionOrigin => source.origin ?? (source.kind === "file" || source.kind === "agent" ? "unrecorded" : source.kind);
const unknownDetail = "This part was written by something the app could not observe (an engine override or an older capture).";
const detailOf = (source: InstructionSource) => source.detail ?? (source.kind === "unrecorded" ? unknownDetail : source.kind === "skill" ? "The skill's catalog entry. Its full instructions are read separately when used." : !source.origin && (source.kind === "file" || source.kind === "agent") ? "Source identity retained with this captured request. Its origin category was not recorded." : "Source identity retained with this captured request.");
const fileOf = (source: InstructionSource) => !source.inline && source.path && !source.path.startsWith("<") ? source.path : undefined;
const colour = (origin: InstructionOrigin): CSSProperties => ({ "--provenance-origin": `var(--provenance-${origin === INSTRUCTION_APP_ORIGIN ? "app" : origin})` } as CSSProperties);
const share = (count: number, total: number) => count > 0 && count / total < 0.001 ? "<0.1" : (total ? count / total * 100 : 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const action = "rounded-md px-2 py-1 text-xs text-ink outline-none hover:bg-surface-2 active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live pointer-coarse:min-h-11";

function SourceChip({ claim, root, onSelect, textHover = false }: { claim: SourceClaim; root: RefObject<HTMLDivElement | null>; onSelect: (source: InstructionSource, button: HTMLButtonElement) => void; textHover?: boolean }) {
  const [point, setPoint] = useState<DOMRect>();
  const helpId = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const span = textHover ? button.current?.parentElement : undefined;
    if (!span) return;
    const move = (event: PointerEvent) => { if (event.pointerType !== "touch") setPoint(new DOMRect(event.clientX, event.clientY, 0, 0)); };
    const clear = () => setPoint(undefined);
    const focus = () => { if (button.current) setPoint(button.current.getBoundingClientRect()); };
    span.addEventListener("pointermove", move); span.addEventListener("pointerleave", clear); span.addEventListener("focus", focus); span.addEventListener("blur", clear);
    return () => { span.removeEventListener("pointermove", move); span.removeEventListener("pointerleave", clear); span.removeEventListener("focus", focus); span.removeEventListener("blur", clear); };
  }, [textHover]);
  useEffect(() => { const clear = () => setPoint(undefined); document.addEventListener("scroll", clear, true); window.addEventListener("blur", clear); window.addEventListener("resize", clear); return () => { document.removeEventListener("scroll", clear, true); window.removeEventListener("blur", clear); window.removeEventListener("resize", clear); }; }, []);
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => point ?? new DOMRect() } }), [point]);
  return <><button ref={button} type="button" style={colour(originOf(claim.source))} data-search-exclude aria-describedby={point ? helpId : undefined} aria-label={`Inspect source: ${claim.source.label}`} className={cn(action, "my-1 me-2 inline-flex max-w-full select-none items-center gap-2 text-start whitespace-normal wrap-anywhere border border-line bg-surface font-medium")}
    onPointerMove={event => { if (event.pointerType !== "touch") setPoint(new DOMRect(event.clientX, event.clientY, 0, 0)); }} onPointerLeave={() => setPoint(undefined)}
    onFocus={event => setPoint(event.currentTarget.getBoundingClientRect())} onBlur={() => setPoint(undefined)}
    onKeyDown={event => { if (event.key === "Escape" && point) { event.preventDefault(); event.stopPropagation(); setPoint(undefined); } }}
    onClick={event => { setPoint(undefined); onSelect(claim.source, event.currentTarget); }}>
    <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--provenance-origin)" /><span aria-hidden data-source-label={claim.source.kind === "unrecorded" ? "Not recorded" : claim.source.label} className="before:content-[attr(data-source-label)]"/>
  </button><Popover open={!!point} onOpenChange={value => { if (!value) setPoint(undefined); }}><PopoverAnchor virtualRef={anchor}/>
    <PopoverContent container={root.current?.closest<HTMLElement>('[data-slot="dialog-content"]')} id={helpId} role="tooltip" side="bottom" align="start" updatePositionStrategy="always" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} className="pointer-events-none max-w-prose wrap-anywhere text-xs">{detailOf(claim.source)}</PopoverContent>
  </Popover></>;
}

export const ConfidenceMarker = memo(function ConfidenceMarker({ claims, markdown = false }: { claims: readonly SourceClaim[]; markdown?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState<InstructionOrigin>();
  const [flash, setFlash] = useState<string>();
  const text = claims.map(claim => claim.text).join("");
  const ranges = useMemo(() => { let start = 0; return claims.map(claim => { const value = { ...claim, start, end: start + claim.text.length }; start = value.end; return value; }); }, [claims]);
  const sources = useMemo(() => [...new Map(claims.map(claim => [JSON.stringify(claim.source), claim.source])).entries()], [claims]);
  const totals = useMemo(() => { const result = new Map<InstructionOrigin, number>(); for (const claim of claims) { const origin = originOf(claim.source); result.set(origin, (result.get(origin) ?? 0) + claim.text.length); } return result; }, [claims]);
  const jump = useCallback((id: string) => {
    setFlash(id);
    requestAnimationFrame(() => {
      const element = [...(root.current?.querySelectorAll<HTMLElement>("[data-source-ids]") ?? [])].find(element => element.dataset.sourceIds?.split(" ").includes(id));
      const viewport = root.current?.closest<HTMLElement>('[data-slot="request-viewport"]');
      if (element && viewport) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      element?.focus({ preventScroll: true });
    });
  }, []);
  const close = () => { setSelected(undefined); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); };
  const open = (source: InstructionSource, button: HTMLButtonElement) => {
    opener.current = button; setSelected(JSON.stringify(source));
    requestAnimationFrame(() => {
      const current = panel.current;
      current?.focus({ preventScroll: true });
      const row = current?.querySelector<HTMLElement>('[data-source-selected="true"]');
      if (current && row) {
        const heading = current.querySelector<HTMLElement>("[data-source-panel-heading]");
        current.scrollTop += row.getBoundingClientRect().top - current.getBoundingClientRect().top - (heading?.getBoundingClientRect().height ?? 0) - parseFloat(getComputedStyle(current).paddingTop || "0");
      }
      const viewport = root.current?.closest<HTMLElement>('[data-slot="request-viewport"]');
      if (current && viewport) viewport.scrollTop += current.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
  };
  const chip = (claim: SourceClaim, textHover = false) => <SourceChip key={claim.id} claim={claim} root={root} onSelect={open} textHover={textHover}/>;
  const block = (items: SourceClaim[], children: ReactNode) => {
    const first = items[0];
    if (!first) return children;
    const active = !filter || items.some(item => originOf(item.source) === filter);
    return <div tabIndex={-1} data-source-ids={items.map(item => item.id).join(" ")} data-origin={originOf(first.source)} data-origin-selected={active} style={colour(originOf(first.source))}
      className={cn("provenance-range border-s-2 border-(--provenance-origin) bg-(--provenance-tint) px-3 py-1 outline-none", !active && "bg-transparent", (filter && active || items.some(item => item.id === flash)) && "ring-2 ring-inset ring-live")}>{items.map(item => chip(item))}{children}</div>;
  };
  // One intact Markdown parser; mixed blocks expose every intersecting identity.
  const sourceBlock = (start: number, end: number, children: ReactNode) => block(ranges.filter(range => range.start < end && range.end > start), children);
  return <div ref={root} data-slot="confidence-marker" className={cn("flex min-w-0 flex-col gap-3", selected !== undefined && "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]")}  onKeyDownCapture={event => {
    if (event.key === "Escape" && selected !== undefined) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div aria-label="Recorded instruction sources" className="flex min-w-0 gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible xl:col-span-2">
      {[...totals].map(([origin, count]) => <button key={origin} type="button" aria-pressed={filter === origin} style={colour(origin)} className={cn(action, "flex shrink-0 flex-col items-start gap-1 border border-line sm:flex-row sm:items-center sm:gap-2", filter === origin && "ring-2 ring-live")}
        onClick={() => { setFilter(current => current === origin ? undefined : origin); const first = claims.find(claim => originOf(claim.source) === origin); if (first) jump(first.id); }}>
        <span className="inline-flex items-center gap-2"><span aria-hidden className="size-2 rounded-full bg-(--provenance-origin)" />{origins[origin]}</span><span className="font-mono tabular-nums text-ink-2">{count.toLocaleString()} · {share(count, text.length)}%</span>
      </button>)}
      <button type="button" className={cn(action, "shrink-0")} onClick={event => { if (sources[0]) open(sources[0][1], event.currentTarget); }}>Browse sources</button>
    </div>
    <p className="text-xs text-ink-3 xl:col-span-2">{filter ? "Other origin tints are muted. Select the origin again to show all equally." : <><span className="sm:hidden">Source characters · share of instructions</span><span className="hidden sm:inline">Select an origin to follow it. Select a source label to inspect its contribution. Counts are characters in the captured text.</span></>}</p>
    {selected !== undefined && <aside ref={panel} tabIndex={-1} aria-label="Instruction source panel" data-source-panel className="order-3 min-w-0 xl:col-start-2 xl:row-start-3 max-h-[50dvh] overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface-2 p-3 outline-none focus-visible:ring-2 focus-visible:ring-live">
      <div data-source-panel-heading className="sticky top-0 flex items-center justify-between gap-2 bg-surface-2 pb-2"><h4 className="text-sm font-medium">Captured sources</h4><button type="button" data-close-source-panel className={action} onClick={close}>Close sources</button></div>
      {Object.entries(origins).map(([origin, label]) => { const rows = sources.filter(([, source]) => originOf(source) === origin); return rows.length ? <section key={origin} className="mb-3"><h5 className="py-2 text-xs font-medium text-ink-2">{label}</h5>{rows.map(([key, source]) => {
        const contributions = claims.filter(claim => JSON.stringify(claim.source) === key);
        const path = fileOf(source);
        return <article key={key} data-source-selected={selected === key} className={cn("mb-2 rounded-md border border-line bg-surface p-3", selected === key && "ring-2 ring-live")}>
          <h6 className="wrap-anywhere text-sm font-medium">{source.label}</h6><p className="mt-1 wrap-anywhere text-xs text-ink-2">{detailOf(source)}</p>
          {path && <p className="mt-1 wrap-anywhere font-mono text-xs text-ink-3">{path}</p>}
          <div className="my-2 flex flex-wrap items-center gap-2"><span className="font-mono text-xs tabular-nums text-ink-2">{contributions.reduce((sum, claim) => sum + claim.text.length, 0).toLocaleString()} characters</span>
            <button type="button" className={action} onClick={() => { setFilter(undefined); close(); jump(contributions[0]!.id); }}>Show in text</button>
            {path && <button type="button" className={action} onClick={() => void openSourcePath(path)}>{hasSourceEditor() ? "Open file" : "Copy path"}</button>}
          </div>
          {contributions.map((claim, index) => <details key={claim.id} open={selected === key}><summary className={cn(action, "cursor-pointer")}>Contribution {index + 1} · {claim.text.length.toLocaleString()} characters</summary><pre className="mt-2 whitespace-pre-wrap wrap-anywhere font-mono text-xs text-ink">{claim.text}</pre></details>)}
        </article>;
      })}</section> : null; })}
    </aside>}
    <div data-request-search-content className="order-2 min-w-0 xl:col-start-1 xl:row-start-3" onCopy={event => {
      // Markdown keeps native formatted selection copying. Labels are generated
      // UI content, not text nodes, and cannot enter that copied document.
      if (markdown) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
      const fragment = selection.getRangeAt(0).cloneContents();
      fragment.querySelectorAll("[data-search-exclude]").forEach(node => node.remove());
      event.clipboardData.setData("text/plain", fragment.textContent ?? ""); event.preventDefault();
    }}>
      {markdown ? <TextMessagePartProvider text={text} isRunning={false}><MarkdownText sourceBlock={sourceBlock}/></TextMessagePartProvider>
        : <div className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">{ranges.map(claim => {
          const origin = originOf(claim.source);
          const active = !filter || origin === filter;
          const leading = claim.text.match(/^\s*/)?.[0] ?? "";
          return <span key={claim.id} tabIndex={-1} data-source-ids={claim.id} data-origin={origin} data-origin-selected={active} style={colour(origin)}
            className={cn("provenance-range box-decoration-clone border-s-2 border-(--provenance-origin) bg-(--provenance-tint) ps-1 outline-none", !active && "bg-transparent", (filter && active || claim.id === flash) && "ring-2 ring-inset ring-live")}>
            {leading && <span data-request-source-text>{leading}</span>}{claim.text.trim() && chip(claim, true)}<span data-request-source-text>{claim.text.slice(leading.length)}</span>
          </span>;
        })}</div>}
    </div>
  </div>;
});
