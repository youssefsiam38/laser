import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MCP_CONTEXT_SHARE, type McpConversationContext } from "@lasercode/protocol";
import type { McpDiscoveryPolicy } from "./engine.js";
import {
  bytes, describeDiscovery, lookupBudget, revision, searchDiscovery,
  type Detail, type Match, type RenderSchema,
} from "./discovery-policy.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const toolName = (value: unknown): unknown => {
  const entry = record(value);
  return entry.name ?? record(entry.function).name ?? record(entry.toolSpec).name;
};

/** The engine boundary: only this adapter's registry mutations are fenced.
 * Discovery is data in tool results, never a provider-payload rewrite.
 */
export class McpPromptFreeze implements McpDiscoveryPolicy {
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

  constructor(private readonly renderSchema: RenderSchema = () => null) {}

  snapshot(): McpConversationContext {
    return {
      ...(this.title ? { title: this.title } : {}),
      contextWindow: this.contextWindow,
      budget: lookupBudget(this.contextWindow),
      share: MCP_CONTEXT_SHARE,
      measurement: "utf8-upper-bound",
      preloaded: [...this.preloaded],
      preloadedTokens: this.preloadedTokens,
      lastDiscoveryTokens: this.lastDiscoveryTokens,
      discoveries: [...this.discoveries.values()],
    };
  }

  search(matches: Match[], input: Parameters<McpDiscoveryPolicy["search"]>[1]): Record<string, unknown> {
    const key = JSON.stringify([input.query, input.server ?? null]);
    const result = searchDiscovery(matches, input, {
      window: this.contextWindow, previousRevision: this.pages.get(key), render: this.renderSchema,
    });
    this.pages.set(key, result.catalogRevision);
    result.chosen.forEach(match => this.remember(match, result.detail));
    return this.response(result.page);
  }

  describe(server: string, tool: Match["tool"]): Record<string, unknown> {
    const descriptor = describeDiscovery(server, tool, {
      window: this.contextWindow, preloadedTokens: this.preloadedTokens, render: this.renderSchema,
    });
    if (!descriptor.error) this.remember({ server, tool, score: 0 }, "full");
    return this.response(descriptor);
  }

  private response(value: Record<string, unknown>): Record<string, unknown> {
    this.lastDiscoveryTokens = bytes(value);
    this.publish();
    return value;
  }

  private remember({ server, tool }: Match, detail: Detail): void {
    const key = `${server}/${tool.name}`;
    const previous = this.discoveries.get(key);
    const hash = revision(tool);
    const levels: Detail[] = ["names", "summary", "full"];
    const retained = previous?.revision === hash && levels.indexOf(previous.detail) > levels.indexOf(detail);
    this.discoveries.set(key, { server, name: tool.name, detail: retained ? previous.detail : detail, revision: hash });
  }

  wrap(pi: ExtensionAPI, statusEvent: string): ExtensionAPI {
    let latestStatus: Record<string, unknown> | undefined;
    const emit = (snapshot: Record<string, unknown>) => pi.events.emit(statusEvent, {
      ...snapshot, ...(this.frozen ? { context: this.snapshot() } : {}),
    });
    this.publish = () => { if (latestStatus) emit(latestStatus); };
    const events = new Proxy(pi.events, {
      get: (target, key) => {
        if (key === "emit") return (channel: string, data: unknown) => {
          if (channel !== statusEvent) return target.emit(channel, data);
          latestStatus = record(data);
          emit(latestStatus);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
      // Native formats: OpenAI/Anthropic/Mistral, Google, Bedrock, Pi relay.
      const tools = [
        payload.tools, record(payload.config).tools,
        record(payload.toolConfig).tools, record(payload.context).tools,
      ].find(Array.isArray) ?? [];
      const entries = tools.flatMap((raw: unknown) => {
        const entry = record(raw);
        return Array.isArray(entry.functionDeclarations) ? entry.functionDeclarations : [raw];
      }).filter(raw => {
        const name = toolName(raw);
        return typeof name === "string" && this.definitions.has(name);
      });
      this.preloaded = entries.map(raw => String(toolName(raw)))
        .filter(name => name !== "mcp" && name !== "mcpScript");
      this.preloadedTokens = entries.length ? bytes(entries) : 0;
      this.frozen = true;
      this.publish();
      if (this.contextWindow !== null && this.preloadedTokens >= this.contextWindow) {
        // Pi isolates hook exceptions. Its abort control starts cancellation;
        // never await the invocation from its own before-request handler.
        ctx.ui.notify(
          "Preloaded MCP tools may exceed this model’s context window. " +
          "Turn off ‘Put every tool in the conversation’ or choose a larger model.", "error",
        );
        try { ctx.abort(); }
        catch {
          ctx.ui.notify("The request could not be stopped. Stop this conversation before changing its tool settings.", "error");
        }
      }
    });
    return new Proxy(pi, {
      get: (target, key) => {
        if (key === "events") return events;
        if (key === "setActiveTools") return (names: string[]) => {
          if (!this.frozen) target.setActiveTools(names);
        };
        if (key === "unregisterTool") {
          // Optional in the adapter's supported engine versions. Preserve
          // absence so its fallback does not mistake us for a newer engine.
          const unregister = Reflect.get(target, key);
          if (typeof unregister !== "function") return undefined;
          return (name: string) => {
            if (this.frozen) return;
            this.definitions.delete(name);
            return unregister.call(target, name);
          };
        }
        if (key === "registerTool") return (tool: ToolDefinition) => {
          if (this.frozen) return;
          this.definitions.set(tool.name, tool);
          target.registerTool(tool);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
