"use client";
/**
 * Recent — what changed, by revision, newest first (D-355).
 *
 * Two sources, and the difference between them is visible rather than papered
 * over. A change this window *watched* carries who made it and which session
 * it was written from, because the event says so. A row this window only ever
 * read carries the entity's own last-updated time, and says nothing it was not
 * told. Nothing invents an author.
 *
 * Drawn on the adopted `timeline` element.
 */
import { History } from "lucide-react";
import { useMemo } from "react";
import type { ProjectWorkChange } from "@lasercode/protocol";

import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline";
import { clockTime, relativeTime } from "@/format";
import { selectWork, setWorkspaceTab, type ProjectWorkSnapshot } from "@/project-work";
import { KIND_LABEL, stateLabel } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { WorkPlaceholder } from "./states.js";

const CHANGE_VERB: Readonly<Record<ProjectWorkChange["change"], string>> = {
  created: "created",
  revised: "revised",
  state: "moved",
  archived: "archived",
  deleted: "deleted",
  comment: "commented on",
  approval: "approved",
  link: "linked",
  unlink: "unlinked",
  execution: "linked an attempt to",
  stale: "went stale",
};

export function Recent({ work }: { work: ProjectWorkSnapshot }) {
  const live: TimelineEvent[] = useMemo(
    () =>
      work.recent.map((change, index) => ({
        id: `${change.entityId}-${change.at}-${index}`,
        when: index === 0 ? "now" : "past",
        time: clockTime(change.at),
        title: `${change.key} ${CHANGE_VERB[change.change]}`,
        detail: [change.title, change.actorLabel, change.sessionId ? "from a session" : undefined].filter(Boolean).join(" · "),
        ...(change.change === "stale" ? { tone: "attention" as const } : {}),
      })),
    [work.recent],
  );

  const read = useMemo(() => [...work.items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 30), [work.items]);

  if (work.items.length === 0) {
    return <WorkPlaceholder icon={History} title="Nothing has happened yet" detail="Every revision of every item shows up here, newest first." />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto flex max-w-(--measure-thread) flex-col gap-6">
        {live.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="eyebrow">While this window was open</h3>
            <Timeline events={live} />
          </section>
        ) : null}
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">By revision</h3>
          <ul role="list" className="flex flex-col">
            {read.map((row) => (
              <li key={row.ref.entityId}>
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceTab("work");
                    selectWork({ entityId: row.ref.entityId, kind: row.kind });
                  }}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live pointer-coarse:min-h-11"
                >
                  <TypeBadge kind={row.kind} />
                  <KeyTag workKey={row.key} />
                  <span className="min-w-0 flex-1 truncate text-sm leading-5 text-ink" title={row.title}>
                    {row.title}
                  </span>
                  <span className="hidden shrink-0 text-xs leading-xs text-ink-3 sm:inline">
                    {KIND_LABEL[row.kind]} · revision {row.revisionCount} · {stateLabel(row.kind, row.state)}
                  </span>
                  <span className="shrink-0 text-xs leading-xs text-ink-3">{relativeTime(row.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
