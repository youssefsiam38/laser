import { diffViewForTool } from "./tool-diff.js";

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Exact spelling used by JsonViewer, without the surrounding JSON quotes. */
export const jsonSearchString = (value: string): string => JSON.stringify(value).slice(1, -1);

/** Values, never keys. Keep fields separate: a phrase cannot cross two values. */
export function jsonSearchValues(value: unknown): string[] {
  if (typeof value === "string") return [jsonSearchString(value)];
  if (value === null || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(jsonSearchValues);
  return Object.values(record(value)).flatMap(jsonSearchValues);
}

/** ToolFallbackResult displays JSON strings as JSON, other strings as text. */
export function displayedResultValues(value: unknown): string[] {
  if (typeof value !== "string") return jsonSearchValues(value);
  try { return jsonSearchValues(JSON.parse(value)); } catch { return value ? [value] : []; }
}

/** Content envelopes carry hidden details/images as well as visible output. */
export function toolOutputText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const content = record(result)["content"];
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(p => {
    const part = record(p);
    return part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : [];
  }).join("\n");
}

export interface SearchableTool {
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean | undefined;
}
type ToolSearchProjection = (tool: SearchableTool) => string[];

const jsonBody: ToolSearchProjection = ({ args, result }) => [
  ...jsonSearchValues(args), ...displayedResultValues(toolOutputText(result) ?? result),
];
const textBody: ToolSearchProjection = tool => tool.isError
  ? [...jsonSearchValues(tool.args), toolOutputText(tool.result) ?? JSON.stringify(tool.result, null, 2) ?? ""].filter(Boolean)
  : jsonBody(tool);
const terminal: ToolSearchProjection = ({ args, result }) => {
  const command = record(args)["command"];
  const output = toolOutputText(result) ?? "";
  // The terminal header owns the exit status; it is not output prose.
  const text = output.replace(/\n?\n?Command exited with code \d+\s*$/, "").trimEnd();
  return [...(typeof command === "string" ? [command] : []), ...(text ? [text] : [])];
};
const diff: ToolSearchProjection = ({ name, args, result, isError }) => {
  const view = diffViewForTool(name as "edit" | "write", args, record(record(result)["details"]));
  const content = view ? [view.path ?? "", ...view.hunks.flatMap(h => h.lines.map(l => l.text))].filter(Boolean) : jsonSearchValues(args);
  return [...content, ...(isError ? [toolOutputText(result) ?? ""].filter(Boolean) : [])];
};

/**
 * Search is a DISPLAY contract, not a tool-schema crawler. When adding a custom
 * body, add its projection here and mark its rendered values data-search-content.
 * Do not include labels, JSON keys, IDs, hidden parameters, or transport metadata.
 * Unknown tools use the JSON fallback: leaf values stay discoverable, no per-tool
 * allowlist is needed until a specialized renderer hides/transforms fields.
 * See docs/search-content.md for the renderer and regression-test checklist.
 */
export const TOOL_SEARCH_PROJECTIONS: Readonly<Record<string, ToolSearchProjection>> = {
  bash: terminal,
  edit: diff,
  write: diff,
  read: textBody,
  grep: textBody,
  find: textBody,
  ls: textBody,
};

export function toolSearchContent(tool: SearchableTool): string[] {
  return (Object.hasOwn(TOOL_SEARCH_PROJECTIONS, tool.name) ? TOOL_SEARCH_PROJECTIONS[tool.name]! : jsonBody)(tool);
}
