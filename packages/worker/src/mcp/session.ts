/**
 * Loading the MCP engine into one session (docs/mcp.md "The engine").
 *
 * The engine is loaded only when this project has at least one enabled server:
 * with none configured it still registers its own gateway tools, and a tool the
 * model can see must do something. The configuration it gets is Laser's, built
 * in memory, with secrets resolved for this process only — never a file the
 * engine discovers for itself.
 *
 * The engine also talks to the person directly: a status line and toasts about
 * servers connecting and tools refreshing, written in its own vocabulary. MCP
 * status belongs on the Settings page, so those two calls are dropped here, at
 * the engine's own boundary, and every dialog it raises (sampling, elicitation,
 * approvals) still reaches the person untouched.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { toAdapterConfig } from "./adapter-config.js";
import { loadMcpEngine, type McpConfig } from "./engine.js";
import { McpStore } from "./store.js";

export interface McpSessionOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
}

export interface McpSessionSetup {
  /** The engine, as an inline extension for this session's resource loader. */
  extension: InlineExtension;
  /** The channel the companion's `mcp` module listens on. */
  statusEvent: string;
  /** How many servers this session started with. */
  serverCount: number;
}

/** The engine configuration for a project, or undefined when it has no server. */
export async function mcpSessionConfig(options: McpSessionOptions): Promise<McpConfig | undefined> {
  const store = new McpStore(options.agentDir);
  const servers = await store.enabled(options.cwd, options.projectTrusted);
  if (servers.length === 0) return undefined;
  const resolved = await Promise.all(
    servers.map(async ({ scope, config }) => ({ config, secrets: await store.secretsFor(scope, options.cwd, config.name) })),
  );
  return toAdapterConfig(resolved);
}

/** Build the session's MCP extension, or nothing when no server is enabled. */
export async function mcpSessionSetup(options: McpSessionOptions): Promise<McpSessionSetup | undefined> {
  const config = await mcpSessionConfig(options);
  if (!config) return undefined;
  const engine = await loadMcpEngine();
  const factory = engine.createMcpAdapter({ config }) as unknown as (pi: ExtensionAPI) => void | Promise<void>;
  return {
    extension: { name: "mcp", factory: (pi: ExtensionAPI) => factory(quietEngineUi(pi)) },
    statusEvent: engine.statusEvent,
    serverCount: Object.keys(config.mcpServers).length,
  };
}

/** Commands the engine registers for its own terminal UI; Settings is ours. */
export const MCP_ENGINE_COMMANDS: readonly string[] = ["mcp", "pi-mcp", "mcp-auth"];

/**
 * The same extension API, with the session context's status line and toasts
 * neutralised for this extension only. Everything else — dialogs, tools,
 * events, the session itself — passes straight through, so a change in the
 * engine's surface cannot be silently swallowed here.
 */
export function quietEngineUi(pi: ExtensionAPI): ExtensionAPI {
  const wrapHandler = (handler: unknown): unknown =>
    typeof handler === "function"
      ? (...args: unknown[]) => (handler as (...values: unknown[]) => unknown)(...args.map(quietContext))
      : handler;
  return new Proxy(pi, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const mapped = property === "on" || property === "registerShortcut" || property === "registerCommand"
          ? args.map((argument) => (typeof argument === "function" ? wrapHandler(argument) : quietOptions(argument)))
          : args;
        return (value as (...values: unknown[]) => unknown).apply(target, mapped);
      };
    },
  }) as ExtensionAPI;
}

/** `registerCommand(name, { handler })`: the handler takes the context too. */
function quietOptions(argument: unknown): unknown {
  if (!argument || typeof argument !== "object") return argument;
  const options = argument as { handler?: unknown };
  if (typeof options.handler !== "function") return argument;
  const handler = options.handler as (...values: unknown[]) => unknown;
  return { ...options, handler: (...args: unknown[]) => handler(...args.map(quietContext)) };
}

function quietContext(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const context = value as { ui?: unknown };
  let hasUi = false;
  try {
    hasUi = context.ui !== undefined && context.ui !== null;
  } catch {
    return value;
  }
  if (!hasUi) return value;
  return new Proxy(context, {
    get(target, property, receiver) {
      const inner = Reflect.get(target, property, receiver);
      if (property !== "ui" || !inner || typeof inner !== "object") return inner;
      return new Proxy(inner as object, {
        get(uiTarget, uiProperty, uiReceiver) {
          // A person sees MCP state in Settings, not as a toast or a status
          // line in a chat (docs/mcp.md). Dialogs are not touched.
          if (uiProperty === "setStatus" || uiProperty === "notify") return () => {};
          const uiValue = Reflect.get(uiTarget, uiProperty, uiReceiver);
          return typeof uiValue === "function" ? uiValue.bind(uiTarget) : uiValue;
        },
      });
    },
  });
}
