import type { CSSProperties } from "react";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state.js";

/** One conversation-shaped placeholder: a prompt, a reply, a shorter prompt. */
function PlaceholderTurn() {
  return (
    <div data-slot="history-reserve-turn" className="flex flex-col gap-8 py-4 [contain-intrinsic-size:auto_var(--history-placeholder-turn)] [content-visibility:auto]">
      <div className="ms-auto w-3/5 rounded-xl bg-surface-2 p-4">
        <div className="h-2 w-full rounded-full bg-line" />
        <div className="mt-2.5 h-2 w-2/3 rounded-full bg-line" />
      </div>
      <div className="flex w-4/5 flex-col gap-2.5 py-2">
        <div className="h-2 w-full rounded-full bg-line" />
        <div className="h-2 w-11/12 rounded-full bg-line" />
        <div className="h-2 w-3/4 rounded-full bg-line" />
      </div>
      <div className="ms-auto w-2/5 rounded-xl bg-surface-2 p-4">
        <div className="h-2 w-full rounded-full bg-line" />
      </div>
    </div>
  );
}

/** The nominal height of one placeholder turn, in the spacing scale. */
const PLACEHOLDER_TURN = "calc(var(--spacing) * 72)";

/**
 * The unloaded earlier conversation, drawn as conversation-shaped placeholder
 * rows in normal flow: no words, no card, nothing sticky. Its parent owns the
 * exact virtual height; a page replaces these pixels with real rows in place,
 * so arriving history is nothing the person has to watch (M16-T83).
 *
 * The only visible sign of work is `overdue`: a page that has taken longer
 * than one slow motion step while the person is inside this range shows the
 * loader's matrix at the viewport's top edge, without copy, until it arrives.
 * Everything a screen reader needs is said once, by the history controls.
 */
export function HistoryReserve({ height, overdue }: { height: number; overdue: boolean }) {
  if (height < 1 && !overdue) return null;
  const turns = height >= 1 ? Math.ceil(height / 288) + 1 : 0;
  return (
    <>
      {overdue && (
        <div data-slot="history-reserve-indicator" aria-hidden="true" className="sticky top-0 z-10 flex h-0 justify-center">
          <GenerationLoader quiet label="Loading earlier messages" layout="inline" className="rounded-full bg-bg px-3 py-2" />
        </div>
      )}
      {height >= 1 && (
        <div
          data-slot="history-reserve"
          aria-hidden="true"
          style={{ height, flexShrink: 0, "--history-placeholder-turn": PLACEHOLDER_TURN } as CSSProperties}
          className="conversation-breathe motion-reduce:animate-none relative flex flex-col justify-end overflow-hidden"
        >
          {Array.from({ length: turns }, (_, index) => <PlaceholderTurn key={index} />)}
        </div>
      )}
    </>
  );
}
