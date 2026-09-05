"use client";
/**
 * The inline surface, and the sheet `inspect` asks for.
 *
 * The placement table has four intent columns and every one of them has to
 * reach a surface, or a panel that validated, stored, broadcast and listed
 * simply never gets drawn — which is the one outcome the contract cannot
 * allow. `glance` is the ambient line, `follow` is the dock (a sheet on a
 * phone); these are the other two:
 *
 *   inline   a card in the transcript, at the point it happened. The
 *            `InlineMode` from the table decides how much of it shows:
 *            `card` open, `collapsed` shut until you ask (a document), `tail`
 *            open but short (a stream).
 *   inspect  "I want your attention now": a sheet, on every width, opened once
 *            when the panel arrives. Closing it leaves the card behind, so
 *            nothing vanishes (R7) and the same panel is one tap away.
 *
 * Cards render the same six bodies the island does (`PanelBody`), so a
 * collection looks like a collection wherever the table sends it.
 *
 * Mounted by `Thread.tsx` between the transcript and the footer: panels arrive
 * during a turn, so the tail of the transcript *is* the point they happened.
 */
import { ChevronRight, FileQuestion, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { StatusDot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useLaserView } from "@/runtime";

import { Island, PanelBody, PRESSED } from "./islands/Island.js";
import { placementOf, wantsInspectSheet, type InlineMode, type Viewport } from "./placement.js";
import { usePanelEntries, usePanelsState } from "./PanelsProvider.js";
import { attentionOfEntry, openDecisionIds, type PanelEntry } from "./store.js";
import { liveValues, shortMediaType } from "./values.js";

function useViewport(): Viewport {
  return useIsMobile() ? "mobile" : "desktop";
}

interface InlineEntry {
  entry: PanelEntry;
  mode: InlineMode;
  /** It also wants a sheet; the card is where it lives between openings. */
  inspect: boolean;
}

function useInlineEntries(): InlineEntry[] {
  const view = useLaserView();
  const viewport = useViewport();
  const entries = usePanelEntries(view?.path);
  return useMemo(() => {
    const out: InlineEntry[] = [];
    for (const entry of entries) {
      // Decisions have their own three surfaces (DecisionSurfaces.tsx).
      if (entry.panel.kind === "decision") continue;
      const placement = placementOf(entry.panel, viewport);
      if (placement.surface === "inline" && placement.inline && placement.inline !== "tool-row") {
        out.push({ entry, mode: placement.inline, inspect: false });
      } else if (wantsInspectSheet(entry.panel, viewport)) {
        out.push({ entry, mode: "card", inspect: true });
      }
    }
    return out;
  }, [entries, viewport]);
}

/** Inline panels, in creation order, at the tail of the transcript. */
export function PanelInlineCards({ className }: { className?: string | undefined }) {
  const inline = useInlineEntries();
  if (inline.length === 0) return null;
  return (
    <div data-slot="inline-panels" className={cn("flex flex-col gap-3", className)}>
      {inline.map((item) => (
        <InlineCard key={item.entry.key} item={item} />
      ))}
    </div>
  );
}

function InlineCard({ item }: { item: InlineEntry }) {
  const { entry, mode } = item;
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  // `collapsed` is the only mode that starts shut: a document in the
  // transcript is a thing you may want, not a thing you are reading.
  const [open, setOpen] = useState(mode !== "collapsed");
  const attention = attentionOfEntry(entry, decisions);
  const values = liveValues(entry, Date.now());
  const value = values[0];

  // A document you have not opened is a tangible object in the transcript —
  // the artifact card (docs/ux-elements.md "Artifact card": a `document` panel
  // shown as a card). Opening it turns the card into the reading surface below;
  // the same entry, one identity (R6).
  if (entry.panel.kind === "document" && !open) {
    const doc = entry.panel;
    const meta = [shortMediaType(doc.mediaType), doc.version ? `v · ${doc.version.label}` : undefined, doc.path, entry.closed ? `ended · ${entry.closed.reason}` : undefined]
      .filter(Boolean)
      .join(" · ");
    return (
      <ArtifactCard
        data-slot="inline-panel"
        data-kind="document"
        aria-label={`${doc.title} — open`}
        title={doc.title}
        meta={meta}
        icon={doc.renderable ? FileText : FileQuestion}
        onClick={() => setOpen(true)}
        className="w-full rounded-xl"
      />
    );
  }

  return (
    <article
      data-slot="inline-panel"
      data-kind={entry.panel.kind}
      aria-label={entry.panel.title}
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex min-w-0 items-center gap-2 pe-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={entry.panel.title}
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center gap-2 ps-2.5 text-start outline-none",
            "transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
            PRESSED,
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <StatusDot status={attention} size="sm" />
          <Badge variant="mono" className="hidden shrink-0 sm:inline-flex" title={`From ${entry.panel.source}`}>
            {entry.panel.source}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{entry.panel.title}</span>
          {value && (
            <span className="typed shrink-0 text-ink-2 tnum" title={`${value.label}: ${value.text}`}>
              {value.text}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div
          className={cn(
            "flex min-h-0 flex-col px-3 pb-3 pt-1",
            // A stream inline is a tail, not a terminal you live in.
            mode === "tail" ? "max-h-64" : "max-h-96",
          )}
        >
          <PanelBody entry={entry} size="expanded" now={Date.now()} decisions={decisions} />
        </div>
      )}
      {entry.closed && !open && (
        <p className="px-3 pb-2 text-xs text-ink-3" role="status">
          Ended · {entry.closed.reason}
        </p>
      )}
    </article>
  );
}

/**
 * `inspect` opens, once, when the panel first arrives.
 *
 * Auto-opening is otherwise something laser does not do (the dock never
 * promotes a panel by itself), and this is the one intent whose whole meaning
 * is "now". It opens once per panel id: a re-emit that updates a panel already
 * seen does not re-interrupt.
 */
export function PanelInspectSheet() {
  const viewport = useViewport();
  const view = useLaserView();
  const entries = usePanelEntries(view?.path);
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const opened = useRef(new Set<string>());

  const candidates = useMemo(
    () => entries.filter((e) => !e.closed && wantsInspectSheet(e.panel, viewport)),
    [entries, viewport],
  );

  useEffect(() => {
    for (const entry of candidates) {
      if (opened.current.has(entry.key)) continue;
      opened.current.add(entry.key);
      setOpenKey(entry.key);
      return;
    }
  }, [candidates]);

  const entry = candidates.find((e) => e.key === openKey);
  return (
    <Sheet open={entry !== undefined} onOpenChange={(o) => !o && setOpenKey(undefined)}>
      <SheetContent side="bottom" className="mx-auto h-[85dvh] max-h-[85dvh] w-full max-w-3xl p-0" showCloseButton={false}>
        <SheetTitle className="sr-only">{entry?.panel.title ?? "Panel"}</SheetTitle>
        <SheetDescription className="sr-only">A panel from {entry?.panel.source ?? "an extension"} that asked for your attention.</SheetDescription>
        {entry && (
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            <Island entry={entry} size="expanded" frame="sheet" onClose={() => setOpenKey(undefined)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
