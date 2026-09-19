/**
 * What one fleet row says, derived from the record (source-control leap §3).
 * Line 2 is the work's own words — never the task brief. Line 3 is the
 * developer strip. Pure: no React.
 */
import type { AgentRun, BackgroundTask } from "@lasercode/protocol";

import { clockTime, formatBytes, hue } from "../format.js";
import { agentInitials, firstSentence, isPathShaped, shortModelName } from "./truncate.js";

export const FLEET_AGENT_TINT_COUNT = 8;

export type FleetHeadlineKind = "question" | "activity" | "output" | "reason" | "result";

export interface FleetHeadline {
  kind: FleetHeadlineKind;
  /** Present for `Running <tool>`; never truncated in the paint. */
  verb: string | undefined;
  /** The rest of the line. Paths middle-truncate; everything else CSS-truncates. */
  text: string;
  restIsPath: boolean;
}

export type FleetWorktreeChip =
  | { kind: "branch"; branch: string; reason?: string }
  | { kind: "shared"; reason?: string };

export interface FleetAgentStrip {
  kind: "agent";
  agentName: string;
  model: string | undefined;
  turns: number | undefined;
  worktree: FleetWorktreeChip;
}

export interface FleetTaskStrip {
  kind: "task";
  command: string;
  bytes: number | undefined;
  clock: string | undefined;
}

export type FleetStrip = FleetAgentStrip | FleetTaskStrip;

export function headlineText(headline: FleetHeadline): string {
  return headline.verb ? `${headline.verb} ${headline.text}` : headline.text;
}

export function worktreeLabel(chip: FleetWorktreeChip): string {
  return chip.kind === "branch" ? chip.branch : "shared checkout";
}

export function stripText(strip: FleetStrip): string {
  if (strip.kind === "agent") {
    const parts: string[] = [strip.agentName];
    if (strip.model) parts.push(strip.model);
    if (strip.turns !== undefined) parts.push(`${strip.turns}t`);
    parts.push(worktreeLabel(strip.worktree));
    return parts.join(" · ");
  }
  const byteLabel = strip.bytes === undefined ? undefined : formatBytes(strip.bytes);
  return [strip.command, byteLabel, strip.clock].filter((part): part is string => Boolean(part)).join(" · ");
}

export function agentTintIndex(agentName: string): number {
  return hue(agentName) % FLEET_AGENT_TINT_COUNT;
}

function activityHeadline(label: string | undefined, tool: string | undefined): FleetHeadline | undefined {
  if (label) {
    const running = label.match(/^(Running)\s+(.+)$/i);
    if (running) {
      const rest = running[2]!;
      return { kind: "activity", verb: running[1], text: rest, restIsPath: isPathShaped(rest) };
    }
    return { kind: "activity", verb: undefined, text: label, restIsPath: isPathShaped(label) };
  }
  if (tool) return { kind: "activity", verb: "Running", text: tool, restIsPath: isPathShaped(tool) };
  return undefined;
}

/**
 * Line 2, in priority order. A truncated copy of the task brief is forbidden.
 */
export function agentHeadline(run: AgentRun | undefined, ended: boolean, terminalReason: string | undefined): FleetHeadline | undefined {
  if (!ended && run?.status === "needs_input" && run.question?.title) {
    return { kind: "question", verb: undefined, text: run.question.title, restIsPath: false };
  }
  if (!ended) {
    const live = activityHeadline(run?.activity?.label, run?.activity?.currentTool);
    if (live) return live;
  }
  if (terminalReason) return { kind: "reason", verb: undefined, text: terminalReason, restIsPath: false };
  const result = run?.result?.message;
  if (result) return { kind: "result", verb: undefined, text: firstSentence(result), restIsPath: false };
  return undefined;
}

export function taskHeadline(task: BackgroundTask, terminalReason: string | undefined): FleetHeadline | undefined {
  if (task.status === "running" && task.activity) {
    return { kind: "output", verb: undefined, text: task.activity, restIsPath: isPathShaped(task.activity) };
  }
  if (terminalReason) return { kind: "reason", verb: undefined, text: terminalReason, restIsPath: false };
  return undefined;
}

function isolationReason(run: AgentRun | undefined): string | undefined {
  const reason = run?.isolation?.reason?.trim();
  return reason || undefined;
}

export function agentStrip(run: AgentRun | undefined, agentName: string): FleetAgentStrip {
  const model = run?.model;
  const reason = isolationReason(run);
  const worktree: FleetWorktreeChip = run?.worktree
    ? { kind: "branch", branch: run.worktree.branch, ...(reason ? { reason } : {}) }
    : { kind: "shared", ...(reason ? { reason } : {}) };
  return {
    kind: "agent",
    agentName,
    model: model ? shortModelName(model.id, model.name) : undefined,
    turns: run?.activity?.turns,
    worktree,
  };
}

export function taskStrip(task: BackgroundTask): FleetTaskStrip {
  return {
    kind: "task",
    command: task.command,
    bytes: task.outputBytes,
    clock: clockTime(task.startedAt) || undefined,
  };
}

export { agentInitials };
