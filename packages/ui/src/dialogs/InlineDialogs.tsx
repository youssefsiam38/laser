"use client";
/**
 * Where a question to the person is drawn (docs/ux-fleet.md, "Questions"):
 *
 *   it blocks one tool, and that tool's row is on screen  → inside that row
 *   anything else                                          → a card above the
 *                                                            composer, one at
 *                                                            a time, oldest
 *                                                            first
 *
 * There is no third place and no sheet. A question is part of the
 * conversation that raised it, so it is answered where that conversation is,
 * and the reader never loses their place to answer one.
 *
 * The source is the app store's `view.dialogs` — the `pi/ui/request` stream,
 * typed — rather than a general-purpose panel bus. Two consequences that are
 * the point: a question cannot arrive without a session to belong to, and a
 * kind we cannot draw is cancelled on sight instead of hanging (AGENTS.md
 * invariant 6).
 */
import type { UiDialogRequest } from "@lasercode/protocol";
import { useEffect, useMemo, useState } from "react";

import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { consumeDecisionLink, usePendingDecisionLink } from "@/pwa";
import { useLaserStable, useLaserView } from "@/runtime";

import { DialogBody } from "./DialogBody.js";
import { cancelResponse, dialogFormOf, isRenderableDialog, uiResponseFor } from "./model.js";
import { useToolRowIds } from "./tool-rows.js";

/**
 * The open questions of the current session, split by where they belong.
 *
 * A question whose tool row is not mounted is a card, which is what keeps
 * "inline, in its tool row" from meaning "nowhere". A question we cannot draw
 * appears in neither list: it has already been cancelled.
 */
function useDialogs(): { cards: UiDialogRequest[]; byToolCall: Map<string, UiDialogRequest> } {
  const view = useLaserView();
  const toolRows = useToolRowIds();
  const dialogs = view?.dialogs;
  return useMemo(() => {
    const cards: UiDialogRequest[] = [];
    const byToolCall = new Map<string, UiDialogRequest>();
    for (const dialog of dialogs ?? []) {
      if (!isRenderableDialog(dialog)) continue;
      if (dialog.toolCallId !== undefined && toolRows.has(dialog.toolCallId)) byToolCall.set(dialog.toolCallId, dialog);
      else cards.push(dialog);
    }
    return { cards, byToolCall };
  }, [dialogs, toolRows]);
}

/**
 * A question of a kind this build cannot draw is answered, not shown: leaving
 * it on screen would be a session that never continues. Mounted once, beside
 * the cards, so the rule holds wherever the question was raised.
 */
function useCancelUnrenderable(): void {
  const view = useLaserView();
  const { actions } = useLaserStable();
  const dialogs = view?.dialogs;
  useEffect(() => {
    for (const dialog of dialogs ?? []) {
      if (isRenderableDialog(dialog)) continue;
      void actions.answerDialog(cancelResponse(dialog.id));
    }
  }, [actions, dialogs]);
}

/** How many questions are waiting in this session, for the composer's line. */
export function useWaitingDialogCount(): number {
  const { cards, byToolCall } = useDialogs();
  return cards.length + byToolCall.size;
}

/**
 * A question raised while this tool runs, rendered inside its row. Mount it in
 * the tool row's footer; it draws nothing when nothing is asking.
 *
 * This is the panel-stream half. `ToolRow` also renders questions that arrive
 * *through the tool call itself* (assistant-ui's `interrupt`), answered with
 * `resume`; both are the same `DialogBody`, so a question never looks like two
 * things depending on which road it took.
 */
export function ToolRowDialog({ toolCallId }: { toolCallId: string }) {
  const { actions } = useLaserStable();
  const touch = useIsTouch();
  const { byToolCall } = useDialogs();
  const dialog = byToolCall.get(toolCallId);
  const form = useMemo(() => (dialog ? dialogFormOf(dialog, true) : undefined), [dialog]);
  if (!dialog || !form) return null;
  return (
    <div data-slot="tool-dialog" data-tool-call={toolCallId} className="mb-2 ms-6 border-s-2 border-attention py-1 ps-3">
      <DialogBody
        form={form}
        touch={touch}
        onAnswer={(values) => actions.answerDialog(uiResponseFor(dialog.id, dialog.method, values))}
      />
    </div>
  );
}

/**
 * Questions that block the turn, as a card above the composer, on every width.
 * Mount inside the thread footer.
 *
 * One surface, not two: a phone gets larger controls in the same card rather
 * than a second component, so there is one place to look and one code path to
 * keep right.
 */
export function ThreadDialogCards({ className }: { className?: string | undefined }) {
  const { actions } = useLaserStable();
  const touch = useIsTouch();
  const { cards } = useDialogs();
  useCancelUnrenderable();
  const dialog = cards[0];
  const declineFirst = useDialogLink(dialog);
  const form = useMemo(() => (dialog ? dialogFormOf(dialog, false) : undefined), [dialog]);

  // Esc belongs to the card, not to the page. `DialogBody` handles it while
  // focus is inside the question and stops it there; a window listener would
  // have cancelled — telling the extension "no" — from the composer, from a
  // tool row, from anywhere a person pressed Esc for some other reason. The
  // visible Cancel is the deliberate way out.
  if (!dialog || !form) return null;
  const pending = cards.length - 1;
  return (
    <div
      key={dialog.id}
      data-slot="dialog-card"
      role="region"
      aria-label={`Question: ${dialog.title}`}
      className={cn("rounded-2xl border border-line bg-surface p-4 shadow-float-sm", className)}
    >
      <DialogBody
        key={`${dialog.id}:${declineFirst ? "decline" : "ask"}`}
        form={form}
        touch={touch}
        initialDeclining={declineFirst}
        onAnswer={(values) => actions.answerDialog(uiResponseFor(dialog.id, dialog.method, values))}
      />
      {pending > 0 && <p className="mt-3 text-xs leading-xs text-ink-3">+{pending} more waiting behind this one</p>}
    </div>
  );
}

/**
 * A tap on a notification: `?decision=<id>&answer=allow|deny`.
 *
 * `allow` is applied only while the question is still the one on screen —
 * answering a question that has already moved on would be answering blind.
 * `deny` never answers by itself: it opens the card already asking why,
 * because "No" always has somewhere to go. Returns whether to start declining.
 */
function useDialogLink(dialog: UiDialogRequest | undefined): boolean {
  const link = usePendingDecisionLink();
  const { actions } = useLaserStable();
  const [declineFirst, setDeclineFirst] = useState(false);

  useEffect(() => {
    if (!link || !dialog) return;
    if (!dialog.id.endsWith(link.decisionId)) return;
    consumeDecisionLink();
    if (link.answer === "deny") {
      setDeclineFirst(true);
      return;
    }
    if (link.answer === "allow" && dialog.method === "confirm") {
      void actions
        .answerDialog({ id: dialog.id, confirmed: true })
        .then(() => actions.toast("info", `Allowed · ${dialog.title}`));
    }
  }, [actions, dialog, link]);

  useEffect(() => {
    setDeclineFirst(false);
  }, [dialog?.id]);

  return declineFirst;
}
