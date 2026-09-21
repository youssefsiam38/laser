"use client";
/**
 * The states every workspace surface has, written once.
 *
 * Empty, loading, behind, refused and offline are designed here with the same
 * care as the main path (AGENTS.md): each says what is true, and each says
 * what to do next when there is something to do. None of them is a spinner
 * over content that already exists — a loading state on top of rows a person
 * can already read is a lie about what is on screen.
 */
import { CloudOff, RefreshCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WorkPlaceholder({
  icon: Icon,
  title,
  detail,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  detail: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center", className)}>
      {Icon ? <Icon aria-hidden="true" className="size-6 text-ink-3" /> : null}
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">{detail}</p>
      {action}
    </div>
  );
}

/** The first read of a project, before there is anything to show. */
export function WorkLoading({ label = "Reading this project's work" }: { label?: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <GenerationLoader label={label} />
    </div>
  );
}

/**
 * The strip above a surface whose rows are real but older than the host's.
 * It never covers anything: the rows underneath are still true, just behind.
 */
export function BehindNotice({ offline, error, onRetry }: { offline: boolean; error: string | undefined; onRetry: () => void }) {
  if (!offline && !error) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-line bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-3 py-1.5 text-xs leading-xs text-ink-2"
    >
      <CloudOff aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
      <span className="min-w-0">
        {error ?? "Not connected, so this list is as it was a moment ago."} Nothing here is lost; it catches up when the connection is back.
      </span>
      <Button size="xs" variant="outline" onClick={onRetry} className="ms-auto">
        <RefreshCw />
        Try now
      </Button>
    </div>
  );
}

/** A refusal with the host's own sentence, and the one thing to do about it. */
export function WorkRefusal({ message, recovery, onRetry }: { message: string; recovery?: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-sm leading-5 text-ink">{message}</p>
      {recovery ? <p className="text-xs leading-xs text-ink-2">{recovery}</p> : null}
      {onRetry ? (
        <div>
          <Button size="xs" variant="outline" onClick={onRetry}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
