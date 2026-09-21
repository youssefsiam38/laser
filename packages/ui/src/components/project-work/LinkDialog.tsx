"use client";
/**
 * "Link something…" — the act (M21-T7, D-355 "Actions common to every kind").
 *
 * Links are optional in every direction and always were: nothing here is
 * required, nothing nags for one, and an artifact with no links is complete
 * rather than pending (D-352). This dialog is only how a person *adds* one
 * when they want it: pick the relation, pick the other artifact by key, and
 * the edge is written between the two exact revisions this window is reading
 * — `subject —relation→ object`, which is what staleness is later computed
 * along.
 */
import { Link2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PROJECT_WORK_EDGE_RELATIONS, type ProjectWorkEdgeRelation, type ProjectWorkListItem } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { ProjectWorkStore } from "@/project-work";

import type { WorkDetailResult } from "./bodies/context.js";
import { KeyTag, TypeBadge } from "./KindBadge.js";

/** What each relation *says*, in the direction it is written. */
export const RELATION_SENTENCE: Readonly<Record<ProjectWorkEdgeRelation, string>> = {
  supports: "this supports",
  implements: "this implements",
  depends_on: "this depends on",
  verifies: "this verifies",
  supersedes: "this supersedes",
  derived_from: "this was derived from",
};

export function LinkDialog({
  store,
  detail,
  items,
  open,
  onOpenChange,
  onLinked,
}: {
  store: ProjectWorkStore | undefined;
  detail: WorkDetailResult;
  items: readonly ProjectWorkListItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}) {
  const { actions } = useLaserStable();
  const [relation, setRelation] = useState<ProjectWorkEdgeRelation>("supports");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items
      .filter((item) => item.ref.entityId !== detail.entity.entityId && !item.archived)
      .filter((item) => needle === "" || item.key.toLocaleLowerCase().includes(needle) || item.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (a.key.toLocaleLowerCase() === needle ? -1 : b.key.toLocaleLowerCase() === needle ? 1 : 0))
      .slice(0, 40);
  }, [detail.entity.entityId, items, query]);

  const target = candidates.find((item) => item.ref.entityId === targetId);

  const save = async (): Promise<void> => {
    if (!store || !target) return;
    setSaving(true);
    const outcome = await store.link(
      {
        type: "edge",
        relation,
        subject: { entityId: detail.entity.entityId, revisionId: detail.revision.revisionId },
        object: { entityId: target.ref.entityId, revisionId: target.ref.revisionId },
      },
      detail.entity.currentRevisionId,
    );
    setSaving(false);
    if (!outcome.ok) {
      actions.toast("error", outcome.failure.message);
      return;
    }
    actions.toast("info", `${detail.entity.key} ${RELATION_SENTENCE[relation]} ${target.key}`);
    onOpenChange(false);
    setTargetId(undefined);
    setQuery("");
    onLinked();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Link something to {detail.entity.key}</DialogTitle>
        <DialogDescription>
          Links are optional in every direction. This one records that {detail.entity.key} {RELATION_SENTENCE[relation]} another artifact, at the
          revisions you are looking at.
        </DialogDescription>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Relation</span>
            <div role="radiogroup" aria-label="Relation" className="flex flex-wrap gap-1">
              {PROJECT_WORK_EDGE_RELATIONS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={relation === candidate}
                  onClick={() => setRelation(candidate)}
                  className={cn(
                    "flex h-7 items-center rounded-full border px-2.5 text-xs leading-xs outline-none",
                    "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                    relation === candidate ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                  )}
                >
                  {candidate}
                </button>
              ))}
            </div>
          </div>

          <label className="relative flex min-w-0 items-center">
            <Search aria-hidden="true" className="pointer-events-none absolute ms-2 size-3.5 text-ink-3" />
            <span className="sr-only">Find something to link by key or title</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find by key or title" className="ps-7 text-sm" />
          </label>

          <ul role="listbox" aria-label="Something to link" className="max-h-64 min-h-0 overflow-y-auto rounded-lg border border-line">
            {candidates.length === 0 ? (
              <li className="p-3 text-sm leading-5 text-ink-3">
                Nothing else in this project matches. A link needs another artifact; there is no harm in having none.
              </li>
            ) : (
              candidates.map((item) => (
                <li key={item.ref.entityId} role="option" aria-selected={item.ref.entityId === targetId}>
                  <button
                    type="button"
                    onClick={() => setTargetId(item.ref.entityId)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-start outline-none",
                      "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      "pointer-coarse:min-h-11",
                      item.ref.entityId === targetId && "bg-surface-2",
                    )}
                  >
                    <TypeBadge kind={item.kind} />
                    <KeyTag workKey={item.key} />
                    <span className="min-w-0 truncate text-sm leading-5 text-ink-2">{item.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!target || saving}>
            <Link2 />
            {saving ? "Linking…" : target ? `Link ${target.key}` : "Link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
