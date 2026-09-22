"use client";
/**
 * The Task inspector's own sections (D-355, "Detail, by kind" → Task:
 * *"dependencies as key cards, Plan, Jira"*).
 *
 * A dependency is a **card**, not a chip: it carries the key, the type badge,
 * the title and the state, because "what is this waiting for" is answered by
 * the state of the thing it waits on — and a key with no state is a riddle.
 * A dependency this window has not read says exactly that rather than being
 * dropped or guessed at.
 *
 * Jira is not drawn here: nothing in this revision carries an external issue
 * key yet, and a chip for a link that does not exist would be a promise the
 * data cannot keep. The external-work link lands with M25 (`external-work-links.md`).
 */
import { CircleDashed } from "lucide-react";
import type { ProjectTaskBody, ProjectWorkListItem, TaskReadiness } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";

import { KeyTag, StatusChip, TypeBadge } from "./KindBadge.js";
import { Section } from "./bodies/fields.js";

export function TaskInspectorSections({
  body,
  readiness,
  items,
}: {
  body: ProjectTaskBody;
  readiness: TaskReadiness | undefined;
  items: readonly ProjectWorkListItem[];
}) {
  const unmet = new Set(readiness?.unmetDependencies ?? []);
  const plan = body.planKey ? items.find((item) => item.key === body.planKey) : undefined;

  return (
    <>
      <Section title="Depends on">
        {body.dependencies.length === 0 ? (
          <p className="text-sm leading-5 text-ink-3">Nothing. This task can be picked up on its own.</p>
        ) : (
          <ul role="list" data-slot="task-dependencies" className="flex flex-col gap-1.5">
            {body.dependencies.map((key) => (
              <li key={key}>
                <DependencyCard workKey={key} row={items.find((item) => item.key === key)} unmet={unmet.has(key)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Belongs to">
        {plan ? (
          <button
            type="button"
            onClick={() => selectWork({ entityId: plan.ref.entityId, kind: plan.kind })}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface p-2 text-start outline-none",
              "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
              "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
            )}
          >
            <TypeBadge kind="plan" />
            <KeyTag workKey={plan.key} />
            <span className="min-w-0 truncate text-sm leading-5 text-ink-2">{plan.title}</span>
          </button>
        ) : body.planKey ? (
          <p className="flex items-center gap-2 text-sm leading-5 text-ink-3">
            <KeyTag workKey={body.planKey} /> is not in what this window has read.
          </p>
        ) : (
          <p className="text-sm leading-5 text-ink-3">No plan. A task is usable on its own, like every other link here.</p>
        )}
      </Section>
    </>
  );
}

function DependencyCard({ workKey, row, unmet }: { workKey: string; row: ProjectWorkListItem | undefined; unmet: boolean }) {
  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {row ? <TypeBadge kind={row.kind} /> : <CircleDashed aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />}
        <KeyTag workKey={workKey} {...(unmet ? { className: "text-attention" } : {})} />
        {row ? <StatusChip kind={row.kind} state={row.state} className="ms-auto" /> : <Badge variant="outline" className="ms-auto">unread</Badge>}
      </span>
      <span className="min-w-0 truncate text-sm leading-5 text-ink-2" title={row?.title}>
        {row?.title ?? "Not in what this window has read"}
      </span>
      {unmet ? <span className="text-xs leading-xs text-attention">This one has to be done first.</span> : null}
    </>
  );
  const shell = cn(
    "flex w-full min-w-0 flex-col gap-1 rounded-lg border p-2 text-start",
    unmet ? "border-attention bg-[color-mix(in_oklab,var(--attention)_8%,transparent)]" : "border-line bg-surface",
  );
  if (!row) return <span className={shell}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={() => selectWork({ entityId: row.ref.entityId, kind: row.kind })}
      className={cn(
        shell,
        "outline-none transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
      )}
    >
      {inner}
    </button>
  );
}
