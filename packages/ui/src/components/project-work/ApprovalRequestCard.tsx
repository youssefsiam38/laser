"use client";
/**
 * The lifecycle review request, in the transcript (M21-T8, D-355).
 *
 * The leap is exact about this one: a review request appears above the
 * composer **through the existing Approval Card**, carrying the key, and the
 * reading and the decision happen in the embedded workspace. So this card
 * borrows `ApprovalCard` — the same element the session's own questions use,
 * so one question never looks like two things — and its answer is *open the
 * workspace at that exact revision*, never an approval.
 *
 * Three consequences, all deliberate:
 *
 * - **Enter never approves.** There is no approval here to press: the element
 *   autofocuses the dismissive control, and the only other control navigates.
 * - **Nothing is invented.** The card is drawn from the project's own
 *   attention queue — gates and blocking comments — and disappears when the
 *   host says the queue is empty.
 * - **Dismissing is per row and per window.** "Not now" hides this request
 *   until it changes; it never answers anything and never writes.
 */
import { useMemo, useState } from "react";
import { ShieldQuestionMark } from "lucide-react";

import { ApprovalCard } from "@/components/assistant-ui/elements/approval-card";
import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { attentionQueue, openWorkspace, selectWork, setWorkspaceTab, useProjectWork } from "@/project-work";
import { ATTENTION_REASON } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";

/** Only the two reasons that are a review request. A blocked task is not one. */
const REVIEW_REASONS = new Set(["gate", "blocking_comment"]);

export function ApprovalRequestCard({ cwd, className }: { cwd: string | undefined; className?: string }) {
  const { work } = useProjectWork(cwd);
  const touch = useIsTouch();
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const request = useMemo(() => {
    const queue = attentionQueue(work.items).filter((item) => REVIEW_REASONS.has(item.reason));
    return queue.find((item) => dismissed[item.entityId] !== item.at);
  }, [dismissed, work.items]);

  if (!cwd || !request || !work.projectId) return null;
  const projectId = work.projectId;
  const item = work.items.find((candidate) => candidate.ref.entityId === request.entityId);
  const reason = ATTENTION_REASON[request.reason];
  const waiting = attentionQueue(work.items).filter((candidate) => REVIEW_REASONS.has(candidate.reason)).length - 1;

  const open = (): void => {
    openWorkspace({ projectId });
    setWorkspaceTab("work");
    // The exact revision the request is about, so the workspace opens on what
    // is being asked about rather than on whatever is current later.
    selectWork({
      entityId: request.entityId,
      kind: request.kind,
      ...(item?.ref.revisionId ? { revisionId: item.ref.revisionId } : {}),
    });
  };

  return (
    <div
      data-slot="lifecycle-review-card"
      data-reason={request.reason}
      role="region"
      aria-label={`Review request: ${request.key}`}
      className={cn("rounded-2xl border border-line bg-surface p-4 shadow-float-sm", className)}
    >
      <ApprovalCard
        titleId={`review-${request.entityId}`}
        icon={ShieldQuestionMark}
        eyebrow="Project work · waiting on you"
        title={`${request.key} · ${request.title}`}
        message={`${reason.label}. ${reason.detail}`}
        touch={touch}
        busy={false}
        choices={[`Open ${request.key} in the workspace`]}
        onChoose={open}
        // No `onCancel`: the one way out is "Not now", and it is the control
        // the element autofocuses, so a stray Enter dismisses rather than acts.
        declineLabel="Not now"
        onDecline={() => setDismissed((before) => ({ ...before, [request.entityId]: request.at }))}
      />
      <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-3">
        <TypeBadge kind={request.kind} />
        <KeyTag workKey={request.key} />
        <span>The full reading, and the decision, happen in the workspace.</span>
      </p>
      {waiting > 0 ? <p className="mt-1 text-xs leading-xs text-ink-3">+{waiting} more waiting behind this one</p> : null}
    </div>
  );
}
