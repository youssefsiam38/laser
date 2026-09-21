/**
 * What review means on screen (M21-T8): gates, comments and their anchors.
 *
 * Pure, like `model.ts` beside it. The host decides every rule — which gate is
 * next, what it needs, whether a decision may be recorded, who may resolve a
 * comment — and this file only decides what those answers are *called* and how
 * they group, so the gate card, the comments panel and the transcript's
 * approval card all say the same words about the same state.
 *
 * Three rules it keeps:
 *
 * - **Never invent a refusal.** A gate that cannot be approved carries the
 *   host's own sentence; this file adds none of its own.
 * - **Never lose a comment.** An anchor whose target is gone is labelled
 *   orphaned and kept, on the thread it belongs to (leap, "Design contract").
 * - **Enter never approves.** The confirmation phrase lives here, so the one
 *   thing a person has to type to approve is the same everywhere.
 */
import {
  commentThreads,
  describeAnchor,
  findAnchorTarget,
  type ApprovalGate,
  type CommentThread,
  type GateReport,
  type GateRole,
  type GateStatusReport,
  type ProjectWorkAnchor,
  type ProjectWorkBody,
  type ProjectWorkComment,
} from "@lasercode/protocol";

/** The gate's name, as a person says it. */
export const GATE_LABEL: Readonly<Record<ApprovalGate, string>> = {
  brief: "Brief",
  design: "Design",
  build: "Build",
};

/** What each gate is actually deciding, in one line. */
export const GATE_PURPOSE: Readonly<Record<ApprovalGate, string>> = {
  brief: "Is this the right thing to build?",
  design: "Is this the experience to build?",
  build: "May this be built, and how much may it do on its own?",
};

/** What each required revision plays at the gate. */
export const GATE_ROLE_LABEL: Readonly<Record<GateRole, string>> = {
  spec_brief: "The brief",
  spec_full: "The full spec",
  design: "The design",
  design_profile: "The design profile",
  design_skip: "No design needed",
  plan: "The plan",
  task_graph: "The task graph",
};

/** The permission mode, in the words the leap uses on the gate card. */
export const MODE_LABEL = {
  autonomous: "Build autonomously",
  manual_tool_review: "Build with manual tool review",
} as const;

export const MODE_DETAIL = {
  autonomous: "The session runs its own tools while it builds this.",
  manual_tool_review: "Every tool the session wants to run is shown to you first.",
} as const;

/** One gate out of the report, by name. */
export function gateOf(report: GateReport | undefined, gate: ApprovalGate): GateStatusReport | undefined {
  return report?.gates.find((candidate) => candidate.gate === gate);
}

/**
 * The gate a person would look at first: the one the host says is next, and
 * the last one when every gate is settled.
 */
export function focusedGate(report: GateReport | undefined): GateStatusReport | undefined {
  if (!report) return undefined;
  const next = report.next ? gateOf(report, report.next) : undefined;
  return next ?? report.gates[report.gates.length - 1];
}

/** Is there a decision for this person to take on this gate right now? */
export function isDecidable(gate: GateStatusReport | undefined): boolean {
  return gate !== undefined && gate.state !== "not_applicable" && gate.subject !== undefined && gate.refusal === undefined;
}

/**
 * What a person types to approve.
 *
 * The key, and nothing cleverer: it is on screen, it is short, and typing it
 * is a deliberate act that a stray Enter cannot perform (D-332).
 */
export function approvalPhrase(gate: GateStatusReport): string {
  return gate.subject?.key ?? "";
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** One thread, with everything the panel needs to draw its pin. */
export interface ReviewThread extends CommentThread {
  /** What the anchor is called: the target's own label, or the anchor's. */
  anchorLabel: string;
  /** The text the anchor points at, when it still resolves and has any. */
  anchorText?: string;
  /** How many comments the thread holds, counting the root. */
  size: number;
}

/** What one anchor is called, against the body the person is reading. */
export function anchorLabel(anchor: ProjectWorkAnchor, body: ProjectWorkBody | undefined): { label: string; text?: string } {
  const found = body ? findAnchorTarget(body, anchor) : undefined;
  if (!found) return { label: describeAnchor(anchor) };
  return { label: found.label, ...(found.text !== undefined ? { text: found.text } : {}) };
}

/**
 * The threads of one entity, newest first, with the open ones above the rest.
 *
 * Order is the point: a person opening the inspector is looking for what is
 * unanswered, and an orphaned thread must not sink out of sight just because
 * the thing it was pinned to is gone.
 */
export function reviewThreads(comments: readonly ProjectWorkComment[], body: ProjectWorkBody | undefined): ReviewThread[] {
  const rank = { open: 0, addressed: 1, resolved: 2 } as const;
  return commentThreads(comments)
    .map((thread) => {
      const anchor = anchorLabel(thread.root.anchor, thread.root.orphaned === true ? undefined : body);
      return {
        ...thread,
        anchorLabel: anchor.label,
        ...(anchor.text !== undefined ? { anchorText: anchor.text } : {}),
        size: 1 + thread.replies.length,
      } satisfies ReviewThread;
    })
    .sort((a, b) => {
      if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      return a.root.createdAt === b.root.createdAt ? a.root.commentId.localeCompare(b.root.commentId) : a.root.createdAt < b.root.createdAt ? -1 : 1;
    });
}

/** The threads a change request would carry: everything not resolved yet. */
export function unresolvedThreads(threads: readonly ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => thread.state !== "resolved");
}

/** One line of the batched request: where it is, and what it asks for. */
export interface BatchedChange {
  commentId: string;
  anchorLabel: string;
  /** The text as it stands now, when the anchor still resolves. */
  before?: string;
  /** What the comment asks for. The person's words, never a rewrite. */
  after: string;
  blocking: boolean;
  orphaned: boolean;
}

/**
 * Several comments, batched into one revision request with a before/after
 * (leap, "Design contract").
 *
 * The "after" is the comment itself: Laser does not write the change, it asks
 * for it. What this adds is the *set* — one request naming every place, in the
 * order the panel shows them, so the answer is one revision rather than five.
 */
export function batchedChanges(threads: readonly ReviewThread[]): BatchedChange[] {
  return unresolvedThreads(threads).map((thread) => ({
    commentId: thread.root.commentId,
    anchorLabel: thread.anchorLabel,
    ...(thread.anchorText !== undefined ? { before: thread.anchorText } : {}),
    after: [thread.root.text, ...thread.replies.map((reply) => reply.text)].join("\n"),
    blocking: thread.blocking,
    orphaned: thread.orphaned,
  }));
}

/** The note a batched change request sends, written for the person reading it. */
export function batchedNote(changes: readonly BatchedChange[]): string {
  return changes
    .map((change) => (change.before === undefined ? `${change.anchorLabel}: ${change.after}` : `${change.anchorLabel}\n  now: ${change.before}\n  asked: ${change.after}`))
    .join("\n");
}

/** How the panel says what a thread is waiting for. */
export function threadStateLabel(thread: ReviewThread): string {
  if (thread.state === "resolved") return "Resolved";
  if (thread.state === "addressed") return thread.blocking ? "Addressed · still blocking until you resolve it" : "Addressed";
  return thread.blocking ? "Blocking" : "Open";
}
