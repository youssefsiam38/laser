"use client";
/**
 * Message timing (`message-timing`): per-turn elapsed time and token counts
 * under the assistant message, with the breakdown in a tooltip. Renders
 * nothing while the message runs and nothing when there is nothing measured
 * (R3: absent accounting is absent, never "0").
 *
 * Three sources, in order of trust:
 *   1. `useMessageTiming()` — the runtime's own stream timing, when the
 *      adapter provides it.
 *   2. `metadata.custom.piorbit.timing` / `.usage` — what the projection
 *      stamps from Pi's `message_end` usage (`{ output, input, cacheRead,
 *      cacheWrite }`) and the turn's wall clock, when it does.
 *   3. Our local wall clock (`useElapsed`) for a turn this window watched.
 *
 * Divergences from the registry copy: the trigger is a `typed` value in the
 * message footer rather than a mono 11px badge in the action bar, our
 * tooltip is Radix (`asChild`), and tokens are shown alongside time.
 */
import { WIRE_NAMESPACE } from "@piorbit/protocol";
import { useAuiState, useMessageTiming, type MessageState } from "@assistant-ui/react";
import type { FC } from "react";

import { useElapsed } from "@/components/thread/timing";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { duration, tokens as formatTokens } from "@/format";
import { cn } from "@/lib/utils";

interface PiorbitTimingMeta {
  timing?: { elapsedMs?: number };
  usage?: { output?: number; input?: number; cacheRead?: number; cacheWrite?: number };
}

const metaOf = (message: MessageState): PiorbitTimingMeta =>
  ((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom?.[WIRE_NAMESPACE] as PiorbitTimingMeta | undefined) ?? {};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const MessageTiming: FC<{ className?: string | undefined; side?: "top" | "right" | "bottom" | "left" }> = ({ className, side = "top" }) => {
  const timing = useMessageTiming();
  const id = useAuiState((s) => s.message.id);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const stampedElapsed = useAuiState((s) => num(metaOf(s.message).timing?.elapsedMs));
  const output = useAuiState((s) => num(metaOf(s.message).usage?.output));
  const input = useAuiState((s) => num(metaOf(s.message).usage?.input));
  const cacheRead = useAuiState((s) => num(metaOf(s.message).usage?.cacheRead));
  const cacheWrite = useAuiState((s) => num(metaOf(s.message).usage?.cacheWrite));
  const local = useElapsed(`${id}:turn`, running ? "running" : "done");

  if (running) return null;
  const total = timing?.totalStreamTime ?? stampedElapsed ?? local;
  if (total === undefined && output === undefined) return null;

  const summary = [total !== undefined ? duration(total) : undefined, output !== undefined ? `${formatTokens(output)} tokens` : undefined]
    .filter(Boolean)
    .join(" · ");

  const rows: Array<[string, string]> = [];
  if (timing?.firstTokenTime !== undefined) rows.push(["First token", duration(timing.firstTokenTime)]);
  if (total !== undefined) rows.push(["Total", duration(total)]);
  if (timing?.tokensPerSecond !== undefined) rows.push(["Speed", `${timing.tokensPerSecond.toFixed(1)} tok/s`]);
  if (output !== undefined) rows.push(["Output", formatTokens(output)]);
  if (input !== undefined) rows.push(["Input", formatTokens(input)]);
  if (cacheRead !== undefined) rows.push(["Cache read", formatTokens(cacheRead)]);
  if (cacheWrite !== undefined) rows.push(["Cache write", formatTokens(cacheWrite)]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="message-timing"
          tabIndex={0}
          aria-label={`This turn: ${rows.map(([k, v]) => `${k} ${v}`).join(", ")}`}
          className={cn(
            "typed inline-flex h-6 items-center rounded-md px-1 text-ink-3 tnum outline-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
            className,
          )}
        >
          {summary}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}>
        <dl className="grid min-w-36 grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="opacity-70">{k}</dt>
              <dd className="typed text-end text-current tnum">{v}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
};
