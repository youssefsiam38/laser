"use client";
/**
 * A mentioned artifact, wherever it is named outside the workspace (M21-T9,
 * D-355 "Outside the workspace").
 *
 * One chip: the key in the kind's colour, the type badge, and the title when
 * there is room for it. It opens the workspace on the **exact revision** the
 * message pinned — never on whatever is current — because a conversation from
 * last week is a record of what was said about one revision.
 *
 * It says what it can prove and nothing else. The chip is built from the
 * identity in the message, so it draws before anything is read, keeps its
 * name when the body cannot be read at all, and never waits on a request to
 * become legible.
 */
import type { ProjectWorkKind, ProjectWorkState } from "@lasercode/protocol";

import { cn } from "@/lib/utils";
import { landWorkLink, type WorkLinkTarget } from "@/project-work";
import { KIND_LABEL, KIND_ICON, KIND_TEXT } from "@/project-work/vocabulary";

import { StatusChip } from "./KindBadge.js";

export interface WorkMentionChipProps {
  workKey: string;
  kind: ProjectWorkKind;
  /** The title as the message recorded it. Absent shows the key alone. */
  title?: string | undefined;
  /** Where the chip opens. Absent draws the chip without an action. */
  target?: WorkLinkTarget | undefined;
  /** Why the body is not available, when a surface knows. */
  unavailable?: string | undefined;
  className?: string;
}

/**
 * The inline chip: in a transcript bubble, in a sidebar row, in a list.
 *
 * A button, not a link, because opening the workspace is a view change inside
 * this window (the same act the palette and the control perform) — and an
 * anchor would offer a new tab that opens nothing.
 */
export function WorkMentionChip({ workKey, kind, title, target, unavailable, className }: WorkMentionChipProps) {
  const Icon = KIND_ICON[kind];
  const label = title ? `${KIND_LABEL[kind]} ${workKey}: ${title}` : `${KIND_LABEL[kind]} ${workKey}`;
  const content = (
    <>
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", KIND_TEXT[kind])} />
      <span className={cn("typed tnum shrink-0", KIND_TEXT[kind])}>{workKey}</span>
      {title ? <span className="min-w-0 truncate text-ink-2">{title}</span> : null}
    </>
  );
  const shell =
    "mx-0.5 inline-flex max-w-full min-w-0 items-baseline gap-1.5 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 align-baseline text-xs leading-xs [&_svg]:self-center";
  if (!target) {
    return (
      <span data-slot="work-mention" data-kind={kind} aria-label={label} title={unavailable ?? label} className={cn(shell, className)}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="work-mention"
      data-kind={kind}
      aria-label={unavailable ? `${label} — ${unavailable}` : label}
      title={unavailable ?? label}
      onClick={() => landWorkLink(target)}
      className={cn(
        shell,
        "cursor-pointer transition-colors duration-(--motion-instant) hover:bg-surface-3 focus-visible:outline focus-visible:outline-live pointer-coarse:min-h-8",
        className,
      )}
    >
      {content}
    </button>
  );
}

/**
 * The sessions sidebar's chip: a conversation that is an execution of a Task
 * says which Task, in one row, without a second line (D-355, "Outside the
 * workspace").
 */
export function SessionTaskChip({ workKey, target, state, className }: {
  workKey: string;
  target?: WorkLinkTarget | undefined;
  state?: ProjectWorkState | undefined;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <WorkMentionChip workKey={workKey} kind="task" {...(target ? { target } : {})} />
      {state ? <StatusChip kind="task" state={state} className="shrink-0" /> : null}
    </span>
  );
}
