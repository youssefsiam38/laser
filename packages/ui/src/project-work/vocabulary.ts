/**
 * What each kind and each state is *called*, and what it looks like.
 *
 * Two identities, kept apart on purpose (D-355, "Keys and type identity"):
 *
 * - the **type badge** — one colour token and one SVG icon per kind, the same
 *   wherever the entity appears;
 * - the **status chip** — separate, and speaking each kind's own vocabulary,
 *   drawn in the app's existing status tones. No new status colour exists and
 *   none is introduced here.
 *
 * The class names are written out rather than built, because Tailwind reads
 * source text and a composed class name is a class that does not ship.
 */
import {
  type ProjectTaskState,
  type ProjectWorkAttentionReason,
  type ProjectWorkKind,
  type ProjectWorkState,
} from "@lasercode/protocol";
import { ClipboardCheck, Compass, FileText, ListTree, PenTool, type LucideIcon } from "lucide-react";

export const KIND_LABEL: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "Spec",
  research: "Research",
  design: "Design",
  plan: "Plan",
  task: "Task",
};

export const KIND_PLURAL: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "Specs",
  research: "Research",
  design: "Designs",
  plan: "Plans",
  task: "Tasks",
};

/** One SVG per kind, through the icon set. Never an emoji: an emoji cannot theme. */
export const KIND_ICON: Readonly<Record<ProjectWorkKind, LucideIcon>> = {
  spec: FileText,
  research: Compass,
  design: PenTool,
  plan: ListTree,
  task: ClipboardCheck,
};

/** The kind's colour as a text/icon class. Editable in Settings like any token. */
export const KIND_TEXT: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "text-kind-spec",
  research: "text-kind-research",
  design: "text-kind-design",
  plan: "text-kind-plan",
  task: "text-kind-task",
};

/** The same colour as a rule down the start edge of a card or a column. */
export const KIND_RULE: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "bg-kind-spec",
  research: "bg-kind-research",
  design: "bg-kind-design",
  plan: "bg-kind-plan",
  task: "bg-kind-task",
};

/** What `/spec`, `/research`, `/design` and `/plan` call their one field. */
export const KIND_FIELD: Readonly<Record<ProjectWorkKind, { label: string; placeholder: string }>> = {
  spec: { label: "Brief", placeholder: "What is this, in a few sentences?" },
  research: { label: "Question", placeholder: "What do you need to find out?" },
  design: { label: "Brief", placeholder: "What is being designed, and why?" },
  plan: { label: "Brief", placeholder: "What is being built? The text here is the plan's own brief." },
  task: { label: "Outcome", placeholder: "What is done when this task is done?" },
};

export type StatusTone = "live" | "attention" | "ok" | "danger" | "muted";

/** The Task vocabulary of D-355: `todo · ready · running · blocked · needs_review · done`. */
const TASK_LABEL: Readonly<Record<ProjectTaskState, string>> = {
  draft: "To do",
  ready: "Ready",
  blocked: "Blocked",
  in_progress: "Running",
  needs_review: "Needs review",
  done: "Done",
  cancelled: "Cancelled",
};

const ARTIFACT_LABEL: Readonly<Record<string, string>> = {
  draft: "Draft",
  needs_review: "Awaiting review",
  approved: "Approved",
  stale: "Stale",
  superseded: "Superseded",
  archived: "Archived",
};

/**
 * What this state is called *for this kind*.
 *
 * A Spec waits for an approval, a Design waits for the design gate, and a Task
 * has no gate at all — so the same wire value reads differently, and only the
 * differences a person would say out loud are spelled differently here.
 */
export function stateLabel(kind: ProjectWorkKind, state: ProjectWorkState): string {
  if (kind === "task") return TASK_LABEL[state as ProjectTaskState] ?? state;
  if (state === "needs_review") {
    if (kind === "spec") return "Awaiting approval";
    if (kind === "design") return "Awaiting design approval";
    if (kind === "research") return "Awaiting review";
    if (kind === "plan") return "Awaiting approval";
  }
  return ARTIFACT_LABEL[state] ?? state;
}

/** The app's existing status tones. No new colour is introduced for a state. */
export function stateTone(state: ProjectWorkState): StatusTone {
  switch (state) {
    case "in_progress":
      return "live";
    case "needs_review":
    case "blocked":
    case "stale":
      return "attention";
    case "approved":
    case "done":
      return "ok";
    default:
      return "muted";
  }
}

/** Why something is in the "needs you" queue, in words. */
export const ATTENTION_REASON: Readonly<Record<ProjectWorkAttentionReason, { label: string; detail: string }>> = {
  gate: { label: "Waiting for your review", detail: "It has been put up for review and nothing moves until you answer." },
  blocking_comment: { label: "Blocking comments", detail: "Comments marked blocking have to be resolved before this can be approved." },
  handed_to_person: { label: "Handed to you", detail: "The agent could not settle this and handed it over." },
  blocked_task: { label: "Blocked", detail: "Something this task depends on is not done." },
  index_review: { label: "Index entries to review", detail: "The design index found entries nobody has accepted yet." },
  stale: { label: "An input changed", detail: "Something it was built from moved, so it needs reconciling." },
};

/**
 * Which of the app's five status marks a Task state draws.
 *
 * No new mark is invented: `working` sweeps, `waiting_for_input` pulses warm,
 * `finished_unread` is the quiet outline, `idle` is quiet. The accessible name
 * is always this kind's own word, not the mark's.
 */
export function taskMark(state: ProjectTaskState): "working" | "waiting_for_input" | "finished_unread" | "idle" {
  if (state === "in_progress") return "working";
  if (state === "needs_review" || state === "blocked") return "waiting_for_input";
  if (state === "done") return "finished_unread";
  return "idle";
}

/** The board's columns: the Task states, in the order work moves through them. */
export const BOARD_COLUMNS: readonly ProjectTaskState[] = ["draft", "ready", "blocked", "in_progress", "needs_review", "done"];

/** `cancelled` is a column only when it holds something, or while dragging. */
export const BOARD_EXTRA_COLUMN: ProjectTaskState = "cancelled";

export function boardColumnLabel(state: ProjectTaskState): string {
  return TASK_LABEL[state];
}

/** The action that asks for a state, for a drop on the board. */
export const STATE_ACTION = {
  draft: "return_to_draft",
  ready: "mark_ready",
  blocked: "block",
  in_progress: "start",
  needs_review: "submit_for_review",
  done: "complete",
  cancelled: "cancel",
} as const satisfies Record<ProjectTaskState, string>;
