"use client";
/**
 * One entity, at one exact revision (D-355, "Detail, by kind").
 *
 * The frame is the same for every kind — `KEY · badge · title · status ·
 * actions`, a revision switcher, and the body underneath — and the body is
 * each kind's own. A historical revision is read as it was written: the
 * switcher never rewrites what an older revision said, and it says plainly
 * that this is not the current one.
 */
import { ArrowLeft, Archive, ArchiveRestore, Copy, History, Link as LinkIcon, MoreHorizontal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ClientRequests } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dateTime, relativeTime } from "@/format";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useCapability } from "@/runtime";
import {
  formatWorkLinkHash,
  selectWork,
  useWorkspaceUi,
  workLinkUrl,
  type ProjectWorkSnapshot,
  type ProjectWorkStore,
} from "@/project-work";
import { KIND_LABEL } from "@/project-work/vocabulary";

import { ArchiveDialog, DeleteDialog } from "./ConfirmDialogs.js";
import { DesignDetail } from "./bodies/DesignDetail.js";
import { PlanDetail } from "./PlanDetail.js";
import { TaskDetail } from "./TaskDetail.js";
import { WorkBody } from "./bodies/index.js";
import { KeyTag, StatusChip, TypeBadge } from "./KindBadge.js";
import { WorkLoading, WorkPlaceholder, WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];

export function WorkDetail({
  store,
  work,
  className,
  compact = false,
  onBack,
}: {
  store: ProjectWorkStore | undefined;
  work: ProjectWorkSnapshot;
  className?: string;
  compact?: boolean;
  onBack?: () => void;
}) {
  const ui = useWorkspaceUi();
  const selection = ui.selection;
  const [detail, setDetail] = useState<Detail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { actions } = useLaserStable();
  const { copy } = useCopy();
  const canWrite = useCapability("project/work/archive", { presentation: "explained" });
  const canRevise = useCapability("project/work/revise", { presentation: "explained" });

  const entityId = selection?.entityId;
  const revisionId = selection?.revisionId;
  // The read is fenced by the selection and by the project's sequence: a
  // revision that lands while this is open re-reads rather than patching.
  const read = useCallback(async () => {
    if (!store || !entityId) return;
    setLoading(true);
    const outcome = await store.get({
      entityId,
      ...(revisionId ? { revisionId } : {}),
      body: { mode: "full" },
      include: { comments: true, approvals: true, evidence: true, links: true, history: true },
    });
    setLoading(false);
    if (outcome.ok) {
      setDetail(outcome.value);
      setError(undefined);
    } else {
      setDetail(undefined);
      setError(outcome.failure.message);
    }
  }, [entityId, revisionId, store]);

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    void read();
  }, [read, work.seq]);

  if (!selection) {
    return (
      <div className={cn("flex min-h-0 flex-col", className)}>
        <WorkPlaceholder
          title="Nothing open"
          detail="Pick anything on the left to read it. Keys work too: type a key such as SPEC-1 into the filter."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("flex min-h-0 flex-col gap-3 p-3", className)}>
        {compact && onBack ? <BackButton onBack={onBack} /> : null}
        <WorkRefusal message={error} onRetry={() => void read()} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className={cn("flex min-h-0 flex-col", className)}>
        <WorkLoading label={loading ? `Reading ${KIND_LABEL[selection.kind].toLocaleLowerCase()}` : "Opening"} />
      </div>
    );
  }

  const { entity, revision, ref } = detail;
  const historical = revision.revisionId !== entity.currentRevisionId;
  const history = detail.history ?? [];

  return (
    <div data-slot="work-detail" className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex flex-col gap-2 border-b border-line p-3">
        {compact && onBack ? <BackButton onBack={onBack} /> : null}
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <TypeBadge kind={entity.kind} />
              <KeyTag workKey={entity.key} />
              <StatusChip
                kind={entity.kind}
                state={entity.state}
                staleBecauseKey={entity.staleBecause?.upstreamKey}
              />
            </span>
            <h2 className="min-w-0 text-base leading-6 font-semibold text-ink">{revision.title}</h2>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${entity.key}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuItem
                onSelect={() => {
                  void copy(workLinkUrl({ projectId: ref.projectId, kind: ref.kind, entityId: ref.entityId, revisionId: revision.revisionId })).then((ok) =>
                    actions.toast(ok ? "info" : "error", ok ? "Link to this exact revision copied" : "Could not copy the link"),
                  );
                }}
              >
                <LinkIcon />
                Copy a link to this revision
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void copy(entity.key).then((ok) => actions.toast(ok ? "info" : "error", ok ? `${entity.key} copied` : "Could not copy the key"));
                }}
              >
                <Copy />
                Copy the key
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={canWrite.state !== "available"} onSelect={() => setArchiving(true)}>
                {entity.archivedAt ? <ArchiveRestore /> : <Archive />}
                {entity.archivedAt ? "Restore from the archive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={canWrite.state !== "available"} variant="destructive" onSelect={() => setDeleting(true)}>
                <Trash2 />
                Delete permanently…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline">
                <History />
                Revision {revision.index} of {entity.revisionCount}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 min-w-64 overflow-y-auto">
              <DropdownMenuLabel>Revisions, newest first</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={revision.revisionId}
                onValueChange={(value) =>
                  selectWork({
                    entityId: entity.entityId,
                    kind: entity.kind,
                    ...(value === entity.currentRevisionId ? {} : { revisionId: value }),
                  })
                }
              >
                {(history.length > 0 ? history : [revision]).map((candidate) => (
                  <DropdownMenuRadioItem key={candidate.revisionId} value={candidate.revisionId} className="items-start">
                    <span>
                      <span className="block">
                        Revision {candidate.index}
                        {candidate.revisionId === entity.currentRevisionId ? " · current" : ""}
                      </span>
                      <span className="mt-0.5 block text-xs leading-4 text-ink-3">
                        {dateTime(candidate.createdAt)} · {candidate.origin.actor.label}
                        {candidate.note ? ` · ${candidate.note}` : ""}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-xs leading-xs text-ink-3">
            {relativeTime(revision.createdAt)} · {revision.origin.actor.label}
          </span>
        </div>

        {historical ? (
          <p role="status" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
            This is revision {revision.index}, not the current one. Editing is disabled on an older revision.{" "}
            {selection.fromLink ? "The link you followed named it exactly, so it stays where it was." : ""}{" "}
            <button
              type="button"
              className="text-live underline-offset-4 outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              onClick={() => selectWork({ entityId: entity.entityId, kind: entity.kind })}
            >
              Go to the current revision
            </button>
          </p>
        ) : null}

        {entity.staleBecause ? (
          <p role="status" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
            {entity.staleBecause.upstreamKey} changed after this was approved, so this needs reconciling before anything downstream moves.
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Plan and Task have detail surfaces of their own (M21-T16): the
            plan's Document/Dependencies switch and the task's attempts,
            evidence and checkpoints need the whole read, not just the body. */}
        {detail.body?.body?.kind === "plan" ? (
          <PlanDetail detail={detail} body={detail.body.body.plan} items={work.items} />
        ) : detail.body?.body?.kind === "task" ? (
          <TaskDetail store={store} detail={detail} body={detail.body.body.task} items={work.items} />
        ) : detail.body?.body?.kind === "design" ? (
          // The Design's canvas, inspector and prototype (M21-T11): the same
          // fenced context as the other editable bodies.
          <DesignDetail
            body={detail.body.body.design}
            context={{
              store,
              detail,
              editable: !historical && canRevise.state === "available" && !entity.archivedAt,
              readOnlyReason: historical
                ? "Editing is disabled on an older revision."
                : entity.archivedAt
                  ? "This is archived. Restore it to make changes."
                  : canRevise.state === "available"
                    ? undefined
                    : "This connection cannot write to this project's work.",
              onChanged: () => void read(),
              items: work.items,
              compact,
            }}
          />
        ) : detail.body?.body ? (
          <WorkBody
            body={detail.body.body}
            items={work.items}
            context={{
              store,
              detail,
              // An older revision is read as it was written, and a window
              // without the capability says so rather than offering a control
              // that would fail (M21-T7).
              editable: !historical && canRevise.state === "available" && !entity.archivedAt,
              readOnlyReason: historical
                ? "Editing is disabled on an older revision."
                : entity.archivedAt
                  ? "This is archived. Restore it to make changes."
                  : canRevise.state === "available"
                    ? undefined
                    : "This connection cannot write to this project's work.",
              onChanged: () => void read(),
              items: work.items,
              compact,
            }}
          />
        ) : detail.body?.released ? (
          <WorkRefusal
            message="This revision's content is no longer stored on this machine."
            recovery={detail.body.released.detail}
          />
        ) : (
          <WorkRefusal message="This revision's content could not be read." onRetry={() => void read()} />
        )}
      </div>

      <ArchiveDialog store={store} detail={detail} open={archiving} onOpenChange={setArchiving} />
      <DeleteDialog store={store} detail={detail} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onBack} className="self-start">
      <ArrowLeft className="rtl:-scale-x-100" />
      All work
    </Button>
  );
}

/** The hash a deep link to the open revision would carry. Used by tests and by copy. */
export function detailLinkHash(detail: Detail): string {
  return formatWorkLinkHash({
    projectId: detail.ref.projectId,
    kind: detail.ref.kind,
    entityId: detail.ref.entityId,
    revisionId: detail.revision.revisionId,
  });
}
