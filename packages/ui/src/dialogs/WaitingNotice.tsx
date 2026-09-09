"use client";
/**
 * "A question is waiting" — the line above the composer when an unanswered
 * question is off screen.
 *
 * A question that blocks the turn is drawn in the sticky footer, so it is
 * never out of sight. A question that belongs to a tool row is, and a reader
 * scrolled up in a long transcript would otherwise have a session that seems
 * stuck for no visible reason.
 *
 * It is not a second navigation model: it moves the thread's own viewport the
 * way find moves it, to the same third-of-the-page position, and it appears
 * only while the row really is out of view.
 */
import { ArrowDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLaserView } from "@/runtime";

import { isRenderableDialog } from "./model.js";
import { useToolRowIds } from "./tool-rows.js";

const VIEWPORT = '[data-slot="thread-viewport"]';
const FOOTER = '[data-slot="thread-footer"]';

/** The tool row of a question that is asked but not on screen, if there is one. */
function useOffscreenQuestion(): { toolCallId: string; title: string } | undefined {
  const view = useLaserView();
  const toolRows = useToolRowIds();
  const dialogs = view?.dialogs;
  const [offscreen, setOffscreen] = useState<{ toolCallId: string; title: string } | undefined>(undefined);

  useEffect(() => {
    const asked = (dialogs ?? []).filter(
      (dialog) => isRenderableDialog(dialog) && dialog.toolCallId !== undefined && toolRows.has(dialog.toolCallId),
    );
    if (asked.length === 0) {
      setOffscreen(undefined);
      return;
    }
    const check = (): void => {
      const viewport = document.querySelector<HTMLElement>(VIEWPORT);
      if (!viewport) return;
      const footer = viewport.querySelector<HTMLElement>(FOOTER)?.getBoundingClientRect().height ?? 0;
      const box = viewport.getBoundingClientRect();
      const visibleBottom = box.bottom - footer;
      for (const dialog of asked) {
        const node = elementFor(dialog.toolCallId!);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom > box.top && rect.top < visibleBottom) {
          setOffscreen(undefined);
          return;
        }
      }
      const first = asked[0]!;
      setOffscreen({ toolCallId: first.toolCallId!, title: first.title });
    };
    check();
    const viewport = document.querySelector<HTMLElement>(VIEWPORT);
    viewport?.addEventListener("scroll", check, { passive: true });
    const timer = window.setInterval(check, 500);
    return () => {
      viewport?.removeEventListener("scroll", check);
      clearInterval(timer);
    };
  }, [dialogs, toolRows]);

  return offscreen;
}

/** The mounted question footer for a tool call, in the live DOM. */
function elementFor(toolCallId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="tool-dialog"][data-tool-call="${CSS.escape(toolCallId)}"]`);
}

export function WaitingNotice({ className }: { className?: string | undefined }) {
  const question = useOffscreenQuestion();
  if (!question) return null;
  return (
    <div
      data-slot="waiting-notice"
      role="status"
      className={cn("flex min-w-0 items-center gap-2 rounded-xl border border-attention bg-surface px-3 py-2", className)}
    >
      <span className="min-w-0 flex-1 truncate text-xs leading-xs text-ink-2">
        A question is waiting further up: <span className="font-medium text-ink">{question.title}</span>
      </span>
      <Button size="xs" variant="outline" data-slot="waiting-notice-go" onClick={() => scrollToQuestion(question.toolCallId)}>
        <ArrowDown className="rotate-180" />
        Take me there
      </Button>
    </div>
  );
}

/** The same move find makes: the target a third of the way down the readable area. */
function scrollToQuestion(toolCallId: string): void {
  const viewport = document.querySelector<HTMLElement>(VIEWPORT);
  const node = elementFor(toolCallId);
  if (!viewport || !node) return;
  const footer = viewport.querySelector<HTMLElement>(FOOTER)?.getBoundingClientRect().height ?? 0;
  const rect = node.getBoundingClientRect();
  viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - Math.max(0, viewport.clientHeight - footer) / 3;
  node.querySelector<HTMLElement>("[data-autofocus], button, input, textarea")?.focus({ preventScroll: true });
}
