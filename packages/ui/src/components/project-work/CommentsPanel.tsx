"use client";
/**
 * Comments, in the inspector (M21-T8, D-332, leap "Design contract").
 *
 * A comment is a *thread anchored to a semantic target* — a requirement, an
 * acceptance criterion, a design node, a flow edge, a screen, a phase, a
 * quoted range — and the four things this panel must get right are:
 *
 * 1. **Nothing is lost.** When a revision drops the thing a comment was
 *    pinned to, the comment stays, on its thread, labelled *anchor gone*. It
 *    is never deleted and never silently re-pinned somewhere plausible.
 * 2. **Blocking is a choice, made visibly.** A blocking comment stops the
 *    gate, says so on the thread, and the gate card names it.
 * 3. **The roles are the host's.** An agent may mark a comment addressed;
 *    only the person resolves or reopens it. The controls say which is which,
 *    and the host refuses anything else whatever this panel draws.
 * 4. **Several comments become one revision request**, with a before/after,
 *    rather than five separate asks.
 */
import { MessageSquare, MessageSquarePlus, Reply, Unlink, Send } from "lucide-react";
import { useMemo, useState } from "react";
import type { ClientRequests, ProjectWorkAnchor, ProjectWorkBody } from "@lasercode/protocol";
import { anchorTargets } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { ProjectWorkStore } from "@/project-work";
import { batchedChanges, batchedNote, reviewThreads, threadStateLabel, type ReviewThread } from "@/project-work/review";

import { Section } from "./bodies/fields.js";
import { WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];

/** The anchor a new comment is being written against. */
type Draft = { anchorId: string; text: string; blocking: boolean; parentCommentId?: string };

const WHOLE_ITEM = "entity:";

/** The anchors this body offers, as `<target>:<id>` values the select uses. */
function anchorOptions(body: ProjectWorkBody | undefined): Array<{ value: string; label: string }> {
  if (!body) return [{ value: WHOLE_ITEM, label: "The whole item" }];
  return anchorTargets(body).map((target) => ({
    value: `${target.target}:${target.id}`,
    label: target.text ? `${target.label} — ${target.text.slice(0, 60)}` : target.label,
  }));
}

/** Turn the select's value back into the anchor the host stores. */
function anchorFor(value: string): ProjectWorkAnchor {
  const separator = value.indexOf(":");
  const target = value.slice(0, separator);
  const id = value.slice(separator + 1);
  switch (target) {
    case "section":
      return { target: "section", sectionId: id };
    case "node":
      return { target: "node", nodeId: id };
    case "flow_edge":
      return { target: "flow_edge", edgeId: id };
    case "token":
      return { target: "token", tokenId: id };
    case "region":
      return { target: "region", regionId: id };
    default:
      return { target: "entity" };
  }
}

export function CommentsPanel({
  store,
  detail,
  body,
  onChanged,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  /** The body the person is reading, so an anchor can be named and previewed. */
  body: ProjectWorkBody | undefined;
  onChanged: () => void;
}) {
  const { actions } = useLaserStable();
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const threads = useMemo(() => reviewThreads(detail.comments, body), [body, detail.comments]);
  const options = useMemo(() => anchorOptions(body), [body]);
  const entity = { entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId };
  const unresolved = threads.filter((thread) => thread.state !== "resolved");

  const write = async (input: Draft): Promise<void> => {
    if (!store) return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.comment(entity, {
      revisionId: detail.revision.revisionId,
      anchor: anchorFor(input.anchorId),
      text: input.text.trim(),
      blocking: input.blocking,
      ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    setDraft(undefined);
    onChanged();
  };

  const move = async (commentId: string, resolution: "addressed" | "resolved" | "reopened"): Promise<void> => {
    if (!store) return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.resolveComment(entity, commentId, resolution);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    onChanged();
  };

  const requestRevision = async (): Promise<void> => {
    if (!store) return;
    const changes = batchedChanges(threads);
    if (changes.length === 0) return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.review(entity, "return_to_draft", { note: batchedNote(changes) });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `${changes.length} comment${changes.length === 1 ? "" : "s"} sent as one revision request`);
    onChanged();
  };

  return (
    <Section title="Comments">
      {error ? <WorkRefusal message={error} /> : null}

      {threads.length === 0 ? (
        <p className="text-sm leading-5 text-ink-3">
          No comments on this one. A comment can be pinned to a requirement, a screen, a node or the whole item — and a blocking one holds the gate
          until you resolve it.
        </p>
      ) : (
        <ul role="list" data-slot="comment-threads" className="flex flex-col gap-2">
          {threads.map((thread) => (
            <Thread
              key={thread.root.commentId}
              thread={thread}
              busy={busy}
              onReply={() => setDraft({ anchorId: WHOLE_ITEM, text: "", blocking: false, parentCommentId: thread.root.commentId })}
              onMove={(resolution) => void move(thread.root.commentId, resolution)}
            />
          ))}
        </ul>
      )}

      {draft ? (
        <div data-slot="comment-draft" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
          {draft.parentCommentId ? (
            <p className="text-xs leading-xs text-ink-3">Replying in this thread.</p>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-xs leading-xs text-ink-2">Pin it to</span>
              {/* The anchors this revision actually has: a comment is pinned to
                  a semantic target, never to a coordinate (leap, "Design
                  contract"). */}
              <ul role="listbox" aria-label="What this comment is about" className="max-h-40 min-h-0 overflow-y-auto rounded-lg border border-line">
                {options.map((option) => (
                  <li key={option.value} role="option" aria-selected={option.value === draft.anchorId}>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, anchorId: option.value })}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-start text-sm leading-5 outline-none",
                        "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                        "pointer-coarse:min-h-11",
                        option.value === draft.anchorId ? "bg-surface-2 text-ink" : "text-ink-2",
                      )}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Textarea
            value={draft.text}
            autoFocus
            rows={3}
            aria-label="Your comment"
            placeholder="What needs to change, and why?"
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <label className="flex items-center gap-2 text-sm leading-5 text-ink-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--attention)]"
              checked={draft.blocking}
              onChange={(event) => setDraft({ ...draft, blocking: event.target.checked })}
            />
            Blocking — the gate cannot be approved until this is resolved
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="ghost" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="xs" disabled={busy || draft.text.trim().length === 0 || !store} onClick={() => void write(draft)}>
              <Send />
              Comment
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            data-slot="add-comment"
            disabled={!store}
            onClick={() => setDraft({ anchorId: WHOLE_ITEM, text: "", blocking: false })}
          >
            <MessageSquarePlus />
            Comment…
          </Button>
          {unresolved.length > 1 ? (
            <Button size="xs" variant="outline" data-slot="batch-revision" disabled={busy || !store} onClick={() => void requestRevision()}>
              Ask for one revision for all {unresolved.length}
            </Button>
          ) : null}
        </div>
      )}

      {unresolved.length > 1 ? (
        <details data-slot="batch-preview" className="rounded-lg border border-line bg-surface p-2.5">
          <summary className="cursor-pointer text-xs leading-xs text-ink-2">What that request would say</summary>
          <ul role="list" className="mt-2 flex flex-col gap-2">
            {batchedChanges(threads).map((change) => (
              <li key={change.commentId} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs leading-xs font-medium text-ink">{change.anchorLabel}</span>
                  {change.blocking ? <Badge variant="attention">blocking</Badge> : null}
                  {change.orphaned ? <Badge variant="outline">anchor gone</Badge> : null}
                </span>
                {change.before === undefined ? null : (
                  <span className="text-xs leading-xs text-ink-3">
                    now: <span className="text-ink-2">{change.before}</span>
                  </span>
                )}
                <span className="text-xs leading-xs text-ink-3">
                  asked: <span className="text-ink-2">{change.after}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

function Thread({
  thread,
  busy,
  onReply,
  onMove,
}: {
  thread: ReviewThread;
  busy: boolean;
  onReply: () => void;
  onMove: (resolution: "addressed" | "resolved" | "reopened") => void;
}) {
  const blocking = thread.blocking;
  return (
    <li
      data-slot="comment-thread"
      data-blocking={blocking ? "true" : "false"}
      data-orphaned={thread.orphaned ? "true" : "false"}
      className={cn("flex flex-col gap-1.5 rounded-lg border bg-surface p-2.5", blocking ? "border-attention" : "border-line")}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {thread.orphaned ? (
          <Unlink aria-hidden="true" className="size-3.5 text-attention" />
        ) : (
          <MessageSquare aria-hidden="true" className="size-3.5 text-ink-3" />
        )}
        <span className="text-xs leading-xs font-medium text-ink">{thread.anchorLabel}</span>
        <Badge variant={blocking ? "attention" : thread.state === "resolved" ? "ok" : "outline"}>{threadStateLabel(thread)}</Badge>
        {thread.orphaned ? <Badge variant="outline">anchor gone</Badge> : null}
      </span>

      {thread.orphaned ? (
        <p className="text-xs leading-xs text-ink-2">
          What this was pinned to is not in this revision any more. The comment is kept here so the point is not lost.
        </p>
      ) : thread.anchorText ? (
        <p className="border-s-2 border-line ps-2 text-xs leading-xs text-ink-3">{thread.anchorText}</p>
      ) : null}

      {[thread.root, ...thread.replies].map((comment) => (
        <div key={comment.commentId} className={cn("flex flex-col gap-0.5", comment.commentId !== thread.root.commentId && "ms-3")}>
          <span className="flex flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-3">
            <span className="text-ink-2">{comment.origin.actor.label}</span>
            <span>{relativeTime(comment.createdAt)}</span>
            {comment.origin.actor.kind === "agent" ? <Badge variant="outline">agent</Badge> : null}
          </span>
          <p className="text-sm leading-5 whitespace-pre-wrap text-ink-2">{comment.text}</p>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onReply}>
          <Reply />
          Reply
        </Button>
        {thread.state === "resolved" ? (
          <Button size="xs" variant="outline" data-slot="reopen-comment" disabled={busy} onClick={() => onMove("reopened")}>
            Reopen
          </Button>
        ) : (
          <>
            {thread.state === "open" ? (
              <Button size="xs" variant="outline" data-slot="address-comment" disabled={busy} onClick={() => onMove("addressed")}>
                Mark addressed
              </Button>
            ) : null}
            <Button size="xs" variant="outline" data-slot="resolve-comment" disabled={busy} onClick={() => onMove("resolved")}>
              Resolve
            </Button>
          </>
        )}
      </div>
      {thread.state === "addressed" && blocking ? (
        <p className="text-xs leading-xs text-ink-3">An agent can say it is addressed. Only you can resolve it, and only then does the gate open.</p>
      ) : null}
    </li>
  );
}
