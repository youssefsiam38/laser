/**
 * What `inspect_agent` reads out of a child's own transcript: its last few
 * assistant messages, excerpted. Pure over session entries, so the harness can
 * feed it from a live driver (`entries()`) or from the session file of a child
 * whose driver has gone — both are the same JSON lines.
 *
 * Reads JSON only. Nothing here imports the engine (AGENTS.md invariant 1).
 */
import { readFile } from "node:fs/promises";
import { AGENT_INSPECT_MESSAGE_EXCERPT } from "@lasercode/protocol";
import type { InspectedMessage } from "./bridge.js";

interface SessionEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * The last `count` assistant messages on the live branch, oldest first. A
 * session file is a tree; the conversation is the chain from `leafId` up to
 * the root, so a branch the person navigated away from is not read as if it
 * were still the conversation. A `null` leaf (reset to before the first
 * entry) has no conversation at all.
 */
export function assistantMessagesOf(entries: readonly unknown[], leafId: string | null, count: number, excerptLength = AGENT_INSPECT_MESSAGE_EXCERPT): InspectedMessage[] {
  if (count <= 0 || leafId === null) return [];
  const byId = new Map<string, SessionEntry>();
  for (const raw of entries) {
    const entry = raw as SessionEntry | null;
    if (entry && typeof entry === "object" && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const found: InspectedMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null && !seen.has(cursor) && found.length < count) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const text = textOf(entry.message.content);
      if (text !== undefined) {
        found.push({ ...(typeof entry.timestamp === "string" ? { at: entry.timestamp } : {}), text: excerpt(text, excerptLength) });
      }
    }
    cursor = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  return found.reverse();
}

/**
 * A session file, as the engine would replay it: every line that parses, and
 * the last one as the leaf (the engine rebuilds its leaf the same way). A file
 * that is missing or half-written yields what could be read, never a throw.
 */
export async function readSessionEntries(path: string): Promise<{ entries: unknown[]; leafId: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { entries: [], leafId: null };
  }
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line still being written, or damage; the rest of the file is still the conversation.
    }
  }
  const last = [...entries].reverse().find((entry) => entry && typeof entry === "object" && typeof (entry as SessionEntry).id === "string") as SessionEntry | undefined;
  return { entries, leafId: typeof last?.id === "string" ? last.id : null };
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() === "" ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
