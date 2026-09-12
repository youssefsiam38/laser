import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { goalPromptId, toolSearchContent, toolOutputText, type SearchableTool, type ClientRequests, type SessionSummary } from "@lasercode/protocol";

type Source = "user" | "assistant" | "reasoning" | "tool";
export const sourceRank = (source: Source) => source === "user" ? 0 : source === "assistant" ? 1 : 2;
/** Search only message content, never images, credentials or session metadata. */
export function searchableMessage(entry: unknown, pending?: Map<string, SearchableTool>): Array<{ text: string; source: Source }> {
  const e = entry as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } } | null;
  if (e?.type !== "message") return [];
  const content = e.message?.content;
  if (e.message?.role === "toolResult") {
    const id = e.message.toolCallId ?? "";
    const call = pending?.get(id);
    if (pending && !call) return []; // Hydration does not render orphan results.
    pending?.delete(id);
    // Saved-session hydration displays text content, not the live result envelope.
    return toolSearchContent({ ...call, name: call?.name ?? e.message.toolName ?? "", result: toolOutputText(e.message), isError: e.message.isError }).map(text => ({ text, source: "tool" }));
  }
  const source: Source = e.message?.role === "user" ? "user" : e.message?.role === "assistant" ? "assistant" : "tool";
  if (typeof content === "string") return [{ text: content, source }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p: { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }): Array<{ text: string; source: Source }> => {
    if (p?.type === "text" && typeof p.text === "string") return [{ text: p.text, source }];
    if (p?.type === "thinking" && typeof p.thinking === "string") return [{ text: p.thinking, source: "reasoning" }];
    if (p?.type === "toolCall") {
      const call = { name: p.name ?? "", args: p.arguments };
      // Pair persisted call/result entries before projecting the displayed body
      // (e.g. successful edits hide the confirmation text). Unfinished calls flush
      // at EOF; neither their content nor completed results are counted twice.
      if (pending && p.id) { pending.set(p.id, call); return []; }
      return toolSearchContent(call).map(text => ({ text, source: "tool" }));
    }
    return [];
  });
}

/** Streaming reads keep full-history search off the synchronous catalog path. */
export async function searchSessions(sessions: readonly SessionSummary[], query: string, cursor = 0, signal?: AbortSignal): Promise<ClientRequests["session/search"]["result"]> {
  signal?.throwIfAborted();
  const result: ClientRequests["session/search"]["result"] = { hits: [], unreadable: 0 };
  const needle = query.trim();
  if (!needle) return result;
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (let index = cursor; index < sessions.length; index++) {
    signal?.throwIfAborted();
    const session = sessions[index]!;
    let count = 0;
    let excerpt = "";
    let source: Source = "tool";
    const input = createReadStream(session.path, { encoding: "utf8", ...(signal ? { signal } : {}) });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const pending = new Map<string, SearchableTool>();
    // Match the chat projection: only the first durable goal prompt is visible,
    // as its original objective. Renewed guard IDs on resume share startedAt.
    const goals = new Map<string, { objective: string; startedAt: number }>();
    const shownGoals = new Set<number>();
    const collect = (parts: Array<{ text: string; source: Source }>) => {
      for (const part of parts) {
        const { text } = part;
        for (const match of text.matchAll(expression)) {
          count++;
          if (!excerpt || sourceRank(part.source) < sourceRank(source)) {
            source = part.source;
            const start = Math.max(0, match.index - 60);
            const end = Math.min(text.length, match.index + match[0].length + 100);
            excerpt = `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
          }
        }
      }
    };
    let processed = 0;
    try {
      for await (const line of lines) {
        // readline may have many records buffered. Yield during that drain so
        // a cancellation/permission socket callback can run, not only at EOF.
        if (++processed % 128 === 0) await yieldToIO();
        signal?.throwIfAborted();
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        const e = entry as { type?: string; customType?: string; data?: { goal?: { id?: string; text?: string; startedAt?: number } }; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
        const goal = e?.type === "custom" && e.customType === "goal-state" ? e.data?.goal : undefined;
        if (goal && typeof goal.id === "string" && typeof goal.text === "string" && typeof goal.startedAt === "number") goals.set(goal.id, { objective: goal.text, startedAt: goal.startedAt });
        if (e?.message?.role === "user") {
          const text = typeof e.message.content === "string" ? e.message.content : toolOutputText(e.message) ?? "";
          const id = goalPromptId(text);
          const known = id ? goals.get(id) : undefined;
          if (known) {
            if (!shownGoals.has(known.startedAt)) collect([{ text: known.objective, source: "user" }]);
            shownGoals.add(known.startedAt);
            continue;
          }
        }
        if (e?.message?.role === "toolResult" && !e.message.isError && toolOutputText(e.message)?.startsWith("Goal complete:")) {
          const call = pending.get(e.message.toolCallId ?? "");
          const args = call?.args as { goal_id?: string; summary?: string } | undefined;
          if (call?.name === "goal_complete" && typeof args?.goal_id === "string" && goals.has(args.goal_id) && typeof args.summary === "string") {
            collect([{ text: args.summary, source: "tool" }]);
            pending.delete(e.message.toolCallId ?? "");
            continue;
          }
        }
        collect(searchableMessage(entry, pending));
      }
    } catch (error) {
      signal?.throwIfAborted();
      result.unreadable++;
    } finally { lines.close(); input.destroy(); }
    signal?.throwIfAborted();
    for (const call of pending.values()) collect(toolSearchContent(call).map(text => ({ text, source: "tool" })));
    if (count) {
      result.hits.push({ path: session.path, count, excerpt, source });
    }
    // Bound each response by files as well as hits, so sparse old-history
    // searches return progress instead of monopolizing the connection.
    if ((result.hits.length >= 50 || index - cursor >= 99) && index + 1 < sessions.length) {
      result.nextCursor = index + 1;
      break;
    }
  }
  return result;
}
