"use client";
/**
 * Review: the pins as a list, and the before/after of two revisions
 * (M21-T13).
 *
 * Comments are written and answered in the workspace inspector (M21-T8); what
 * belongs *here* is the design's own view of them — where each one is pinned,
 * which ones lost their node, and what actually changed between the revision
 * being read and any earlier one. Reading the earlier revision is this
 * panel's own state: it asks the store for it, says so while it is reading,
 * and says what went wrong when it cannot.
 */
import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ClientRequests, DesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { selectClass } from "@/components/settings/fields";
import { cn } from "@/lib/utils";
import { designDiff, diffSummary, type DesignPin } from "@/design/review";

import type { WorkBodyContext } from "../project-work/bodies/context.js";

export interface ReviewPanelProps {
  body: DesignBody;
  context: WorkBodyContext;
  pins: readonly DesignPin[];
  /** What the last `Ground it` could not map, while this window holds it. */
  grounded: ClientRequests["design/sketch/ground"]["result"] | undefined;
  onSelectNode: (nodeId: string) => void;
}

export function ReviewPanel({ body, context, pins, grounded, onSelectNode }: ReviewPanelProps) {
  const history = context.detail.history ?? [];
  const earlier = history.filter((revision) => revision.revisionId !== context.detail.revision.revisionId);
  const [againstId, setAgainstId] = useState<string | undefined>(() => earlier[0]?.revisionId);
  const [against, setAgainst] = useState<{ revisionId: string; body: DesignBody } | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const store = context.store;

  useEffect(() => {
    if (!store || againstId === undefined) return;
    let cancelled = false;
    setReading(true);
    setError(undefined);
    void store.get({ entityId: context.detail.entity.entityId, revisionId: againstId, body: { mode: "full" } }).then((outcome) => {
      if (cancelled) return;
      setReading(false);
      if (!outcome.ok) {
        setError(outcome.failure.message);
        return;
      }
      const read = outcome.value.body?.body;
      if (read?.kind !== "design") {
        setError("That revision's content is no longer stored on this machine, so it cannot be compared.");
        return;
      }
      setAgainst({ revisionId: againstId, body: read.design });
    });
    return () => {
      cancelled = true;
    };
  }, [againstId, context.detail.entity.entityId, store]);

  const diff = useMemo(() => (against ? designDiff(against.body, body) : undefined), [against, body]);
  const orphaned = pins.filter((pin) => pin.orphaned);

  return (
    <div data-slot="design-review" className="flex min-w-0 flex-col gap-5">
      <section aria-label="Pinned comments" className="flex min-w-0 flex-col gap-2">
        <h3 className="eyebrow">Pinned comments</h3>
        {pins.length === 0 ? (
          <p role="status" className="rounded-lg border border-dashed border-line p-3 text-xs leading-xs text-ink-2">
            Nothing is pinned on this design yet. Comment on a node or a screen from the inspector and the pin appears on the canvas, numbered, where it belongs.
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1.5">
            {pins.map((pin) => (
              <li
                key={pin.commentId}
                data-slot="design-pin"
                data-orphaned={pin.orphaned ? "true" : undefined}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-2"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge variant={pin.orphaned ? "attention" : pin.blocking ? "danger" : "outline"}>{pin.number}</Badge>
                  <span className="text-xs leading-xs text-ink-3">{pin.author}</span>
                  {pin.blocking ? <Badge variant="danger">blocking</Badge> : null}
                  {pin.resolved ? <Badge variant="ok">resolved</Badge> : null}
                  {pin.orphaned ? <Badge variant="attention">anchor gone</Badge> : null}
                  {!pin.orphaned && pin.nodeId ? (
                    <Button size="xs" variant="ghost" className="ms-auto" onClick={() => onSelectNode(pin.nodeId ?? "")}>
                      <MessageSquare />
                      Show it
                    </Button>
                  ) : null}
                </span>
                <p className="text-xs leading-xs text-ink-2">{pin.text}</p>
                {pin.orphaned ? (
                  <p className="text-xs leading-xs text-ink-3">
                    The node this was written on is not in this revision. The comment is kept exactly as it was written, and nothing was re-pinned for you.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {orphaned.length > 0 ? (
          <p role="status" className="text-xs leading-xs text-ink-3">
            {orphaned.length === 1 ? "One comment lost" : `${String(orphaned.length)} comments lost`} the node it was pinned to when this design changed.
          </p>
        ) : null}
      </section>

      {grounded ? (
        <section aria-label="What grounding could not map" className="flex min-w-0 flex-col gap-2">
          <h3 className="eyebrow">From the sketch</h3>
          <p className="text-xs leading-xs text-ink-2">
            {grounded.unmapped.length === 0
              ? "Everything in that sketch mapped onto this project's index."
              : `${String(grounded.unmapped.length)} part${grounded.unmapped.length === 1 ? "" : "s"} of that sketch had nothing in the index to draw ${grounded.unmapped.length === 1 ? "it" : "them"} with, so ${grounded.unmapped.length === 1 ? "it is" : "they are"} proposed:`}
          </p>
          <ul role="list" className="flex flex-col gap-1">
            {grounded.unmapped.slice(0, 20).map((part) => (
              <li key={`${part.what}:${part.why}`} className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs leading-xs text-ink-2">
                <Badge variant="live">{part.what}</Badge>
                <span className="min-w-0">{part.why}</span>
                {part.primitive ? <span className="typed text-ink-3">drawn as {part.primitive}</span> : null}
              </li>
            ))}
          </ul>
          {grounded.notes.map((note) => (
            <p key={note} role="status" className="text-xs leading-xs text-ink-3">
              {note}
            </p>
          ))}
        </section>
      ) : null}

      <section aria-label="Before and after" className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="eyebrow">Before and after</h3>
          {earlier.length > 0 ? (
            <select
              aria-label="Compare with"
              className={cn(selectClass, "h-7 w-auto py-0 text-xs")}
              value={againstId ?? ""}
              onChange={(event) => setAgainstId(event.target.value === "" ? undefined : event.target.value)}
            >
              <option value="">Pick a revision</option>
              {earlier.map((revision) => (
                <option key={revision.revisionId} value={revision.revisionId}>
                  Revision {revision.index}
                  {revision.note ? ` · ${revision.note}` : ""}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {earlier.length === 0 ? (
          <p role="status" className="text-xs leading-xs text-ink-2">
            This is the first revision of this design, so there is nothing to compare it with yet.
          </p>
        ) : reading ? (
          <p role="status" className="text-xs leading-xs text-ink-3">
            Reading that revision…
          </p>
        ) : error ? (
          <p role="alert" className="text-xs leading-xs text-danger">
            {error}
          </p>
        ) : diff ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs leading-xs text-ink-2">{diffSummary(diff)}</p>
            <ul role="list" className="flex flex-col gap-1">
              {diff.screens.map((change) => (
                <li key={`${change.kind}:${change.screenId}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-2">
                  <Badge variant={change.kind === "added" ? "ok" : "danger"}>screen {change.kind}</Badge>
                  <span className="min-w-0 truncate">{change.screenName}</span>
                </li>
              ))}
              {diff.nodes.slice(0, 60).map((change) => (
                <li
                  key={`${change.kind}:${change.screenId}:${change.nodeId}`}
                  data-slot="design-diff-row"
                  className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface px-2 py-1.5"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs">
                    <Badge variant={change.kind === "added" ? "ok" : change.kind === "removed" ? "danger" : "live"}>{change.kind}</Badge>
                    <span className="typed min-w-0 truncate text-ink-3">{change.nodeId}</span>
                    <span className="text-ink-3">in {change.screenName}</span>
                    {change.fields ? <span className="text-ink-3">· {change.fields.join(", ")}</span> : null}
                  </span>
                  {change.before ? (
                    <span className="min-w-0 truncate text-xs leading-xs text-ink-3">
                      before: {change.before}
                    </span>
                  ) : null}
                  {change.after ? (
                    <span className="min-w-0 truncate text-xs leading-xs text-ink-2">
                      after: {change.after}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p role="status" className="text-xs leading-xs text-ink-2">
            Pick a revision to compare this one with, node by node.
          </p>
        )}
      </section>
    </div>
  );
}
