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

// ---------------------------------------------------------------------------
// MCP content (docs/mcp.md "In the transcript")
//
// A server's tools are registered under `<server>_<tool>`, so a direct MCP
// tool has no name that can be enumerated here; what it carries is a result
// envelope whose `details.server` names the server that answered. `details`
// itself is transport metadata and never content, and an image or audio
// block's `data` is a base64 blob that must never enter the index.

/** The one search-and-call tool the adapter registers. */
export const MCP_GATEWAY_TOOL = "mcp";
/** A server-scoped gateway: `mcp__playwright`. */
export const MCP_GATEWAY_NAMESPACE_PREFIX = "mcp__";
/** The scripting tool: `{ code }` plus a call trace. */
export const MCP_SCRIPT_TOOL = "mcpScript";

export const isMcpGatewayTool = (name: string): boolean =>
  name === MCP_GATEWAY_TOOL || name.startsWith(MCP_GATEWAY_NAMESPACE_PREFIX);

/** The server a gateway is scoped to, for `mcp__<server>`. */
export const mcpGatewayNamespace = (name: string): string | undefined =>
  name.startsWith(MCP_GATEWAY_NAMESPACE_PREFIX) && name.length > MCP_GATEWAY_NAMESPACE_PREFIX.length
    ? name.slice(MCP_GATEWAY_NAMESPACE_PREFIX.length)
    : undefined;

/**
 * One block of an MCP result, normalized. The renderer and the search
 * projection walk the same list in the same order, so a highlight and a
 * projected occurrence cannot drift apart.
 */
export type McpContentBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "audio"; data: string; mimeType: string }
  | { kind: "resource"; uri: string; mimeType?: string; text?: string; name?: string };

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Normalize one content block. Unknown types, a malformed media type and a
 * payload that is not base64 are dropped rather than guessed at: the row shows
 * less content, never something it cannot vouch for (AGENTS.md invariant 9).
 */
function contentBlock(raw: unknown): McpContentBlock | undefined {
  const part = record(raw);
  const type = part["type"];
  if (type === "text") {
    const value = text(part["text"]);
    return value === undefined ? undefined : { kind: "text", text: value };
  }
  if (type === "image" || type === "audio") {
    const data = text(part["data"]);
    const mimeType = text(part["mimeType"]);
    if (data === undefined || mimeType === undefined || !MIME_RE.test(mimeType) || !BASE64_RE.test(data)) return undefined;
    return { kind: type, data, mimeType };
  }
  if (type === "resource" || type === "resource_link") {
    const inner = type === "resource" ? record(part["resource"]) : part;
    const uri = text(inner["uri"]);
    if (uri === undefined) return undefined;
    const mimeType = text(inner["mimeType"]);
    const body = text(inner["text"]);
    const name = text(inner["name"]);
    return {
      kind: "resource",
      uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(body !== undefined ? { text: body } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  }
  return undefined;
}

/**
 * The blocks of an MCP result, in the order the server sent them. A hydrated
 * transcript keeps only the joined text of a result, so a plain string is one
 * text block; anything without a content envelope has no blocks at all.
 */
export function mcpContentBlocks(result: unknown): McpContentBlock[] {
  if (typeof result === "string") return result ? [{ kind: "text", text: result }] : [];
  const content = record(result)["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    const block = contentBlock(part);
    return block ? [block] : [];
  });
}

/**
 * A gateway call carries the called tool's own result under
 * `details.mcpResult`; when that was too large to keep, the envelope's own
 * `content` is what the row shows and what search indexes.
 */
export function mcpResultContent(result: unknown): unknown {
  const inner = record(record(record(result)["details"])["mcpResult"]);
  return Array.isArray(inner["content"]) ? inner : result;
}

// A server's text is drawn by the transcript's Markdown renderer, so what a
// person can actually select is the *rendered* text: a link is its label, a
// fence is its code without the ``` line, a heading has no hashes. Find picks
// a highlight by occurrence index, so the projection has to count the same
// things the DOM does; these are the differences that move content rather
// than punctuation. The remaining tolerance is written down in
// docs/search-content.md.
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const MD_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const MD_BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;

/**
 * A Markdown block as the row renders it. Fence delimiters (and their language
 * label, which the renderer marks `data-search-exclude`) disappear, code
 * inside a fence stays verbatim, an image is not text at all, a link is its
 * label, and a heading, quote or list marker is drawn by the layout rather
 * than written out.
 */
export function mcpDisplayText(value: string): string {
  let inFence = false;
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    lines.push(line.replace(MD_IMAGE, "").replace(MD_LINK, "$1").replace(MD_BLOCK_MARKER, ""));
  }
  return lines.join("\n");
}

/**
 * Visible fragments of a content envelope: the rendered text, and a resource's
 * displayed name and text. Never media data, never a uri the row does not show.
 */
const contentFragments = (result: unknown): string[] =>
  mcpContentBlocks(result).flatMap(block => {
    if (block.kind === "text") {
      const shown = mcpDisplayText(block.text);
      return shown ? [shown] : [];
    }
    // The card shows one identity for the resource — its name when it has one.
    if (block.kind === "resource") return [block.name ?? block.uri, ...(block.text ? [mcpDisplayText(block.text)] : [])];
    return [];
  });

/** What a gateway row draws beside the text: the search matches, the status table. */
function gatewayModeFragments(details: Record<string, unknown>): string[] {
  const mode = details["mode"];
  if (mode === "search" && Array.isArray(details["matches"])) {
    return details["matches"].flatMap(raw => {
      const match = record(raw);
      return [text(match["server"]), text(match["tool"])].filter((v): v is string => v !== undefined);
    });
  }
  if (mode === "status" && Array.isArray(details["servers"])) {
    return details["servers"].flatMap(raw => {
      const server = record(raw);
      const count = server["toolCount"];
      return [
        ...[text(server["name"]), text(server["status"])].filter((v): v is string => v !== undefined),
        ...(typeof count === "number" ? [String(count)] : []),
      ];
    });
  }
  return [];
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

/** A server's own tool: its arguments, then the blocks of its result. */
const mcpDirect: ToolSearchProjection = ({ args, result }) => [...jsonSearchValues(args), ...contentFragments(result)];

/** `mcp` and `mcp__<server>`: the arguments, the mode's own list, then the text. */
const mcpGateway: ToolSearchProjection = ({ args, result }) => [
  ...jsonSearchValues(args),
  ...gatewayModeFragments(record(record(result)["details"])),
  ...contentFragments(mcpResultContent(result)),
];

/**
 * `mcpScript`: the arguments disclosure every row carries, then the code as the
 * body draws it (verbatim in a fence), then the output. The code is in both
 * regions because the row shows it in both — the JSON viewer's escaped
 * spelling and the fence's own.
 */
const mcpScript: ToolSearchProjection = ({ args, result }) => {
  const code = record(args)["code"];
  return [...jsonSearchValues(args), ...(typeof code === "string" && code ? [code] : []), ...contentFragments(result)];
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
  // A child's final message. The transcript hides this tool row and draws the
  // message as the child's last assistant block; only that message is shown,
  // so only that message is searchable (the status is a badge, not prose).
  complete_agent_run: ({ args }) => {
    const message = record(args)["message"];
    return typeof message === "string" && message ? [message] : [];
  },
  // The MCP rows: arguments through the args disclosure, then exactly what the
  // body draws. `details` (server, tool, mode, trace, byte counts) is transport
  // metadata, and a screenshot's base64 is not text.
  [MCP_GATEWAY_TOOL]: mcpGateway,
  [MCP_SCRIPT_TOOL]: mcpScript,
};

export function toolSearchContent(tool: SearchableTool): string[] {
  return projectionFor(tool)(tool);
}

function projectionFor(tool: SearchableTool): ToolSearchProjection {
  if (Object.hasOwn(TOOL_SEARCH_PROJECTIONS, tool.name)) return TOOL_SEARCH_PROJECTIONS[tool.name]!;
  if (isMcpGatewayTool(tool.name)) return mcpGateway;
  // A direct MCP tool is known by the server that answered, not by its name.
  if (typeof record(record(tool.result)["details"])["server"] === "string") return mcpDirect;
  return jsonBody;
}
