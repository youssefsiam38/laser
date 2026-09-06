export interface TextMatch { start: number; end: number }

/** Literal, case-insensitive search. Escapes and regex metacharacters are data. */
export function textMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(escaped, "giu"))].map(m => ({ start: m.index, end: m.index + m[0].length }));
}

export function matchExcerpt(text: string, match: TextMatch) {
  const start = Math.max(0, match.start - 55);
  const end = Math.min(text.length, match.end + 90);
  return { before: `${start ? "…" : ""}${text.slice(start, match.start)}`, match: text.slice(match.start, match.end), after: `${text.slice(match.end, end)}${end < text.length ? "…" : ""}` };
}

/** Explicit textual channels; never index images or arbitrary provider metadata. */
export function partSearchText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string" ? part.text : "";
  if (part.type !== "tool-call") return "";
  const result = part.result ?? (part.artifact as { partialOutput?: unknown } | undefined)?.partialOutput;
  return `${part.toolName ?? ""}\n${JSON.stringify(part.args ?? {})}\n${typeof result === "string" ? result : JSON.stringify(result ?? "")}`;
}
