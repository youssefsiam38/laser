"use client";
/**
 * An artifact named on its own, in the transcript (M21-T9, D-355 "Outside the
 * workspace").
 *
 * A message that *is* a reference — what `/spec` leaves behind, what a model
 * tool answers with — reads as a compact card rather than a sentence with a
 * chip in it: key, type badge, title, which revision, and the state. Never the
 * body. The body lives in the workspace, one press away, at exactly this
 * revision.
 *
 * What the card knows comes from two places, and it never confuses them. The
 * **message** carries the identity, so the card is legible before anything is
 * read and stays legible when nothing can be. The project's cache, when this
 * window has it, adds the state and how many revisions there are now — and
 * when the entity has moved on, the card says so rather than quietly showing
 * today's state as if it had been said then.
 */
import type { ProjectWorkKind } from "@lasercode/protocol";

import { cn } from "@/lib/utils";
import { landWorkLink, useProjectWorkById, useProjectWorkSnapshot, type WorkLinkTarget } from "@/project-work";
import { KIND_LABEL } from "@/project-work/vocabulary";

import { KeyTag, StatusChip, TypeBadge } from "./KindBadge.js";

export function WorkArtifactCard({
  workKey,
  kind,
  title,
  target,
  className,
}: {
  workKey: string;
  kind: ProjectWorkKind;
  title?: string | undefined;
  target: WorkLinkTarget;
  className?: string;
}) {
  const store = useProjectWorkById(target.projectId);
  const work = useProjectWorkSnapshot(store);
  const row = work.items.find((item) => item.ref.entityId === target.entityId);
  const pinnedRevision = target.revisionId;
  const historical = Boolean(pinnedRevision && row && row.ref.revisionId !== pinnedRevision);
  const open = () => landWorkLink(target);
  return (
    <span
      data-slot="work-artifact-card"
      data-kind={kind}
      className={cn(
        "my-1 flex w-full max-w-md flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-start",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <TypeBadge kind={kind} />
        <KeyTag workKey={workKey} />
        {row ? <StatusChip kind={kind} state={row.state} className="ms-auto shrink-0" /> : null}
      </span>
      <button
        type="button"
        onClick={open}
        className="min-w-0 cursor-pointer truncate text-start text-sm leading-sm text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-live pointer-coarse:min-h-8"
        title={title ?? workKey}
      >
        {title || `${KIND_LABEL[kind]} ${workKey}`}
      </button>
      <span className="text-xs leading-xs text-ink-3">
        {row
          ? historical
            ? `The revision this message names · ${row.revisionCount} revisions now`
            : `Revision ${row.revisionCount} of ${row.revisionCount}`
          : "Open it to read this revision"}
      </span>
    </span>
  );
}
