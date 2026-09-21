"use client";
/**
 * The kind-aware inspector (D-355, "Detail, by kind").
 *
 * What is *around* an entity rather than inside it: the gate and why it can or
 * cannot be passed, the links it has (all optional, always), its comments,
 * its evidence, and its revision history. Everything here is the current
 * state, read from the host.
 *
 * The gate card and the comments panel are M21-T8's own files beside this one;
 * the Design Index panel replaces this column for a Design in M21-T13.
 * **Linking is here** (M21-T7): adding and removing a link is this section's
 * own act, and both are optional in every direction — nothing is pending
 * because a link is missing (D-352).
 */
import { Link2, Plus, FlaskConical, Unlink } from "lucide-react";
import type { ClientRequests } from "@lasercode/protocol";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCapability, useLaserStable } from "@/runtime";
import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline";
import { clockTime, dateTime, relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { selectWork, useWorkspaceUi, type ProjectWorkSnapshot, type ProjectWorkStore } from "@/project-work";

import { CommentsPanel } from "./CommentsPanel.js";
import { GateCard } from "./GateCard.js";
import { KeyTag } from "./KindBadge.js";
import { LinkDialog, RELATION_SENTENCE } from "./LinkDialog.js";
import { Section } from "./bodies/fields.js";

type Detail = ClientRequests["project/work/get"]["result"];

export function Inspector({
  store,
  work,
  className,
}: {
  store: ProjectWorkStore | undefined;
  work: ProjectWorkSnapshot;
  className?: string;
}) {
  const ui = useWorkspaceUi();
  const { actions } = useLaserStable();
  const [detail, setDetail] = useState<Detail | undefined>(undefined);
  const [linking, setLinking] = useState(false);
  const canLink = useCapability("project/work/link", { presentation: "explained" });
  const entityId = ui.selection?.entityId;
  const revisionId = ui.selection?.revisionId;

  const read = useCallback(async () => {
    if (!store || !entityId) {
      setDetail(undefined);
      return;
    }
    const outcome = await store.get({
      entityId,
      ...(revisionId ? { revisionId } : {}),
      // The body comes with it: an anchor is named against the revision the
      // person is reading, and an anchor with no body to check is a pin with
      // no target (M21-T8).
      body: { mode: "full" },
      include: { comments: true, approvals: true, evidence: true, links: true, history: true },
    });
    setDetail(outcome.ok ? outcome.value : undefined);
  }, [entityId, revisionId, store]);

  useEffect(() => {
    void read();
  }, [read, work.seq]);

  if (!detail) {
    return (
      <aside className={cn("flex min-h-0 flex-col gap-3 overflow-y-auto p-3", className)}>
        <p className="text-sm leading-5 text-ink-3">Open something to see its gate, links, comments and history.</p>
      </aside>
    );
  }

  const { entity, revision } = detail;
  const edges = detail.edges;

  const history: TimelineEvent[] = (detail.history ?? []).map((candidate, index) => ({
    id: candidate.revisionId,
    when: index === 0 ? "now" : "past",
    time: clockTime(candidate.createdAt),
    title: `Revision ${candidate.index}${candidate.revisionId === entity.currentRevisionId ? " · current" : ""}`,
    detail: `${candidate.origin.actor.label}${candidate.note ? ` · ${candidate.note}` : ""}`,
  }));

  return (
    <aside data-slot="work-inspector" className={cn("flex min-h-0 flex-col gap-5 overflow-y-auto p-3", className)}>
      <SpecSheet
        title="This item"
        bare
        rows={[
          { label: "Kind", value: entity.kind },
          { label: "Key", value: entity.key, typed: true },
          { label: "State", value: entity.state },
          { label: "Revisions", value: String(entity.revisionCount), typed: true },
          { label: "Created", value: dateTime(entity.createdAt) },
          { label: "Updated", value: relativeTime(entity.updatedAt) },
          { label: "Digest", value: revision.digest.slice(0, 12), typed: true },
        ]}
      />

      {entity.kind !== "task" ? <GateCard store={store} detail={detail} onChanged={() => void read()} /> : null}

      <Section title="Links">
        {edges.length === 0 && detail.repositoryLinks.length === 0 && detail.executionLinks.length === 0 ? (
          <p className="text-sm leading-5 text-ink-3">
            Nothing is linked, and nothing has to be. Links are optional in every direction.
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1.5">
            {edges.map((edge) => {
              // The edge carries both ends' kind and key, so the other end is
              // named even when this window has not read its row.
              const other = edge.subject.entityId === entity.entityId ? edge.object : edge.subject;
              const known = work.items.some((item) => item.ref.entityId === other.entityId);
              return (
                <li key={edge.linkId} className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => selectWork({ entityId: other.entityId, kind: other.kind })}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start outline-none",
                      "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                      "disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:min-h-11",
                    )}
                  >
                    <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                    <Badge variant="outline">{edge.relation}</Badge>
                    <KeyTag workKey={other.key} />
                    <span className="min-w-0 truncate text-sm leading-5 text-ink-2">
                      {work.items.find((item) => item.ref.entityId === other.entityId)?.title ?? (known ? "" : "archived or filtered out")}
                    </span>
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={canLink.state !== "available"}
                    aria-label={`Unlink ${other.key} (${RELATION_SENTENCE[edge.relation]} it)`}
                    onClick={() => {
                      if (!store) return;
                      void store
                        .unlink({ entityId: entity.entityId, expectedRevisionId: entity.currentRevisionId }, edge.linkId)
                        .then((outcome) => {
                          if (outcome.ok) {
                            actions.toast("info", `${entity.key} and ${other.key} are no longer linked`);
                            void read();
                          } else {
                            actions.toast("error", outcome.failure.message);
                          }
                        });
                    }}
                  >
                    <Unlink />
                  </Button>
                </li>
              );
            })}
            {detail.repositoryLinks.map((link) => (
              <li key={link.linkId} className="flex min-w-0 items-center gap-2 px-1.5 py-1">
                <Badge variant="outline">{link.relation}</Badge>
                <span className="typed min-w-0 truncate text-ink-3">
                  {"state" in link.target ? link.target.state.commitObjectId.slice(0, 10) : link.target.change.head.commitObjectId.slice(0, 10)}
                </span>
              </li>
            ))}
            {detail.executionLinks.map((link) => (
              <li key={link.linkId} className="flex min-w-0 items-center gap-2 px-1.5 py-1">
                <Badge variant="outline">{link.kind}</Badge>
                <span className="typed min-w-0 truncate text-ink-3">{link.targetId}</span>
                {link.outcome ? <span className="text-xs leading-xs text-ink-3">{link.outcome}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button
            size="xs"
            variant="outline"
            data-slot="link-something"
            disabled={canLink.state !== "available"}
            onClick={() => setLinking(true)}
          >
            <Plus />
            Link something…
          </Button>
        </div>
      </Section>

      <CommentsPanel store={store} detail={detail} body={detail.body?.body} onChanged={() => void read()} />

      {detail.evidence.length > 0 ? (
        <Section title="Evidence">
          <ul role="list" className="flex flex-col gap-1.5">
            {detail.evidence.map((evidence) => (
              <li key={evidence.evidenceId} className="flex min-w-0 items-start gap-2">
                <FlaskConical aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={evidence.outcome === "passed" ? "ok" : evidence.outcome === "failed" ? "danger" : "outline"}>
                      {evidence.outcome}
                    </Badge>
                    <Badge variant="outline">{evidence.role}</Badge>
                  </span>
                  <span className="block text-sm leading-5 text-ink-2">{evidence.summary}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {history.length > 0 ? (
        <Section title="History">
          <Timeline events={history} />
        </Section>
      ) : null}

      <LinkDialog store={store} detail={detail} items={work.items} open={linking} onOpenChange={setLinking} onLinked={() => void read()} />
    </aside>
  );
}
