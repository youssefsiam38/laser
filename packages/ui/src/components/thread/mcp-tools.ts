/**
 * Pure helpers for MCP tool rows (docs/mcp.md "In the transcript"). No React,
 * no DOM; tested in test/thread/mcp-tool-rows.test.tsx.
 *
 * The engine registers a server's tools under `<server>_<tool>`, with `-` in
 * the server's configured name replaced by `_`, and adds one gateway tool
 * (`mcp`, or `mcp__<server>` scoped to a server) plus `mcpScript`. So a row
 * recognises a direct MCP call two ways, in this order:
 *
 *   1. the result's `details.server` — the server that actually answered;
 *   2. the session's server names, for a transcript read back after the fact,
 *      where the stored result is only the joined text of its blocks.
 *
 * Shapes verified against the real adapter (Playwright over stdio, HTTP and
 * the proxy) before this file was written.
 */
import { isMcpGatewayTool, mcpGatewayNamespace, MCP_SCRIPT_TOOL } from "@lasercode/protocol";

import { oneLine } from "./tool-summary.js";

export type McpToolKind = "direct" | "gateway" | "script";

export interface McpToolInfo {
  readonly kind: McpToolKind;
  /** The configured server name (`playwright`), when this row names one. */
  readonly server?: string;
  /** The tool's own name on that server (`browser_navigate`), for a direct call. */
  readonly tool?: string;
}

/** `chrome-devtools` → `chrome_devtools`: how a server's name enters a tool name. */
export const mcpToolPrefix = (server: string): string => `${server.replace(/-/g, "_")}_`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Which MCP row this call is, or `undefined` when it is not an MCP call at
 * all. `details` is the result's own details (absent once the session is
 * stored), `servers` the session's MCP server names.
 */
export function classifyMcpTool(
  toolName: string,
  details: Record<string, unknown> | undefined,
  servers: readonly string[],
): McpToolInfo | undefined {
  if (toolName === MCP_SCRIPT_TOOL) return { kind: "script" };
  if (isMcpGatewayTool(toolName)) {
    const server = mcpGatewayNamespace(toolName) ?? str(details?.["server"]);
    return { kind: "gateway", ...(server !== undefined ? { server } : {}) };
  }
  const answered = str(details?.["server"]);
  if (answered !== undefined) {
    const tool = str(details?.["tool"]) ?? stripServerPrefix(toolName, answered);
    return { kind: "direct", server: answered, ...(tool !== undefined ? { tool } : {}) };
  }
  // Longest prefix first: two configured servers can share a stem.
  for (const server of [...servers].sort((a, b) => b.length - a.length)) {
    const tool = stripServerPrefix(toolName, server);
    if (tool !== undefined) return { kind: "direct", server, tool };
  }
  return undefined;
}

function stripServerPrefix(toolName: string, server: string): string | undefined {
  const prefix = mcpToolPrefix(server);
  return toolName.startsWith(prefix) && toolName.length > prefix.length ? toolName.slice(prefix.length) : undefined;
}

/** `chrome-devtools` → `Chrome Devtools`: the server's name as a row's verb. */
export function mcpServerLabel(server: string): string {
  const words = server.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return server;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * A tool's own name, read as words: `browser_navigate` → `browser navigate`.
 * The server's prefix is dropped when the name still carries it, because the
 * row's verb already says which server this is. Nothing else is dropped: in
 * `create_issue` the first segment is the whole verb.
 */
export function mcpToolLabel(tool: string, server?: string): string {
  const own = server !== undefined ? (stripServerPrefix(tool, server) ?? tool) : tool;
  return own.split(/[-_\s]+/).filter(Boolean).join(" ") || own;
}

/** The most telling argument of a call, the way the unknown-tool row picks one. */
export const MCP_TELLING_ARGS = ["url", "selector", "element", "text", "query", "name", "path"] as const;

export function mcpTellingArg(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of MCP_TELLING_ARGS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return oneLine(value, 60);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

export interface McpRowSummary {
  /** Host Grotesk 500 verb: the server's display name, "MCP", "MCP script". */
  readonly verb: string;
  /** Martian Mono summary. */
  readonly summary: string;
  /** The exact tool name, for the body header and the row's tooltip. */
  readonly exact?: string;
}

/** The verb and summary of a direct call: `Playwright · navigate · https://example.com`. */
export function mcpDirectSummary(info: McpToolInfo, toolName: string, args: unknown): McpRowSummary {
  const server = info.server ?? "";
  const tool = info.tool ?? toolName;
  const label = mcpToolLabel(tool, server);
  const telling = mcpTellingArg(args);
  return {
    verb: server ? mcpServerLabel(server) : "MCP",
    summary: [label, telling].filter(Boolean).join(" · "),
    exact: toolName,
  };
}

/** The gateway's mode, as the adapter names it in `details.mode`. */
export type McpGatewayMode = "search" | "call" | "connect" | "list" | "describe" | "status" | "instructions" | "auth" | "other";

export interface McpGatewayView {
  readonly mode: McpGatewayMode;
  /** Raw `details.mode`, for the modes that share a body. */
  readonly rawMode: string | undefined;
  readonly server?: string;
  readonly tool?: string;
  readonly query?: string;
}

/**
 * What a gateway call did. `details.mode` is the truth once the call has
 * answered; before that — and in a stored transcript — the arguments say it,
 * because the mode *is* the argument the model chose.
 */
export function mcpGatewayView(args: unknown, details: Record<string, unknown> | undefined): McpGatewayView {
  const a = isRecord(args) ? args : {};
  const raw = str(details?.["mode"]);
  const server = str(details?.["server"]) ?? str(a["connect"]) ?? str(a["server"]) ?? str(a["instructions"]);
  const tool = str(isRecord(details?.["tool"]) ? (details["tool"] as Record<string, unknown>)["name"] : details?.["tool"]) ?? str(a["tool"]) ?? str(a["describe"]);
  const query = str(details?.["query"]) ?? str(a["search"]);
  const action = str(a["action"]);
  const mode = ((): McpGatewayMode => {
    // `action` is explicit (`auth-start`, `ui-messages`); every other mode is
    // named by the argument the model chose, and `{}` alone is status.
    const candidate =
      raw ??
      action ??
      (query !== undefined
        ? "search"
        : str(a["tool"]) !== undefined
          ? "call"
          : str(a["describe"]) !== undefined
            ? "describe"
            : str(a["connect"]) !== undefined
              ? "connect"
              : str(a["instructions"]) !== undefined
                ? "instructions"
                : str(a["server"]) !== undefined
                  ? "list"
                  : "status");
    if (candidate === "search" || candidate === "call" || candidate === "connect" || candidate === "list" || candidate === "describe" || candidate === "status" || candidate === "instructions") return candidate;
    if (candidate.startsWith("auth")) return "auth";
    return "other";
  })();
  return {
    mode,
    rawMode: raw ?? action,
    ...(server !== undefined ? { server } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(query !== undefined ? { query } : {}),
  };
}

/** `Search "navigate"`, `Call playwright · browser_navigate`, `Status`. */
export function mcpGatewaySummary(view: McpGatewayView): string {
  switch (view.mode) {
    case "search":
      return view.query !== undefined ? `Search “${oneLine(view.query, 60)}”` : "Search";
    case "call":
      return ["Call", [view.server, view.tool].filter(Boolean).join(" · ")].filter(Boolean).join(" ");
    case "connect":
      return ["Connect", view.server].filter(Boolean).join(" ");
    case "list":
      return ["List", view.server].filter(Boolean).join(" ");
    case "describe":
      return ["Describe", view.tool ?? view.server].filter(Boolean).join(" ");
    case "instructions":
      return ["Instructions", view.server].filter(Boolean).join(" ");
    case "auth":
      return ["Sign in", view.server].filter(Boolean).join(" ");
    case "status":
      return "Status";
    default:
      return view.rawMode ? oneLine(view.rawMode, 40) : "Status";
  }
}

/** The first non-empty line of a script, for the row's summary. */
export function mcpScriptSummary(args: unknown): string {
  const code = isRecord(args) ? args["code"] : undefined;
  if (typeof code !== "string") return "";
  // Short enough that the verb beside it keeps its own words at a phone width.
  return oneLine(code.split("\n").find((line) => line.trim() !== "") ?? "", 48);
}

export interface McpSearchMatch {
  readonly server: string;
  readonly tool: string;
}

/** `details.matches` of a search, keeping only the two fields the list draws. */
export function mcpSearchMatches(details: Record<string, unknown> | undefined): McpSearchMatch[] {
  const matches = details?.["matches"];
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((raw) => {
    const match = isRecord(raw) ? raw : {};
    const server = str(match["server"]);
    const tool = str(match["tool"]);
    return server !== undefined || tool !== undefined ? [{ server: server ?? "", tool: tool ?? "" }] : [];
  });
}

export interface McpStatusRow {
  readonly name: string;
  readonly status: string;
  readonly toolCount?: number;
}

/** `details.servers` of a status call, as the compact table draws them. */
export function mcpStatusRows(details: Record<string, unknown> | undefined): McpStatusRow[] {
  const servers = details?.["servers"];
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((raw) => {
    const server = isRecord(raw) ? raw : {};
    const name = str(server["name"]);
    if (name === undefined) return [];
    const count = server["toolCount"];
    return [
      {
        name,
        status: str(server["status"]) ?? "unknown",
        ...(typeof count === "number" ? { toolCount: count } : {}),
      },
    ];
  });
}

export interface McpScriptCall {
  readonly server?: string;
  readonly tool: string;
  readonly ok?: boolean;
}

/** `details.calls` of a script run: one line per call it made. */
export function mcpScriptCalls(details: Record<string, unknown> | undefined): McpScriptCall[] {
  const calls = details?.["calls"];
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((raw) => {
    const call = isRecord(raw) ? raw : {};
    const tool = str(call["tool"]) ?? str(call["name"]);
    if (tool === undefined) return [];
    const server = str(call["server"]);
    const ok = call["ok"] ?? call["success"];
    return [
      {
        tool,
        ...(server !== undefined ? { server } : {}),
        ...(typeof ok === "boolean" ? { ok } : {}),
      },
    ];
  });
}
