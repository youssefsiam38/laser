import { useCallback, useEffect, useState } from "react";

import { NumberTicker } from "@/components/assistant-ui/elements/number-ticker";
import { StatusDot } from "@/components/status";
import type { Status } from "@/components/status/status";
import { duration, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserState } from "@/runtime";
import type { AppState } from "@/store";
import { useSessionUpdates } from "./session-updates.js";
import { useThreadSlots } from "./thread-slots.js";
import { useTick } from "./timing.js";
import { EMPTY_TURN, applyTurnUpdate, turnElapsed, updateTime, type TurnStats } from "./turn-stats.js";

interface Words {
  status: Status;
  text: string;
  live: boolean;
}

/** The session's state in words, lowercase, next to where you type (D-20 §5). */
const wordsFor = (s: AppState): Words | undefined => {
  const path = s.current;
  const view = path ? s.open[path] : undefined;
  const loadState = path ? s.sessionLoads[path] : undefined;
  if ((!path && s.destination.phase === "resolving") || loadState === "opening") {
    return { status: "working", text: "loading the conversation", live: false };
  }
  if ((!path && s.destination.phase === "unavailable") || loadState === "error") {
    return { status: "error", text: "retry to load this conversation", live: false };
  }
  if (!view) return undefined;
  if (s.connection !== "open") {
    return { status: "error", text: s.connection === "connecting" ? "reconnecting to the host" : "disconnected from the host", live: false };
  }
  if (view.dialogs.length > 0) return { status: "waiting_for_input", text: "waiting for you", live: true };
  if (view.state.isCompacting) return { status: "working", text: "compacting", live: true };
  // A fallback chain is moving this conversation to another model. The engine
  // is idle between its own runs while that happens, so this reads ahead of
  // "working" — and it names the model being tried, not just the fact.
  if (view.state.fallback?.switching) {
    const model = view.state.model;
    return { status: "working", text: model ? `switching to ${model.name ?? model.id}` : "switching models", live: true };
  }
  if (view.running) return { status: "working", text: "working", live: true };
  const worker = s.workers[view.state.cwd];
  if (worker?.status === "crashed") return { status: "error", text: "worker crashed", live: false };
  if (worker?.status === "starting") return { status: "idle", text: "starting the worker", live: false };
  return { status: "idle", text: "idle", live: false };
};

const sameWords = (a: Words | undefined, b: Words | undefined): boolean =>
  a === b || (!!a && !!b && a.status === b.status && a.text === b.text && a.live === b.live);

/** When the current view's last prompt landed, for a turn we joined mid-way. */
const lastPromptAt = (s: AppState): string | undefined => {
  const view = s.current ? s.open[s.current] : undefined;
  if (!view || !view.running) return undefined;
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const b = view.blocks[i];
    if (b && b.kind === "user") return b.at;
  }
  return undefined;
};

/**
 * Per-turn elapsed and tokens for the session on screen. Reset when the
 * session changes; a turn that was already running when we arrived starts its
 * clock at the prompt that started it (or at arrival when that is unknown).
 */
function useTurnStats(path: string | undefined, running: boolean): TurnStats {
  const [stats, setStats] = useState<TurnStats>(EMPTY_TURN);
  const promptAt = useLaserState(lastPromptAt);
  useEffect(() => {
    setStats(EMPTY_TURN);
  }, [path]);
  useEffect(() => {
    if (!running) return;
    setStats((s) => (s.startedAt === undefined ? { ...EMPTY_TURN, startedAt: updateTime(promptAt) } : s));
  }, [running, promptAt]);
  useSessionUpdates(
    path,
    useCallback((p) => setStats((s) => applyTurnUpdate(s, p.update, updateTime(p.at))), []),
  );
  return stats;
}

/**
 * One line directly above the composer, on every width (DESIGN.md
 * "Composer", D-20 §5): the session state in words, the turn's elapsed time
 * and tokens, and a trailing slot for the fleet pill. 12px, tabular, one line
 * that truncates and never wraps.
 */
export function StatusLine() {
  const words = useLaserState(wordsFor, sameWords);
  const path = useLaserState((s) => s.current);
  const slots = useThreadSlots();
  const stats = useTurnStats(path, words?.live === true && words.status === "working");
  const ticking = stats.startedAt !== undefined && stats.endedAt === undefined && words?.live === true;
  useTick(ticking, 1000);
  const elapsed = turnElapsed(stats);
  const hasTurn = stats.startedAt !== undefined;

  if (!words && !slots.statusLine) return null;

  const usageTitle = hasTurn
    ? `This turn · ${tokens(stats.output)} output · ${tokens(stats.input)} input · ${tokens(stats.cacheRead)} cache read · ${tokens(stats.cacheWrite)} cache write`
    : undefined;

  return (
    <div
      data-slot="status-line"
      className="flex h-5 min-w-0 items-center justify-between gap-3 px-1 text-xs leading-4 whitespace-nowrap text-ink-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The live region is the *words* only. It used to wrap the clock and
            the token count, which re-render every second, so a screen reader
            read the whole line out again on every tick. The numbers stay
            visible and stay in the accessible name of their own labels. */}
        {words ? (
          <span className="flex min-w-0 items-center gap-2" role="status" aria-live="polite" aria-atomic="true">
            <StatusDot status={words.status} size="sm" label={words.text} />
            <span className={cn("truncate", words.status === "waiting_for_input" && "font-medium text-attention", words.status === "error" && "text-danger")}>
              {words.text}
            </span>
          </span>
        ) : null}
        {hasTurn && elapsed !== undefined ? (
          <>
            <span aria-hidden="true" className="text-ink-3">
              ·
            </span>
            <NumberTicker value={duration(elapsed)} label="Turn time" className={cn("typed shrink-0", ticking ? "text-live" : "text-ink-3")} />
          </>
        ) : null}
        {hasTurn && (stats.rounds > 0 || stats.output > 0) ? (
          <>
            <span aria-hidden="true" className="text-ink-3">
              ·
            </span>
            <span className="typed inline-flex shrink-0 items-baseline gap-1 text-ink-3" title={usageTitle}>
              <NumberTicker value={tokens(stats.output)} label="Output tokens this turn" />
              tokens
            </span>
          </>
        ) : null}
      </div>
      {slots.statusLine ? <div className="flex min-w-0 shrink-0 items-center">{slots.statusLine}</div> : null}
    </div>
  );
}
