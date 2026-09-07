import type { Block } from "../store.js";
import { goalPromptId, toolOutputText } from "@lasercode/protocol";
export { goalPromptId } from "@lasercode/protocol";

export interface GoalMoment {
  at: number;
  status: string;
  objective: string;
  reason?: string;
}

/** Presentation-only history. No goal loop, budget or usage accounting lives here. */
export interface GoalRecord {
  id: string;
  ids: string[];
  objective: string;
  status: string;
  startedAt: number;
  continuations: number;
  moments: GoalMoment[];
  summary?: string;
  completionToolId?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function goalRecords(entries: readonly unknown[], blocks: readonly Block[]): GoalRecord[] {
  const out: GoalRecord[] = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (entry.type !== "custom" || entry.customType !== "goal-state") continue;
    const data = record(entry.data);
    const last = out.at(-1);
    if (data.goal === null) {
      if (last && !["complete", "cleared", "replaced"].includes(last.status)) {
        const time = Date.parse(String(entry.timestamp ?? ""));
        last.status = "cleared";
        last.moments.push({ at: Number.isFinite(time) ? time : last.moments.at(-1)!.at, status: "cleared", objective: last.objective });
      }
      continue;
    }
    const goal = record(data.goal);
    if (typeof goal.id !== "string" || typeof goal.text !== "string" || typeof goal.startedAt !== "number" || typeof goal.updatedAt !== "number" || typeof goal.status !== "string") continue;
    // Upstream renews the stale-turn guard ID on edit/resume; startedAt stays
    // fixed. A new objective after clearing/completing is a different record.
    let item = last && last.startedAt === goal.startedAt && !["cleared", "replaced"].includes(last.status) ? last : undefined;
    if (!item) {
      if (last && !["complete", "cleared", "replaced"].includes(last.status)) last.status = "replaced";
      item = { id: goal.id, ids: [], objective: goal.text, status: goal.status, startedAt: goal.startedAt, continuations: 0, moments: [] };
      out.push(item);
    }
    if (!item.ids.includes(goal.id)) item.ids.push(goal.id);
    const waiting = record(goal.waiting);
    const status = goal.status === "budget_limited" ? "paused" : waiting.reason ? "waiting" : goal.status;
    const reason = typeof waiting.reason === "string" ? waiting.reason
      : goal.safetyPauseCause === "continuation_limit" ? "Automatic response limit reached. Resume when you are ready."
      : goal.safetyPauseCause === "no_progress" ? "Paused after repeated automatic runs without progress." : undefined;
    const previous = item.moments.at(-1);
    if (!previous || previous.status !== status || previous.objective !== goal.text || previous.reason !== reason) {
      item.moments.push({ at: goal.updatedAt, status, objective: goal.text, ...(reason ? { reason } : {}) });
    }
    item.objective = goal.text;
    item.status = status;
    item.continuations = typeof goal.iteration === "number" ? goal.iteration : 0;
  }
  for (const block of blocks) {
    if (block.kind !== "tool" || block.name !== "goal_complete" || !block.done || block.isError) continue;
    const args = record(block.args);
    const item = out.find(goal => goal.status === "complete" && goal.ids.includes(String(args.goal_id)));
    // A rejected/stale completion must remain an ordinary inspectable tool.
    const result = toolOutputText(block.result);
    if (!item || !result?.startsWith("Goal complete:") || typeof args.summary !== "string") continue;
    item.summary = args.summary;
    item.completionToolId = block.id;
  }
  return out;
}

export function goalForPrompt(text: string, goals: readonly GoalRecord[]): GoalRecord | undefined {
  const id = goalPromptId(text);
  return id ? goals.find(goal => goal.ids.includes(id)) : undefined;
}
