import type { HistoryLiveSnapshot, HistoryWindow, HistoryWindowRequest } from "./messages.js";
import { goalPromptId } from "./goal-presentation.js";
import { ErrorCodes } from "./jsonrpc.js";
import { ProtocolError } from "./schemas.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const isMessage = (entry: unknown): boolean => ["message", "custom_message"].includes(String(record(entry).type));
const isUser = (entry: unknown): boolean => record(entry).type === "message" && record(record(entry).message).role === "user";
const changed = (): never => { throw new ProtocolError(ErrorCodes.InvalidParams, "This history changed. Reload the conversation and try again."); };

/** Window opaque entries along their real parent chain; never slice the disk's append order. */
export function historyWindow(
  snapshot: { entries: unknown[]; leafId: string | null },
  request: HistoryWindowRequest,
  scope: { path: string; epoch: string; seq: number; live?: HistoryLiveSnapshot },
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } {
  const byId = new Map(snapshot.entries.map(entry => [record(entry).id, entry]));
  const reversed: unknown[] = [];
  const visited = new Set<string>();
  let id: unknown = snapshot.leafId;
  while (typeof id === "string") {
    if (visited.has(id)) changed();
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) changed();
    reversed.push(entry);
    id = record(entry).parentId;
  }
  const branch = reversed.reverse();
  let end = branch.length;
  let start = 0;
  const all = "all" in request;
  if ("before" in request) {
    let cursor: Record<string, unknown>;
    try { cursor = record(JSON.parse(request.before)); } catch { return changed(); }
    if (cursor.path !== scope.path || cursor.epoch !== scope.epoch || !visited.has(String(cursor.leaf))) changed();
    end = branch.findIndex(entry => record(entry).id === cursor.before);
    if (end < 0) changed();
  }
  if ("from" in request) {
    start = branch.findIndex(entry => record(entry).id === request.from);
    if (start < 0) changed();
  } else if (!all) {
    const limit = "tail" in request ? request.tail : "before" in request ? request.limit ?? 40 : 40;
    let messages = 0;
    start = end;
    while (start > 0 && messages < limit) if (isMessage(branch[--start])) messages++;
    // A tool result cannot be separated from its call, or an assistant action
    // from its prompt. A single unusually long turn may exceed the row target.
    while (start > 0 && !isUser(branch[start])) start--;
    // Attribution and other turn-local custom markers precede the prompt.
    while (start > 0 && !isMessage(branch[start - 1])) start--;
  }
  const entries = all ? snapshot.entries : branch.slice(start, end);
  const prefix = all ? [] : branch.slice(0, start);
  const anchor = record(entries[0]).id;
  const context = prefix.filter(entry => record(entry).type === "custom" && record(entry).customType === "goal-state");
  const priorGoalIds = new Set<string>();
  for (const entry of prefix) {
    if (!isUser(entry)) continue;
    const content = record(record(entry).message).content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => record(part).type === "text" ? String(record(part).text ?? "") : "").join("\n") : "";
    const goal = goalPromptId(text);
    if (goal) priorGoalIds.add(goal);
  }
  return {
    entries,
    leafId: snapshot.leafId,
    window: {
      epoch: scope.epoch,
      seq: scope.seq,
      ...(start > 0 && typeof anchor === "string" ? { before: JSON.stringify({ path: scope.path, epoch: scope.epoch, leaf: snapshot.leafId, before: anchor }) } : {}),
      ...(typeof anchor === "string" ? { anchor } : {}),
      userOffset: prefix.filter(isUser).length,
      complete: all || (start === 0 && end === branch.length && branch.length === snapshot.entries.length),
      hasHistory: snapshot.entries.some(entry => isMessage(entry) || (record(entry).type === "custom" && record(entry).customType === "goal-state")),
      context,
      priorGoalIds: [...priorGoalIds],
      ...(scope.live ? { live: scope.live } : {}),
    },
  };
}
