"use client";
/**
 * Connection state — the reconnecting banner (docs/ux-elements.md "Thread").
 * Installed from `elements-connection-state` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - A full-width line under the top bar, not a floating card: it is the
 *     only thing in the shell that says "connection", and it sits where the
 *     eye already is.
 *   - Copy written for this product: the host, not "the server"; sessions
 *     resume from where they left off because the host replays them.
 *   - `resumedTokens` is gone: nothing counts tokens across a reconnect.
 *   - `HostConnectionState` is the runtime-bound wrapper; it derives the four
 *     phases from the socket state and holds "resumed" for a moment.
 */
import { CheckIcon, CloudOffIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";

import { mono } from "./surfaces.js";

export type ConnectionPhase = "online" | "dropped" | "reconnecting" | "resumed";

export interface ConnectionStateProps extends Omit<ComponentProps<"div">, "children"> {
  phase: ConnectionPhase;
  /** Reconnect attempt number, when known. */
  attempt?: number | undefined;
  /** True the first time: nothing has connected yet, so nothing was lost. */
  first?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

export function ConnectionState({ phase, attempt, first = false, onRetry, className, ...props }: ConnectionStateProps) {
  if (phase === "online") return null;
  const tone = phase === "dropped" ? "attention" : phase === "resumed" ? "ok" : "attention";
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="connection-state"
      data-phase={phase}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 px-4 text-xs hairline-b",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-slow)",
        tone === "ok"
          ? "bg-[color-mix(in_oklab,var(--ok)_9%,var(--bg))]"
          : "bg-[color-mix(in_oklab,var(--attention)_9%,var(--bg))]",
        className,
      )}
      {...props}
    >
      {phase === "dropped" && (
        <>
          <CloudOffIcon aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
          <span className="font-medium text-ink">Disconnected from the host</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">
            Retrying in the background. Every session is saved on this computer as it goes, so nothing you have already seen is lost.
          </span>
          {onRetry && (
            <Button variant="outline" size="xs" onClick={onRetry} className="ms-auto shrink-0">
              Reconnect now
            </Button>
          )}
        </>
      )}
      {phase === "reconnecting" && (
        <>
          <StatusDot status="working" size="sm" label="Connecting" />
          <span className="font-medium text-ink">{first ? "Connecting to the host…" : "Reconnecting to the host…"}</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">
            {first ? "The desktop host serves this page and runs the agent." : "Sessions resume from where they left off."}
          </span>
          {attempt !== undefined && attempt > 1 && (
            <span className={cn(mono, "ms-auto shrink-0 text-ink-3")}>attempt {attempt}</span>
          )}
        </>
      )}
      {phase === "resumed" && (
        <>
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
          <span className="font-medium text-ink">Back online</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">Picked every session back up.</span>
        </>
      )}
    </div>
  );
}

/** How long "Back online" stays before the line goes away. */
const RESUMED_MS = 2500;

/**
 * The socket state as a phase: `connecting` before the first open is
 * "reconnecting" with `first`; `closed` after an open is "dropped"; the first
 * `open` after either is "resumed" for {@link RESUMED_MS}.
 */
export function useConnectionPhase(): { phase: ConnectionPhase; first: boolean } {
  const connection = useLaserState((s) => s.connection);
  const everOpen = useRef(false);
  const wasDown = useRef(false);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    if (connection !== "open") {
      wasDown.current = true;
      return;
    }
    const cameBack = everOpen.current && wasDown.current;
    everOpen.current = true;
    wasDown.current = false;
    if (!cameBack) return;
    setResumed(true);
    const timer = setTimeout(() => setResumed(false), RESUMED_MS);
    return () => clearTimeout(timer);
  }, [connection]);

  const first = !everOpen.current;
  if (connection === "open") return { phase: resumed ? "resumed" : "online", first: false };
  if (connection === "connecting") return { phase: "reconnecting", first };
  return { phase: "dropped", first };
}

/** One quiet line under the top bar while the host is unreachable; absent when connected. */
export function HostConnectionState({ className }: { className?: string | undefined }) {
  const { client } = useLaserStable();
  const { phase, first } = useConnectionPhase();
  return (
    <ConnectionState
      phase={phase}
      first={first}
      onRetry={() => {
        client.close();
        client.connect();
      }}
      className={className}
    />
  );
}
