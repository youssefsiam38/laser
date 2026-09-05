/**
 * Per-turn bookkeeping for the status line above the composer (D-20 §5):
 * when the turn started, when it ended, and the tokens it used. Pure reducer
 * over `SessionUpdate`s; the hook that feeds it lives in session-updates.ts.
 *
 * Tokens come from the `usage` Pi stamps on each assistant message at
 * `message_end`. An agentic turn holds several assistant messages (one per
 * model round-trip), so a turn's numbers are the sum over them. `output` is
 * what the status line shows — the input side of every round-trip repeats the
 * whole context, so summing it would dwarf the number that means "work done".
 */
import type { SessionUpdate } from "@lasercode/protocol";

export interface TurnStats {
  /** Epoch ms the turn began; `undefined` before any turn was seen. */
  readonly startedAt: number | undefined;
  /** Epoch ms the turn settled; `undefined` while it runs. */
  readonly endedAt: number | undefined;
  readonly output: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Assistant messages that reported usage this turn. */
  readonly rounds: number;
}

export const EMPTY_TURN: TurnStats = {
  startedAt: undefined,
  endedAt: undefined,
  output: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  rounds: 0,
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

const usageOf = (message: unknown): UsageLike | undefined => {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; usage?: unknown };
  if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") return undefined;
  return m.usage as UsageLike;
};

/** Fold one update into the stats. `at` is the update's wall-clock time (ms). */
export function applyTurnUpdate(stats: TurnStats, update: SessionUpdate, at: number): TurnStats {
  switch (update.kind) {
    case "agent_start":
      return { ...EMPTY_TURN, startedAt: at };
    case "message_end": {
      const usage = usageOf(update.message);
      if (!usage) return stats;
      return {
        ...stats,
        // A reattached session may see its first usage before any agent_start.
        startedAt: stats.startedAt ?? at,
        output: stats.output + num(usage.output),
        input: stats.input + num(usage.input),
        cacheRead: stats.cacheRead + num(usage.cacheRead),
        cacheWrite: stats.cacheWrite + num(usage.cacheWrite),
        rounds: stats.rounds + 1,
      };
    }
    case "agent_end":
    case "agent_settled":
      return stats.startedAt === undefined || stats.endedAt !== undefined ? stats : { ...stats, endedAt: at };
    default:
      return stats;
  }
}

/** Elapsed ms of the turn: ticking while it runs, frozen once it ended. */
export function turnElapsed(stats: TurnStats, now = Date.now()): number | undefined {
  if (stats.startedAt === undefined) return undefined;
  return Math.max(0, (stats.endedAt ?? now) - stats.startedAt);
}

/** Parse the notification's ISO `at`, falling back to now when it is unreadable. */
export function updateTime(at: string | undefined, now = Date.now()): number {
  if (!at) return now;
  const t = Date.parse(at);
  return Number.isNaN(t) ? now : t;
}
