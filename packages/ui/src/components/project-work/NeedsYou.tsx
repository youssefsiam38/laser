"use client";
/**
 * Needs you — everything in this project waiting on a person (D-355).
 *
 * The queue is derived from the rows with the host's own rule, so it is exact
 * from the first read rather than only after a notification happens to arrive,
 * and the count on the tab and on the top-bar control is the same number.
 *
 * The rows are the adopted `artifact-card` shape: what it is, why it is
 * waiting, and the one thing to do about it — open it. The answering itself
 * (approve, resolve, request changes) is M21-T8 and happens in the detail and
 * in the existing Approval Card above the composer; nothing is answered from a
 * list, because a decision needs what it is deciding on screen.
 */
import { CheckCheck } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { relativeTime } from "@/format";
import { attentionQueue } from "@/project-work/model";
import { selectWork, setWorkspaceTab, type ProjectWorkSnapshot } from "@/project-work";
import { ATTENTION_REASON } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { WorkPlaceholder } from "./states.js";

export function NeedsYou({ work }: { work: ProjectWorkSnapshot }) {
  const queue = useMemo(() => attentionQueue(work.items), [work.items]);

  if (queue.length === 0) {
    return (
      <WorkPlaceholder
        icon={CheckCheck}
        title="Nothing is waiting on you"
        detail="Reviews, blocking comments, blocked tasks and anything an agent hands over land here."
        action={
          <Button size="sm" variant="outline" onClick={() => setWorkspaceTab("work")}>
            Back to the work
          </Button>
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <ul role="list" className="mx-auto flex max-w-(--measure-thread) flex-col gap-2">
        {queue.map((entry) => {
          const reason = ATTENTION_REASON[entry.reason];
          return (
            <li key={entry.entityId}>
              <div className="flex min-w-0 items-start gap-3 rounded-xl border border-line bg-surface p-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                  <TypeBadge kind={entry.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <KeyTag workKey={entry.key} />
                    <span className="min-w-0 truncate text-sm leading-5 font-medium text-ink" title={entry.title}>
                      {entry.title}
                    </span>
                  </span>
                  <span className="text-sm leading-5 text-attention">{reason.label}</span>
                  <span className="text-xs leading-xs text-ink-2">{reason.detail}</span>
                  <span className="text-xs leading-xs text-ink-3">{relativeTime(entry.at)}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    setWorkspaceTab("work");
                    selectWork({ entityId: entry.entityId, kind: entry.kind });
                  }}
                >
                  Open
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
