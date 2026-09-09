/**
 * What a map node says, computed once here so the canvas node, the lineage
 * list row and the inspector agree word for word. Pure; no React.
 *
 * Status is the five-word vocabulary through `runStatusLabel` /
 * `runStatusTone` (`packages/ui/src/agents/model.ts`); a session without a
 * run of its own speaks the tree's own `working` / `idle`.
 */
import type { AgentEventKind, AgentRun } from "@lasercode/protocol";
import { ArrowDownLeft, ArrowUpRight, Ban, CircleAlert, CircleCheck, CircleHelp, Hand, OctagonX, Play, type LucideIcon } from "lucide-react";

import { agentDisplayName, runStatusLabel, type AgentStatusTone, type AgentTreeNode, type AgentTreeStatus } from "@/agents";
import type { Status } from "@/components/status";

/** The status word for a node: a run's, or what the session itself is doing. */
export function nodeStatusLabel(status: AgentTreeStatus): string {
  if (status === "idle") return "Idle";
  if (status === "working") return "Working";
  return runStatusLabel(status);
}

/**
 * The dot a tone draws. `ok` has no dot of its own in the five-word set — a
 * finished run is still, in the success colour — so it rides on the idle
 * shape with its colour swapped (`StatusDot` takes `--dot` from `style`).
 */
export function toneStatus(tone: AgentStatusTone): Status {
  switch (tone) {
    case "live":
      return "working";
    case "attention":
      return "waiting_for_input";
    case "danger":
      return "error";
    case "ok":
    case "muted":
      return "idle";
  }
}

export const TONE_VAR: Readonly<Record<AgentStatusTone, string>> = {
  live: "var(--live)",
  attention: "var(--attention)",
  danger: "var(--danger)",
  ok: "var(--ok)",
  muted: "var(--ink-3)",
};

/** The two-letter mark of an agent: `review-auth` → "RA", `reviewer` → "RE". */
export function agentMark(agentName: string): string {
  const parts = agentName.split(/[-_\s]+/).filter(Boolean);
  const mark = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : agentName.slice(0, 2);
  return mark.toUpperCase();
}

/** The line a node is named by: the instance for a child, the session title for the root. */
export function nodeName(node: AgentTreeNode): string {
  return node.depth === 0 ? node.title : (node.subagentName ?? node.title);
}

/** The line under the name: which definition runs it. */
export function nodeAgentLabel(node: AgentTreeNode): string {
  return agentDisplayName(node.agentName);
}

export function nodeIsActive(node: AgentTreeNode): boolean {
  return node.status === "running" || node.status === "queued" || node.status === "working" || node.status === "needs_input";
}

/** Live but paused on a question: active, yet not working (M13-T45). */
export function nodeIsAsking(node: AgentTreeNode): boolean {
  return node.status === "needs_input";
}

/** Milliseconds a node's newest run has been going, or took; `undefined` without a run. */
export function nodeElapsed(node: AgentTreeNode, now: number): number | undefined {
  const run = node.run;
  if (!run) return undefined;
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

/** "2 minutes", "40 seconds", "1 hour 5 minutes": elapsed time in words, for an accessible name. */
export function elapsedWords(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest > 0 ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

/** What the node's run is doing right now, in the run's own words, or nothing. */
export function nodeAction(node: AgentTreeNode): string | undefined {
  const run = node.run;
  if (!run || !nodeIsActive(node)) return undefined;
  // Paused on a question: the question is what it is "doing", and the one
  // thing the person can act on.
  if (run.status === "needs_input" && run.question) return run.question.title;
  const activity = run.activity;
  if (!activity) return undefined;
  return activity.label ?? activity.currentTool;
}

export function runModelLabel(run: AgentRun | undefined): string | undefined {
  return run?.model?.id ?? run?.model?.name ?? undefined;
}

/** "reviewer, review-auth-refresh, working, 2 minutes" — one accessible name per node. */
export function nodeAriaLabel(node: AgentTreeNode, now: number): string {
  const parts = [nodeAgentLabel(node), nodeName(node), nodeStatusLabel(node.status)];
  if (parts[0] === parts[1]) parts.shift();
  const elapsed = nodeElapsed(node, now);
  if (elapsed !== undefined) parts.push(elapsedWords(elapsed));
  return parts.join(", ");
}

export interface EventLook {
  icon: LucideIcon;
  tone: AgentStatusTone;
}

export function eventLook(kind: AgentEventKind): EventLook {
  switch (kind) {
    case "started":
      return { icon: Play, tone: "live" };
    case "message_sent":
      return { icon: ArrowUpRight, tone: "live" };
    case "message_received":
      return { icon: ArrowDownLeft, tone: "live" };
    case "completed":
      return { icon: CircleCheck, tone: "ok" };
    case "needs_input":
      return { icon: CircleHelp, tone: "attention" };
    case "blocked":
      return { icon: Hand, tone: "attention" };
    case "failed":
      return { icon: CircleAlert, tone: "danger" };
    case "cancelled":
      return { icon: Ban, tone: "muted" };
    case "stop_requested":
      return { icon: OctagonX, tone: "attention" };
  }
}

/** Every node's most attention-worthy tone, for a header dot over the whole tree. */
export function aggregateTone(nodes: readonly AgentTreeNode[]): AgentStatusTone {
  const rank: Record<AgentStatusTone, number> = { attention: 0, danger: 1, live: 2, ok: 3, muted: 4 };
  let best: AgentStatusTone = "muted";
  for (const node of nodes) if (rank[node.tone] < rank[best]) best = node.tone;
  return best;
}

/** "3 agents · 2 working" for a header, "No agents yet" for a lone root. */
export function treeSummary(nodes: readonly AgentTreeNode[]): string {
  const agents = nodes.length - 1;
  if (agents <= 0) return "No agents yet";
  const working = nodes.filter((node) => node.depth > 0 && nodeIsActive(node) && !nodeIsAsking(node)).length;
  const needYou = nodes.filter((node) => node.depth > 0 && (node.status === "blocked" || nodeIsAsking(node))).length;
  const parts = [`${agents} agent${agents === 1 ? "" : "s"}`];
  if (working > 0) parts.push(`${working} working`);
  if (needYou > 0) parts.push(`${needYou} need${needYou === 1 ? "s" : ""} you`);
  return parts.join(" · ");
}

/** A clock time for a timeline row. */
export function clockTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Who ended a run, for a person. */
export function endedByLabel(run: AgentRun): string | undefined {
  const by = run.endedBy;
  if (!by) return undefined;
  const who = by.initiator === "user" ? "You ended it" : by.initiator === "parent" ? "Its parent ended it" : "Ended by the harness";
  return by.reason ? `${who}: ${by.reason}` : who;
}
