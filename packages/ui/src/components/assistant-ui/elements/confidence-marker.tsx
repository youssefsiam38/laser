"use client";
/** assistant-ui confidence-marker, adapted to captured provenance, not certainty.
 * The document owns the text once. Controls and captured excerpts never enter find. */
import {
  memo, useId, useEffect, useCallback, useMemo, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from "react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { ORIGINS, INSTRUCTION_TEMPLATE_FIELDS, type InstructionOrigin, type InstructionSource } from "@lasercode/protocol";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { MarkdownText } from "./markdown-text";
import { cn } from "@/lib/utils";

export interface SourceClaim { id: string; text: string; source: InstructionSource }
interface SourceGroup { key: string; source: InstructionSource; claims: SourceClaim[]; characters: number }
const originOf = (source: InstructionSource): InstructionOrigin =>
  source.origin ?? (source.kind === "file" || source.kind === "agent" ? "unrecorded" : source.kind ?? "unrecorded");

function detailOf(source: InstructionSource): string {
  if (source.reason === "verification-unavailable") {
    return "This connection could not verify the captured sources. Open the app on a secure connection and try again.";
  }
  if (source.reason === "template-ranges-unavailable") {
    return "The saved agent instruction template rendered with its selected variables; detailed field ranges could not be recorded.";
  }
  if (!source.origin && (source.kind === "file" || source.kind === "agent")) {
    return "Source identity retained with this captured request. Its origin category was not recorded.";
  }
  switch (originOf(source)) {
    case "unrecorded":
      return "This part was written by something the app could not observe (an engine override or an older capture).";
    case "engine": return "Base instructions and tool guidance assembled by the engine.";
    case "project": return "Project instructions loaded for this request.";
    case "skill": return "The skill's catalog entry. Its full instructions are read separately when used.";
    case "agent": return source.agentName
      ? `The definition of the agent running this session (Agents → ${source.agentName}).`
      : "Agent instructions loaded for this request.";
    case "variable": {
      const field = INSTRUCTION_TEMPLATE_FIELDS.find(field => field.key === source.fieldKey);
      return `Included through the “${field?.label ?? source.fieldKey ?? "Instruction field"}” field`
        + `${source.agentName ? ` in ${source.agentName}'s saved instructions` : " in the saved instructions"}.`
        + ` ${field?.description ?? "Its value was resolved when this request was prepared."}`;
    }
    case "app": return source.module === "agent-role"
      ? "The session's role, delegation rules and working directory, supplied by the agent harness."
      : "Instructions supplied by the app for this request.";
    case "extension": return "Instructions contributed by this extension.";
    case "environment": return "The working environment captured when this request was prepared.";
  }
}
const fileOf = (source: InstructionSource) =>
  !source.inline && source.path && !source.path.startsWith("<") ? source.path : undefined;
const colour = (origin: InstructionOrigin): CSSProperties =>
  ({ "--provenance-origin": `var(--${ORIGINS.find(item => item.id === origin)!.token})` } as CSSProperties);
const share = (count: number, total: number) => count > 0 && count / total < 0.001
  ? "<0.1" : (total ? count / total * 100 : 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const action = "rounded-md px-2 py-1 text-xs text-ink outline-none hover:bg-surface-2 active:bg-surface-2 "
  + "focus-visible:ring-2 focus-visible:ring-live pointer-coarse:min-h-11";

function SourceChip({ claim, helpId }: { claim: SourceClaim; helpId?: string | undefined }) {
  return <button type="button" style={colour(originOf(claim.source))} data-search-exclude data-claim-id={claim.id}
    aria-describedby={helpId} aria-label={`Inspect source: ${claim.source.label}`}
    className={cn(action, "my-1 me-2 inline-flex max-w-full select-none items-center gap-2 text-start",
      "whitespace-normal wrap-anywhere border border-line bg-surface font-medium")}>
    <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--provenance-origin)" />
    <span aria-hidden data-source-label={claim.source.label} className="before:content-[attr(data-source-label)]" />
  </button>;
}

/** Shared range structure for exact plain spans and intact Markdown blocks. */
function SourceRange({ items, filter, flash, block, children }: {
  items: readonly SourceClaim[]; filter: InstructionOrigin | undefined; flash: string | undefined;
  block?: boolean; children: ReactNode;
}) {
  const first = items[0];
  if (!first) return children;
  const Tag = block ? "div" : "span";
  const active = !filter || items.some(item => originOf(item.source) === filter);
  return <Tag tabIndex={-1} data-source-ids={items.map(item => item.id).join(" ")}
    data-origin={originOf(first.source)} style={colour(originOf(first.source))} data-source-text-hover={!block || undefined}
    data-source-flash={items.some(item => item.id === flash) || undefined}
    className={cn("provenance-range border-s-2 border-(--provenance-origin) bg-(--provenance-tint) outline-none",
      block ? "px-3 py-1" : "box-decoration-clone ps-1", !active && "bg-transparent")}>
    {children}
  </Tag>;
}

function OriginLegend({ totals, total, filter, onFilter, onBrowse }: {
  totals: ReadonlyMap<InstructionOrigin, number>; total: number; filter: InstructionOrigin | undefined;
  onFilter: (origin: InstructionOrigin) => void; onBrowse: (button: HTMLButtonElement) => void;
}) {
  return <>
    <div aria-label="Recorded instruction sources"
      className="flex min-w-0 gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible xl:col-span-2">
      {ORIGINS.filter(origin => totals.has(origin.id)).map(({ id, label }) => <button key={id} type="button"
        aria-pressed={filter === id} style={colour(id)} onClick={() => onFilter(id)}
        className={cn(action, "flex shrink-0 flex-col items-start gap-1 border border-line sm:flex-row sm:items-center sm:gap-2",
          filter === id && "border-(--provenance-origin) underline underline-offset-4")}>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-(--provenance-origin)" />{label}
        </span>
        <span className="font-mono tabular-nums text-ink-2">
          {totals.get(id)!.toLocaleString()} · {share(totals.get(id)!, total)}%
        </span>
      </button>)}
      <button type="button" className={cn(action, "shrink-0")} onClick={event => onBrowse(event.currentTarget)}>Browse sources</button>
    </div>
    <p className="text-xs text-ink-3 xl:col-span-2">{filter
      ? "Other origin tints are muted. Select the origin again to show all equally."
      : <><span className="sm:hidden">Source characters · share of instructions</span>
        <span className="hidden sm:inline">Select an origin to follow it. Select a source label to inspect its contribution.
          Counts are characters in the captured text.</span></>}
    </p>
  </>;
}

function Contribution({ claim, index, initiallyOpen }: { claim: SourceClaim; index: number; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={cn(action, "cursor-pointer")}>Contribution {index + 1} · {claim.text.length.toLocaleString()} characters</summary>
    {open && <pre className="mt-2 whitespace-pre-wrap wrap-anywhere font-mono text-xs text-ink">{claim.text}</pre>}
  </details>;
}

function SourcePanel({ groups, selected, panel, onClose, onJump }: {
  groups: readonly SourceGroup[]; selected: string; panel: RefObject<HTMLElement | null>;
  onClose: () => void; onJump: (id: string) => void;
}) {
  return <aside ref={panel} tabIndex={-1} aria-label="Instruction source panel" data-source-panel
    className={cn("order-3 min-w-0 xl:col-start-2 xl:row-start-3 max-h-[50dvh] overflow-y-auto overscroll-contain",
      "rounded-lg border border-line bg-surface-2 p-3 outline-none focus-visible:ring-2 focus-visible:ring-live")}>
    <div data-source-panel-heading className="sticky top-0 flex items-center justify-between gap-2 bg-surface-2 pb-2">
      <h4 className="text-sm font-medium">Captured sources</h4>
      <button type="button" data-close-source-panel className={action} onClick={onClose}>Close sources</button>
    </div>
    {ORIGINS.map(({ id, label }) => {
      const rows = groups.filter(group => originOf(group.source) === id);
      if (!rows.length) return null;
      return <section key={id} className="mb-3">
        <h5 className="py-2 text-xs font-medium text-ink-2">{label}</h5>
        {rows.map(({ key, source, claims, characters }) => {
          const path = fileOf(source);
          return <article key={key} data-source-selected={selected === key}
            className={cn("mb-2 rounded-md border border-line bg-surface p-3", selected === key && "ring-2 ring-live")}>
            <h6 className="wrap-anywhere text-sm font-medium">{source.label}</h6>
            <p className="mt-1 wrap-anywhere text-xs text-ink-2">{detailOf(source)}</p>
            {path && <p className="mt-1 wrap-anywhere font-mono text-xs text-ink-3">{path}</p>}
            <div className="my-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs tabular-nums text-ink-2">{characters.toLocaleString()} characters</span>
              <button type="button" className={action} onClick={() => onJump(claims[0]!.id)}>Show in text</button>
              {path && <button type="button" className={action} onClick={() => void openSourcePath(path)}>
                {hasSourceEditor() ? "Open file" : "Copy path"}
              </button>}
            </div>
            {claims.map((claim, index) => <Contribution key={claim.id} claim={claim} index={index} initiallyOpen={selected === key} />)}
          </article>;
        })}
      </section>;
    })}
  </aside>;
}

export const ConfidenceMarker = memo(function ConfidenceMarker({ claims, markdown = false }: {
  claims: readonly SourceClaim[]; markdown?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const helpId = useId();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState<InstructionOrigin>();
  const [flash, setFlash] = useState<{ id: string }>();
  const [detail, setDetail] = useState<{ claim: SourceClaim; rect: DOMRect }>();
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => detail?.rect ?? new DOMRect() } }), [detail]);
  const model = useMemo(() => {
    let text = "";
    const groups = new Map<string, SourceGroup>();
    const byClaim = new Map<string, SourceGroup>();
    const totals = new Map<InstructionOrigin, number>();
    const ranges = claims.map(claim => {
      const range = { ...claim, start: text.length, end: text.length + claim.text.length };
      text += claim.text;
      const key = JSON.stringify(claim.source);
      let group = groups.get(key);
      if (!group) {
        group = { key, source: claim.source, claims: [], characters: 0 };
        groups.set(key, group);
      }
      group.claims.push(claim);
      group.characters += claim.text.length;
      byClaim.set(claim.id, group);
      const origin = originOf(claim.source);
      totals.set(origin, (totals.get(origin) ?? 0) + claim.text.length);
      return range;
    });
    return { text, ranges, groups: [...groups.values()], byClaim, totals, claims: new Map(claims.map(claim => [claim.id, claim])) };
  }, [claims]);

  // One listener set and one popover for the entire captured document.
  useEffect(() => {
    const clear = () => setDetail(undefined);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", clear);
    };
  }, []);
  useEffect(() => {
    if (!flash || !root.current) return;
    const duration = getComputedStyle(root.current).getPropertyValue("--motion-morph").trim();
    const ms = (parseFloat(duration) || 0) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = setTimeout(() => setFlash(undefined), ms);
    return () => clearTimeout(timer);
  }, [flash]);
  const jump = useCallback((id: string) => {
    requestAnimationFrame(() => {
      setFlash({ id });
      const element = [...(root.current?.querySelectorAll<HTMLElement>("[data-source-ids]") ?? [])]
        .find(element => element.dataset.sourceIds?.split(" ").includes(id));
      const viewport = root.current?.closest<HTMLElement>('[data-slot="request-viewport"]');
      if (element && viewport) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      element?.focus({ preventScroll: true });
    });
  }, []);
  const close = () => {
    setSelected(undefined);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  };
  const open = (key: string, button: HTMLButtonElement) => {
    setDetail(undefined);
    opener.current = button;
    setSelected(key);
    requestAnimationFrame(() => {
      const current = panel.current;
      current?.focus({ preventScroll: true });
      const row = current?.querySelector<HTMLElement>('[data-source-selected="true"]');
      if (current && row) {
        const heading = current.querySelector<HTMLElement>("[data-source-panel-heading]");
        current.scrollTop += row.getBoundingClientRect().top - current.getBoundingClientRect().top
          - (heading?.getBoundingClientRect().height ?? 0) - parseFloat(getComputedStyle(current).paddingTop || "0");
      }
      const viewport = root.current?.closest<HTMLElement>('[data-slot="request-viewport"]');
      if (current && viewport) viewport.scrollTop += current.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
  };
  const targetClaim = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return undefined;
    const chip = target.closest<HTMLElement>("[data-claim-id]");
    // A Markdown block can cross several sources; only its chips identify
    // exact writers. Plain ranges may disclose on their text as well.
    const id = chip?.dataset.claimId
      ?? target.closest<HTMLElement>("[data-source-text-hover]")?.dataset.sourceIds?.split(" ")[0];
    return id ? model.claims.get(id) : undefined;
  };
  const chip = (claim: SourceClaim) => <SourceChip key={claim.id} claim={claim} helpId={detail?.claim.id === claim.id ? helpId : undefined} />;
  const sourceBlock = (start: number, end: number, children: ReactNode) => {
    const items = model.ranges.filter(range => range.start < end && range.end > start);
    return <SourceRange items={items} filter={filter} flash={flash?.id} block>{items.map(chip)}{children}</SourceRange>;
  };
  return <div ref={root} data-slot="confidence-marker"
    className={cn("flex min-w-0 flex-col gap-3", selected !== undefined && "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]")}
    onPointerMove={event => {
      if (event.pointerType === "touch") return;
      const claim = targetClaim(event.target);
      setDetail(claim ? { claim, rect: new DOMRect(event.clientX, event.clientY, 0, 0) } : undefined);
    }}
    onPointerLeave={() => setDetail(undefined)}
    onFocus={event => {
      const claim = targetClaim(event.target);
      setDetail(claim ? { claim, rect: event.target.getBoundingClientRect() } : undefined);
    }}
    onBlur={() => setDetail(undefined)}
    onClick={event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-claim-id]");
      const group = button?.dataset.claimId ? model.byClaim.get(button.dataset.claimId) : undefined;
      if (button && group) open(group.key, button);
    }}
    onKeyDownCapture={event => {
      if (event.key !== "Escape") return;
      if (selected !== undefined) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (detail) { event.preventDefault(); event.stopPropagation(); setDetail(undefined); }
    }}>
    <OriginLegend totals={model.totals} total={model.text.length} filter={filter}
      onFilter={origin => {
        setFilter(current => current === origin ? undefined : origin);
        const first = claims.find(claim => originOf(claim.source) === origin);
        if (first) jump(first.id);
      }} onBrowse={button => { if (model.groups[0]) open(model.groups[0].key, button); }} />
    {selected !== undefined && <SourcePanel groups={model.groups} selected={selected} panel={panel} onClose={close}
      onJump={id => { setFilter(undefined); close(); jump(id); }} />}
    <div data-request-search-content className="order-2 min-w-0 xl:col-start-1 xl:row-start-3" onCopy={event => {
      // Markdown keeps native formatted copying. Labels contain no text nodes.
      if (markdown) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !event.currentTarget.contains(selection.anchorNode)
        || !event.currentTarget.contains(selection.focusNode)) return;
      const fragment = selection.getRangeAt(0).cloneContents();
      fragment.querySelectorAll("[data-search-exclude]").forEach(node => node.remove());
      event.clipboardData.setData("text/plain", fragment.textContent ?? "");
      event.preventDefault();
    }}>
      {markdown ? <TextMessagePartProvider text={model.text} isRunning={false}>
        <MarkdownText sourceBlock={sourceBlock} />
      </TextMessagePartProvider> : <div className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
        {model.ranges.map(claim => {
          const leading = claim.text.match(/^\s*/)?.[0] ?? "";
          return <SourceRange key={claim.id} items={[claim]} filter={filter} flash={flash?.id}>
            {leading && <span data-request-source-text>{leading}</span>}
            {claim.text.trim() && chip(claim)}
            <span data-request-source-text>{claim.text.slice(leading.length)}</span>
          </SourceRange>;
        })}
      </div>}
    </div>
    <Popover open={!!detail} onOpenChange={value => { if (!value) setDetail(undefined); }}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent container={root.current?.closest<HTMLElement>('[data-slot="dialog-content"]')}
        id={helpId} role="tooltip" side="bottom" align="start" updatePositionStrategy="always"
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => {
          // A different source owns the next detail; Radix must not close it
          // after the delegated focus handler has already selected that source.
          if (event.target instanceof Node && root.current?.contains(event.target)) event.preventDefault();
        }}
        className="pointer-events-none max-w-prose wrap-anywhere text-xs">
        {detail && detailOf(detail.claim.source)}
      </PopoverContent>
    </Popover>
  </div>;
});
