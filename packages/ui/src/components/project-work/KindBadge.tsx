"use client";
/**
 * Type identity, everywhere it appears (D-355, "Keys and type identity").
 *
 * Three separate things, deliberately:
 *
 * - `TypeBadge` — the kind: one colour token, one SVG icon. It never says
 *   anything about state.
 * - `KeyTag` — `SPEC-12`. Typed face, tabular, copyable, greppable, the thing
 *   a person says out loud. It is a handle, not the identity.
 * - `StatusChip` — the state, in this kind's own words, in the app's existing
 *   status tones. A "needs you" chip is the only cross-kind status there is.
 *
 * Everything here holds at the 12px floor and truncates rather than shrinking.
 */
import type { ProjectWorkKind, ProjectWorkState } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ATTENTION_REASON, KIND_ICON, KIND_LABEL, KIND_TEXT, stateLabel, stateTone } from "@/project-work/vocabulary";
import type { ProjectWorkAttentionReason } from "@lasercode/protocol";

export function TypeBadge({ kind, className, withLabel = false }: { kind: ProjectWorkKind; className?: string; withLabel?: boolean }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      data-slot="work-type-badge"
      data-kind={kind}
      className={cn("inline-flex shrink-0 items-center gap-1", KIND_TEXT[kind], className)}
      title={withLabel ? undefined : KIND_LABEL[kind]}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {withLabel ? <span className="text-xs leading-xs font-medium">{KIND_LABEL[kind]}</span> : <span className="sr-only">{KIND_LABEL[kind]}</span>}
    </span>
  );
}

export function KeyTag({ workKey, className, muted = false }: { workKey: string; className?: string; muted?: boolean }) {
  return (
    <span data-slot="work-key" className={cn("typed shrink-0 tnum", muted ? "text-ink-3" : "text-ink-2", className)}>
      {workKey}
    </span>
  );
}

const TONE_VARIANT = {
  live: "live",
  attention: "attention",
  ok: "ok",
  danger: "danger",
  muted: "outline",
} as const;

export function StatusChip({
  kind,
  state,
  staleBecauseKey,
  className,
}: {
  kind: ProjectWorkKind;
  state: ProjectWorkState;
  staleBecauseKey?: string | undefined;
  className?: string;
}) {
  const label = stateLabel(kind, state);
  const chip = (
    <Badge variant={TONE_VARIANT[stateTone(state)]} className={className}>
      {label}
    </Badge>
  );
  if (!staleBecauseKey) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live">
          {chip}
        </span>
      </TooltipTrigger>
      <TooltipContent>{staleBecauseKey} changed after this was approved.</TooltipContent>
    </Tooltip>
  );
}

/** The one cross-kind status. It says why, because a badge with no reason is a nag. */
export function NeedsYouChip({ reason, className }: { reason: ProjectWorkAttentionReason | undefined; className?: string }) {
  const detail = reason ? ATTENTION_REASON[reason] : undefined;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="attention" tabIndex={0} className={className}>
          Needs you
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 items-start">
        {detail ? (
          <>
            {detail.label}
            <span className="text-xs opacity-70">{detail.detail}</span>
          </>
        ) : (
          "Waiting for you."
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * `KEY · badge · title` — the one line that names an entity, used by the
 * backlog rows, the board cards, the queue, Recent and the detail header.
 */
export function WorkIdentity({
  workKey,
  kind,
  title,
  className,
  titleClassName,
}: {
  workKey: string;
  kind: ProjectWorkKind;
  title: string;
  className?: string;
  titleClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <TypeBadge kind={kind} />
      <KeyTag workKey={workKey} />
      <span className={cn("min-w-0 truncate text-sm leading-5 text-ink", titleClassName)} title={title}>
        {title}
      </span>
    </span>
  );
}
