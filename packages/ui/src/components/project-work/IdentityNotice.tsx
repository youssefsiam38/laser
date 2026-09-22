"use client";
/**
 * What this folder is, when that is not obvious (M21-T20).
 *
 * Two situations, one strip above the backlog, and nothing at all the rest of
 * the time:
 *
 * - **This folder was copied from another one.** Both are still here, so the
 *   app has kept them apart and is asking which this is. It never merges two
 *   histories on its own, and it never guesses from a path.
 * - **This project was removed from the list.** Its work is kept and hidden,
 *   not deleted, and saying so is the difference between a person trusting the
 *   app with a year of decisions and not.
 *
 * The strip covers nothing: the rows underneath are true either way. Every
 * colour, size and duration here is a token, and the copy is the host's own
 * sentence — one authority for what is happening, not two.
 */
import { Copy, EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectWorkSnapshot, ProjectWorkStore } from "@/project-work";
import type { ProjectRelinkChoice } from "@lasercode/protocol";

export function IdentityNotice({ store, work, className }: { store: ProjectWorkStore | undefined; work: ProjectWorkSnapshot; className?: string }) {
  const [busy, setBusy] = useState<ProjectRelinkChoice | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const identity = work.identity;
  if (!identity) return null;
  const choosing = identity.choices.length > 0;
  if (!choosing && !identity.hidden) return null;

  const choose = (choice: ProjectRelinkChoice) => {
    if (!store || busy) return;
    setBusy(choice);
    setFailure(undefined);
    void store
      .relink(choice)
      .then((outcome) => {
        if (!outcome.ok) setFailure(outcome.failure.message);
      })
      .finally(() => setBusy(undefined));
  };

  const Icon = choosing ? Copy : EyeOff;
  return (
    <div
      data-slot="project-identity-notice"
      role={choosing ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs leading-xs text-ink-2",
        choosing ? "bg-[color-mix(in_oklab,var(--attention)_10%,transparent)]" : "bg-surface-2",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", choosing ? "text-attention" : "text-ink-3")} />
      <span className="min-w-0 max-w-(--measure-prose)">{failure ?? identity.detail}</span>
      {choosing ? (
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          {identity.choices.includes("reconnect") ? (
            <Button size="xs" variant="outline" disabled={busy !== undefined} onClick={() => choose("reconnect")}>
              {busy === "reconnect" ? <Loader2 aria-hidden="true" className="motion-safe:animate-busy" /> : null}
              Continue {identity.marked?.name ?? "the other project"} here
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" disabled={busy !== undefined} onClick={() => choose("fresh")}>
            {busy === "fresh" ? <Loader2 aria-hidden="true" className="motion-safe:animate-busy" /> : null}
            Keep this folder separate
          </Button>
        </span>
      ) : null}
    </div>
  );
}
