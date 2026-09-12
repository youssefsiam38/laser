import { createHash } from "node:crypto";
import { MCP_CONTEXT_SHARE } from "@lasercode/protocol";
import type { McpDiscoveryPolicy } from "./engine.js";

export type Match = Parameters<McpDiscoveryPolicy["search"]>[0][number];
export type Detail = "names" | "summary" | "full";
export type RenderSchema = (schema: unknown) => string | null;
export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
export const revision = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Unknown windows retain useful summary pages without pretending to know a share.
// This bounds one lookup, not conversation history or explicitly preloaded tools.
export const UNKNOWN_WINDOW_LOOKUP_BYTES = 16 * 1024;
// Actionable guidance has its own bounded envelope; it cannot evict matches.
export const DISCOVERY_GUIDANCE_BYTES = 1024;
export function boundedGuidance(messages: readonly string[] = []): Record<string, unknown> {
  const guidance: string[] = [];
  for (const message of messages) {
    if (bytes({ guidance: [...guidance, message], guidanceTruncated: true }) <= DISCOVERY_GUIDANCE_BYTES) {
      guidance.push(message);
      continue;
    }
    let prefix = "";
    for (const character of message) {
      if (bytes({ guidance: [...guidance, prefix + character + "…"], guidanceTruncated: true }) > DISCOVERY_GUIDANCE_BYTES) break;
      prefix += character;
    }
    if (prefix) guidance.push(prefix + "…");
    return { guidance, guidanceTruncated: true };
  }
  return guidance.length ? { guidance } : {};
}
export const lookupBudget = (window: number | null): number | null =>
  window === null ? null : Math.floor(window * MCP_CONTEXT_SHARE);

export function projectTool({ server, tool }: Match, detail: Detail, render: RenderSchema): Record<string, unknown> {
  const inputTypeScript = detail === "full" ? render(tool.inputSchema) : null;
  const outputTypeScript = detail === "full" ? render(tool.outputSchema) : null;
  return {
    path: tool.name,
    name: tool.originalName,
    server,
    ...(inputTypeScript ? { inputTypeScript } : {}),
    ...(outputTypeScript ? { outputTypeScript } : {}),
    ...(detail !== "names" ? {
      description: detail === "summary" ? tool.description.slice(0, 512) : tool.description,
    } : {}),
    ...(detail === "full" ? {
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      ...(tool.outputSchema === undefined ? {} : {
        outputSchema: tool.outputSchema,
        outputSchemaTarget: "data.structuredContent",
      }),
    } : {}),
  };
}

export function searchDiscovery(
  matches: Match[],
  input: Parameters<McpDiscoveryPolicy["search"]>[1],
  context: { window: number | null; previousRevision?: string | undefined; render: RenderSchema },
): { page: Record<string, unknown>; chosen: Match[]; detail: Detail; catalogRevision: string } {
  const requestedDetail = input.detail === "names" || input.detail === "full" ? input.detail : "summary";
  const detail: Detail = context.window === null && requestedDetail === "full" ? "summary" : requestedDetail;
  const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 12;
  const limit = Math.max(1, Math.min(detail === "full" ? 5 : 50, requested));
  const offset = Math.max(0, Number.isFinite(input.offset) ? Math.trunc(input.offset!) : 0);
  const catalogRevision = revision(matches.map(({ server, tool }) => ({ server, tool })));
  const chosen: Match[] = [];
  if (offset > 0 && context.previousRevision !== catalogRevision) {
    return {
      page: {
        items: [], groups: [], total: matches.length, hasMore: false, nextOffset: null,
        message: "The tool catalog changed. Search again from the beginning.", revision: catalogRevision,
      },
      chosen, detail, catalogRevision,
    };
  }
  // Explicit preload bypasses this soft allowance; it is measured and warned
  // about separately, and still participates in hard-window admission.
  const available = lookupBudget(context.window) ?? UNKNOWN_WINDOW_LOOKUP_BYTES;
  const items: Record<string, unknown>[] = [];
  const unavailable = context.window === null
    ? "Context-window share unavailable. Discovery uses bounded names and summaries; inspect one tool for its full schema."
    : undefined;
  let reason = unavailable;
  const budgetMessage = "Per-lookup limit reached. Inspect one tool explicitly for its full schema.";
  const limitMessage = unavailable ? `${unavailable} ${budgetMessage}` : budgetMessage;
  const pageFor = (values: Record<string, unknown>[]) => {
    const end = offset + values.length;
    const groups = [...new Set(values.map(item => String(item.server)))].map(server => ({
      server, paths: values.filter(item => item.server === server).map(item => item.path),
    }));
    return {
      items: values, groups,
      total: matches.length, hasMore: end < matches.length,
      nextOffset: end < matches.length ? end : null, revision: catalogRevision, detail,
    };
  };
  for (const match of matches.slice(offset, offset + limit)) {
    const item = projectTool(match, detail, context.render);
    const size = bytes({ ...pageFor([...items, item]), message: limitMessage });
    if (size > available) {
      reason = limitMessage;
      if (detail === "full" || items.length > 0) break;
    }
    chosen.push(match);
    items.push(item);
  }
  return {
    page: { ...pageFor(items), ...(reason ? { message: reason } : {}), ...boundedGuidance(input.guidance) },
    chosen, detail, catalogRevision,
  };
}

export function describeDiscovery(
  server: string,
  tool: Match["tool"],
  context: { window: number | null; preloadedTokens: number; render: RenderSchema },
): Record<string, unknown> {
  const definition = projectTool({ server, tool, score: 0 }, "full", context.render);
  const descriptor = {
    ...definition, definitionTokenUpperBound: bytes(definition), measurement: "utf8-upper-bound",
  };
  if (context.window !== null && bytes(descriptor) + context.preloadedTokens >= context.window) {
    return {
      path: tool.name,
      error: {
        code: "schema_too_large",
        message: "This tool's complete definition may not fit this model. Choose a larger model or turn off preloading.",
      },
    };
  }
  return descriptor;
}
