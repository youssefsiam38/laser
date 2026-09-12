import { createHash } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MCP_CONTEXT_SHARE, type McpConversationContext } from "@lasercode/protocol";
import type { McpDiscoveryPolicy } from "./engine.js";

type Match = Parameters<McpDiscoveryPolicy["search"]>[0][number];
type Detail = "names" | "summary" | "full";
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const revision = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const toolName = (value: unknown): unknown => {
  const entry = record(value);
  return entry.name ?? record(entry.function).name ?? record(entry.toolSpec).name;
};

/** MCP's prompt contract lives here: discovery never activates provider tools.
 * Adapter registration is frozen at the first provider request. Definitions are
 * returned atomically in results, not inserted into or sorted in a tools array.
 * UTF-8 byte counts are deliberately labelled conservative token upper bounds.
 */
export class McpPromptContext implements McpDiscoveryPolicy {
  private readonly definitions = new Map<string, ToolDefinition>();
  private frozen = false;
  private title: string | undefined;
  private sessionId: string | undefined;
  private readonly pages = new Map<string, string>();
  private contextWindow: number | null = null;
  private preloaded: string[] = [];
  private preloadedTokens = 0;
  private lastDiscoveryTokens = 0;
  private readonly discoveries = new Map<string, McpConversationContext["discoveries"][number]>();
  private publish = () => {};

  constructor(private readonly renderSchema: (schema: unknown) => string | null = () => null) {}

  snapshot(): McpConversationContext {
    return {
      ...(this.title ? { title: this.title } : {}),
      contextWindow: this.contextWindow,
      budget: this.contextWindow === null ? null : Math.floor(this.contextWindow * MCP_CONTEXT_SHARE),
      share: MCP_CONTEXT_SHARE,
      measurement: "utf8-upper-bound",
      preloaded: [...this.preloaded], preloadedTokens: this.preloadedTokens,
      lastDiscoveryTokens: this.lastDiscoveryTokens,
      discoveries: [...this.discoveries.values()],
    };
  }

  search(matches: Match[], input: Parameters<McpDiscoveryPolicy["search"]>[1]): Record<string, unknown> {
    const detail: Detail = input.detail === "names" || input.detail === "full" ? input.detail : "summary";
    const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 12;
    const limit = Math.max(1, Math.min(detail === "full" ? 5 : 50, requested));
    const offset = Math.max(0, Number.isFinite(input.offset) ? Math.trunc(input.offset!) : 0);
    const catalogRevision = revision(matches.map(({ server, tool }) => ({ server, tool })));
    const pageKey = JSON.stringify([input.query, input.server ?? null]);
    const previousRevision = this.pages.get(pageKey);
    if (offset > 0 && previousRevision !== catalogRevision) return this.response({ items: [], groups: [], total: matches.length, hasMore: false, nextOffset: null, message: "The tool catalog changed. Search again from the beginning.", revision: catalogRevision });
    this.pages.set(pageKey, catalogRevision);
    const budget = this.snapshot().budget;
    const available = budget === null ? 0 : Math.max(0, budget - this.preloadedTokens);
    const chosen: Match[] = [];
    const items: Record<string, unknown>[] = [];
    let reason: string | undefined;
    const budgetMessage = budget === null ? "Context window unavailable. Inspect one tool explicitly for its full schema." : "Discovery budget reached. Inspect one tool explicitly for its full schema.";
    const pageFor = (values: Record<string, unknown>[]) => {
      const end = offset + values.length;
      const groups = [...new Set(values.map((item) => String(item.server)))].map((server) => ({ server, paths: values.filter((item) => item.server === server).map((item) => item.path) }));
      return { items: values, groups, total: matches.length, hasMore: end < matches.length, nextOffset: end < matches.length ? end : null, revision: catalogRevision, detail };
    };
    for (const match of matches.slice(offset, offset + limit)) {
      const item = this.project(match, detail);
      if (detail === "full" && (budget === null || bytes({ ...pageFor([...items, item]), message: budgetMessage }) > available)) {
        reason = budgetMessage;
        break;
      }
      if (detail !== "full" && (budget === null || bytes({ ...pageFor([...items, item]), message: budgetMessage }) > available)) {
        reason = budgetMessage;
        if (items.length > 0) break;
      }
      chosen.push(match);
      items.push(item);
    }
    // Never hide a schema by advancing a continuation past an omitted item.
    const page = { ...pageFor(items), ...(reason ? { message: reason } : {}) };
    chosen.forEach((match) => this.remember(match, detail));
    return this.response(page);
  }

  private response(value: Record<string, unknown>): Record<string, unknown> {
    this.lastDiscoveryTokens = bytes(value);
    this.publish();
    return value;
  }

  describe(server: string, tool: Match["tool"]): Record<string, unknown> {
    const definition = this.project({ server, tool, score: 0 }, "full");
    const descriptor = { ...definition, definitionTokenUpperBound: bytes(definition), measurement: "utf8-upper-bound" };
    if (this.contextWindow !== null && bytes(descriptor) + this.preloadedTokens >= this.contextWindow) {
      return this.response({ path: tool.name, error: { code: "schema_too_large", message: "This tool's complete definition may not fit this model. Choose a larger model or turn off preloading." } });
    }
    this.remember({ server, tool, score: 0 }, "full");
    return this.response(descriptor);
  }

  private project({ server, tool }: Match, detail: Detail): Record<string, unknown> {
    const inputTypeScript = detail === "full" ? this.renderSchema(tool.inputSchema) : null;
    const outputTypeScript = detail === "full" ? this.renderSchema(tool.outputSchema) : null;
    return {
      path: tool.name, name: tool.originalName, server,
      ...(inputTypeScript ? { inputTypeScript } : {}),
      ...(outputTypeScript ? { outputTypeScript } : {}),
      ...(detail !== "names" ? { description: detail === "summary" ? tool.description.slice(0, 512) : tool.description } : {}),
      ...(detail === "full" ? { inputSchema: tool.inputSchema ?? { type: "object", properties: {} }, ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema, outputSchemaTarget: "data.structuredContent" }) } : {}),
    };
  }

  private remember({ server, tool }: Match, detail: Detail): void {
    const key = `${server}/${tool.name}`;
    const previous = this.discoveries.get(key);
    const hash = revision(tool);
    const levels: Detail[] = ["names", "summary", "full"];
    this.discoveries.set(key, { server, name: tool.name, detail: previous?.revision === hash && levels.indexOf(previous.detail) > levels.indexOf(detail) ? previous.detail : detail, revision: hash });
  }

  /** Wrap only this adapter's API. Other extensions' tools remain untouched. */
  wrap(pi: ExtensionAPI, statusEvent: string): ExtensionAPI {
    let latestStatus: Record<string, unknown> | undefined;
    const emit = (snapshot: Record<string, unknown>) => pi.events.emit(statusEvent, { ...snapshot, ...(this.frozen ? { context: this.snapshot() } : {}) });
    this.publish = () => { if (latestStatus) emit(latestStatus); };
    const events = new Proxy(pi.events, { get: (target, key) => {
      if (key === "emit") return (channel: string, data: unknown) => {
        if (channel !== statusEvent) return target.emit(channel, data);
        latestStatus = record(data);
        emit(latestStatus);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    pi.on("session_start", (_event, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      if (id === this.sessionId) return;
      this.sessionId = id;
      this.title = ctx.sessionManager.getSessionName();
      this.frozen = false;
      this.contextWindow = null;
      this.preloaded = [];
      this.preloadedTokens = 0;
      this.lastDiscoveryTokens = 0;
      this.discoveries.clear();
      this.pages.clear();
    });
    pi.on("before_provider_request", (event, ctx) => {
      this.title = ctx.sessionManager.getSessionName();
      const window = ctx.model?.contextWindow;
      this.contextWindow = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
      const payload = record(event.payload);
      // Pi's native request formats: OpenAI/Anthropic/Mistral, Google,
      // Bedrock Converse, and the Pi relay's engine-neutral context.
      const tools = [payload.tools, record(payload.config).tools, record(payload.toolConfig).tools, record(payload.context).tools].find(Array.isArray) ?? [];
      const entries = tools.flatMap((raw: unknown) => {
        const entry = record(raw);
        if (Array.isArray(entry.functionDeclarations)) return entry.functionDeclarations;
        return [raw];
      }).filter((raw) => {
        const name = toolName(raw);
        return typeof name === "string" && this.definitions.has(name);
      });
      this.preloaded = entries.map((raw) => String(toolName(raw))).filter((name) => name !== "mcp" && name !== "mcpScript");
      this.preloadedTokens = entries.length ? bytes(entries) : 0;
      this.frozen = true;
      this.publish();
      if (this.contextWindow !== null && this.preloadedTokens >= this.contextWindow) {
        // Pi isolates handler exceptions; throwing here would NOT prevent send.
        // Abort synchronously starts cancellation; do not await the invocation
        // from its own before-request handler.
        ctx.ui.notify("Preloaded MCP tools may exceed this model’s context window. Turn off ‘Put every tool in the conversation’ or choose a larger model.", "error");
        try { ctx.abort(); }
        catch { ctx.ui.notify("The request could not be stopped. Stop this conversation before changing its tool settings.", "error"); }
      }
    });
    return new Proxy(pi, { get: (target, key) => {
      if (key === "events") return events;
      if (key === "setActiveTools") return (names: string[]) => {
        // Only this adapter is fenced. Other extensions retain their own API.
        if (!this.frozen) target.setActiveTools(names);
      };
      if (key === "registerTool") return (tool: ToolDefinition) => {
        // Namespace gateways duplicate the one stable gateway's capability.
        if (tool.name.startsWith("mcp__")) return;
        if (this.frozen) return;
        this.definitions.set(tool.name, tool);
        target.registerTool(tool);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}
