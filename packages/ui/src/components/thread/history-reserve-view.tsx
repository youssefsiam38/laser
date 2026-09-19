import type { CSSProperties } from "react";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state.js";
import { PLACEHOLDER_TURN_HEIGHT } from "./history-reserve.js";

/** One conversation-shaped placeholder: a prompt, a reply, a shorter prompt. */
function PlaceholderTurn() {
  return (
    <div
      data-slot="history-reserve-turn"
      style={{ height: "var(--history-placeholder-turn)" }}
      className="flex flex-col gap-8 overflow-hidden py-4 [contain-intrinsic-size:auto_var(--history-placeholder-turn)] [content-visibility:auto]"
    >
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
const PLACEHOLDER_TURN = `${PLACEHOLDER_TURN_HEIGHT / 4} * var(--spacing)`;

/**
 * The unloaded earlier conversation, drawn as conversation-shaped placeholder
 * turns in normal flow inside the transcript's head item: no words, no card,
 * nothing sticky. The virtualizer measures this region like any other content
 * (M16-T87), and a page replaces the turns nearest the loaded rows with the
 * real ones, so arriving history is nothing the person has to watch.
 *
 * Every turn is exactly one nominal turn tall, painted or not, so scrolling
 * through the region never changes its height under the reader.
 *
 * The only visible sign of work is `overdue`: a page that has taken longer
 * than one slow motion step while the person is inside this range shows the
 * loader's matrix at the viewport's top edge, without copy, until it arrives.
 * Everything a screen reader needs is said once, by the history controls.
 */
export function HistoryReserve({ turns, overdue }: { turns: number; overdue: boolean }) {
  if (turns < 1 && !overdue) return null;
  return (
    <>
      {overdue && (
        <div data-slot="history-reserve-indicator" aria-hidden="true" className="sticky top-0 z-10 flex h-0 justify-center">
          <GenerationLoader quiet label="Loading earlier messages" layout="inline" className="rounded-full bg-bg px-3 py-2" />
        </div>
      )}
      {turns >= 1 && (
        <div
          data-slot="history-reserve"
          aria-hidden="true"
          style={{ "--history-placeholder-turn": `calc(${PLACEHOLDER_TURN})` } as CSSProperties}
          className="conversation-breathe motion-reduce:animate-none relative flex flex-col overflow-hidden"
        >
          {Array.from({ length: turns }, (_, index) => <PlaceholderTurn key={index} />)}
        </div>
      )}
    </>
  );
}
