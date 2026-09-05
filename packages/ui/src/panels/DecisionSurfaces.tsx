"use client";
/**
 * Where decisions land (docs/ux-panels.md placement row for `decision`):
 *   blocks a tool   → its tool row, when that row is on screen
 *   blocks the turn → a card above the composer, one at a time, oldest first
 *   blocks everything → a sheet
 * Both fallback dialogs and declared decision panels arrive here through the
 * panel store, so the two look identical.
 */
import { useEffect, useMemo, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { consumeDecisionLink, usePendingDecisionLink } from "@/pwa";
import { usePiorbitStable, usePiorbitView } from "@/runtime";

import { DecisionBody } from "./islands/bodies/DecisionBody.js";
import { placementOf } from "./placement.js";
import { usePanelActions, usePanelEntries } from "./PanelsProvider.js";
import type { PanelEntry } from "./store.js";
import { useToolRowIds } from "./tool-rows.js";

/**
 * Every open decision, sorted onto its surface by the placement table.
 *
 * The tool-row column is only reachable when the row exists, so the set of
 * mounted rows is part of the question (`useToolRowIds`). A decision that
 * names a tool call nobody is showing falls back to the card, which is what
 * keeps "inline, in its tool row" from meaning "nowhere".
 */
function useDecisions(): { cards: PanelEntry[]; sheet: PanelEntry | undefined; inToolRows: PanelEntry[] } {
  const view = usePiorbitView();
  const entries = usePanelEntries(view?.path);
  const toolRows = useToolRowIds();
  return useMemo(() => {
    const open = entries.filter((e) => e.panel.kind === "decision" && !e.closed);
    const hasRow = (entry: PanelEntry): boolean =>
      entry.panel.kind === "decision" && entry.panel.toolCallId !== undefined && toolRows.has(entry.panel.toolCallId);
    const placed = open.map((entry) => [entry, placementOf(entry.panel, "desktop", hasRow(entry))] as const);
    return {
      cards: placed.filter(([, p]) => p.inline === "card").map(([e]) => e),
      sheet: placed.find(([, p]) => p.surface === "sheet")?.[0],
      inToolRows: placed.filter(([, p]) => p.inline === "tool-row").map(([e]) => e),
    };
  }, [entries, toolRows]);
}

/**
 * A declared decision that belongs to this tool call, rendered inside its row.
 *
 * `ToolRow` also renders the fallback dialog stream through `resume`; this is
 * the other half — a `decision` panel carrying a `toolCallId`, answered
 * through the panel store like every other declared panel. Both are the same
 * `DecisionBody`, so a question never looks like two things depending on which
 * road it took.
 */
export function PanelToolDecision({ toolCallId }: { toolCallId: string }) {
  const actions = usePanelActions();
  const touch = useIsTouch();
  const { inToolRows } = useDecisions();
  const entry = inToolRows.find((e) => e.panel.kind === "decision" && e.panel.toolCallId === toolCallId);
  if (!entry || entry.panel.kind !== "decision") return null;
  return (
    <div data-slot="tool-decision" className="mb-2 ms-6 border-s-2 border-attention py-1 ps-3">
      <DecisionBody panel={entry.panel} touch={touch} onAnswer={(values) => actions.answerDecision(entry, values)} />
    </div>
  );
}

/**
 * Turn-blocking decisions as cards above the composer, on every width. Mount
 * inside the thread footer.
 *
 * This is the one surface for a question that blocks the turn: a phone gets
 * larger controls in the same card rather than a second component, so there is
 * one place to look and one code path to keep right.
 */
export function PanelDecisionCards({ className }: { className?: string | undefined }) {
  const actions = usePanelActions();
  const touch = useIsTouch();
  const { cards } = useDecisions();
  const entry = cards[0];
  const declineFirst = useDecisionLink(entry);

  // Esc belongs to the card, not to the page. `DecisionBody` handles it while
  // focus is inside the question and stops it there; a window listener would
  // have cancelled — telling the extension "no" — from the composer, from a
  // tool row, from anywhere a person pressed Esc for some other reason. The
  // visible Cancel is the deliberate way out.
  if (!entry || entry.panel.kind !== "decision") return null;
  const pending = cards.length - 1;
  return (
    <div
      key={entry.key}
      data-slot="decision-card"
      role="region"
      aria-label={`Decision: ${entry.panel.title}`}
      className={cn("rounded-2xl border border-line bg-surface p-4 shadow-float-sm", className)}
    >
      <DecisionBody
        key={`${entry.key}:${declineFirst ? "decline" : "ask"}`}
        panel={entry.panel}
        touch={touch}
        initialDeclining={declineFirst}
        onAnswer={(values) => actions.answerDecision(entry, values)}
      />
      {pending > 0 && (
        <p className="mt-3 text-xs text-ink-3">
          +{pending} more waiting behind this one
        </p>
      )}
    </div>
  );
}

/**
 * A tap on a notification: `?decision=<id>&answer=allow|deny`.
 *
 * `allow` is applied only while the question is still the one on screen —
 * answering a question that has already moved on would be answering blind.
 * `deny` never answers by itself: it opens the card already asking why, because
 * "No" always has somewhere to go. Returns whether to start in that state.
 */
function useDecisionLink(entry: PanelEntry | undefined): boolean {
  const link = usePendingDecisionLink();
  const { actions } = usePiorbitStable();
  const panelActions = usePanelActions();
  const [declineFirst, setDeclineFirst] = useState(false);

  useEffect(() => {
    if (!link || !entry || entry.panel.kind !== "decision") return;
    // Ids are namespaced once they are panels; the notification carried the
    // dialog id, so match on either.
    if (!entry.panel.id.endsWith(link.decisionId)) return;
    consumeDecisionLink();
    if (link.answer === "deny") {
      setDeclineFirst(true);
      return;
    }
    if (link.answer === "allow") {
      const confirm = entry.panel.fields.find((f) => f.type === "confirm");
      if (!confirm) return;
      void panelActions
        .answerDecision(entry, { [confirm.id]: true })
        .then(() => actions.toast("info", `Allowed · ${entry.panel.title}`));
    }
  }, [actions, entry, link, panelActions]);

  useEffect(() => {
    setDeclineFirst(false);
  }, [entry?.key]);

  return declineFirst;
}

/** A decision that blocks everything takes a sheet. Mount once in the shell. */
export function PanelDecisionSheet() {
  const actions = usePanelActions();
  const touch = useIsTouch();
  const { sheet } = useDecisions();
  if (!sheet || sheet.panel.kind !== "decision") return null;
  return (
    <Sheet open onOpenChange={(open) => !open && void actions.answerDecision(sheet, undefined)}>
      <SheetContent side="bottom" className="mx-auto max-w-xl rounded-t-2xl p-5 sm:pb-8">
        <SheetTitle className="sr-only">{sheet.panel.title}</SheetTitle>
        <SheetDescription className="sr-only">This question blocks the whole session until it is answered.</SheetDescription>
        <DecisionBody panel={sheet.panel} variant="sheet" touch={touch} onAnswer={(values) => actions.answerDecision(sheet, values)} />
      </SheetContent>
    </Sheet>
  );
}
