/**
 * Loading the MCP engine into one session (docs/mcp.md "The engine").
 *
 * The engine is loaded only when this project has at least one enabled server:
 * with none configured it still registers its own gateway tools, and a tool the
 * model can see must do something. The configuration it gets is Laser's, built
 * in memory, with secrets resolved for this process only — never a file the
 * engine discovers for itself.
 *
 * The engine also talks to the person directly: a status line and routine
 * toasts about servers connecting and tools refreshing, written in its own
 * vocabulary. MCP status belongs on the Settings page, so the status line and
 * the *informational* toasts are dropped here, at the engine's own boundary.
 * A warning or an error — a sign-in that failed, an elicitation that could not
 * be shown, a prompt that failed — is not status: it is something a person has
 * to know now, and it passes through, as does every dialog the engine raises.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getServerPrefix } from "pi-mcp-adapter/types";
import { toAdapterConfig, type ProjectEnvDecorator } from "./adapter-config.js";
import { McpPromptFreeze } from "./prompt-freeze.js";
import { loadMcpEngine, type McpConfig } from "./engine.js";
import { McpStore } from "./store.js";
import { mcpClientIdentity } from "./identity.js";
import { McpAuthorizationError, McpAuthorizationRegistry, mcpAuthorizationAccount, mcpAuthorizationPartition, mcpAuthorizationIdentities, mcpAuthorizationRevision } from "./authorization.js";

export interface McpSessionOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
  /**
   * The project's environment (M16-T17). A stdio server is started by the
   * engine, not by the shell tool, so it is decorated here or not at all.
   */
  projectEnv?: ProjectEnvDecorator;
}

export interface McpSessionSetup {
  /** The engine, as an inline extension for this session's resource loader. */
  extension: InlineExtension;
  /** The channel the companion's `mcp` module listens on. */
  statusEvent: string;
  /** The servers this session started with, for attributing their commands. */
  servers: Array<{ name: string; label?: string }>;
}

/** The engine configuration for a project, or undefined when it has no server. */
export async function mcpSessionConfig(options: McpSessionOptions): Promise<McpConfig | undefined> {
  const store = new McpStore(options.agentDir);
  const servers = await store.enabled(options.cwd, options.projectTrusted);
  if (servers.length === 0) return undefined;
  return resolveConfig(store, servers, options.cwd, options.projectEnv);
}

async function resolveConfig(
  store: McpStore,
  servers: Awaited<ReturnType<McpStore["enabled"]>>,
  cwd: string,
  projectEnv?: ProjectEnvDecorator,
): Promise<McpConfig> {
  const resolved = await Promise.all(
    servers.map(async ({ scope, config }) => ({ config, secrets: await store.secretsFor(scope, cwd, config.name) })),
  );
  return toAdapterConfig(resolved, projectEnv);
}

/** Build the session's MCP extension, or nothing when no server is enabled. */
export async function mcpSessionSetup(options: McpSessionOptions): Promise<McpSessionSetup | undefined> {
  const store = new McpStore(options.agentDir);
  const servers = await store.enabled(options.cwd, options.projectTrusted);
  if (servers.length === 0) return undefined;
  // Configuration and attribution must describe the same validated snapshot,
  // even if the person saves a changed server while secrets are resolving.
  const registry = new McpAuthorizationRegistry(options.agentDir);
  // Display aliases may share one scoped target. Coalesce establishment inside
  // this one setup so they cannot contend with themselves on its durable lock.
  const establishing = new Map<string, ReturnType<McpAuthorizationRegistry["establish"]>>();
  const capture = (identity: string) => {
    let pending = establishing.get(identity);
    if (!pending) { pending = registry.establish(identity); establishing.set(identity, pending); }
    return pending;
  };
  // Capture before resolving credentials. A save racing resolution must make this
  // runtime stale, never pair old credentials with the new generation.
  const generations = new Map(await Promise.all(servers.map(async ({ scope, config }) => {
    const identities = await mcpAuthorizationIdentities(scope, options.cwd, config);
    return [config.name, await Promise.all(identities.map(capture))] as const;
  })));
  const current = await store.enabled(options.cwd, options.projectTrusted);
  if (JSON.stringify(current) !== JSON.stringify(servers)) {
    throw new Error("MCP server settings changed while opening this conversation.");
  }
  const config = await resolveConfig(store, servers, options.cwd, options.projectEnv);
  for (const [name, snapshots] of generations) {
    const primary = snapshots[0]!;
    config.mcpServers[name]!.authorizationIdentity = mcpAuthorizationAccount(primary);
    config.mcpServers[name]!.authorizationPartition = mcpAuthorizationPartition(snapshots);
  }
  const authorization = async (name: string): Promise<string | undefined> => {
    const snapshots = generations.get(name);
    const checks = snapshots?.length ? await Promise.all(snapshots.map(snapshot => registry.check(snapshot))) : [];
    if (checks.length && checks.every(check => check === "current")) return undefined;
    const label = servers.find(server => server.config.name === name)?.config.label ?? name;
    // Only an observed revocation refuses. A record that could not be read is
    // no evidence that access changed: fail this attempt as transient instead.
    if (checks.length && !checks.includes("stale")) {
      throw new McpAuthorizationError("unavailable", `Sign-in information for ${label} could not be checked. Try again.`);
    }
    return `Access to ${label} changed. Sign in again in Settings → MCP servers.`;
  };
  const commitCredentials = async (name: string, save: () => void): Promise<string> => {
    const snapshots = generations.get(name);
    const primary = snapshots?.[0];
    if (!primary) throw new Error("This server is no longer authorized. Sign in again in Settings → MCP servers.");
    const expected = new Map(snapshots!.map(value => [value.identity, value]));
    const committed = await registry.revoke([primary.identity], async next => { save(); return next; }, expected);
    generations.set(name, snapshots!.map(value => committed.get(value.identity)!));
    return mcpAuthorizationPartition(generations.get(name) ?? []);
  };
  const engine = await loadMcpEngine();
  const discovery = new McpPromptFreeze(engine.renderSchema);
  const factory = engine.createMcpAdapter({ config, clientIdentity: mcpClientIdentity(), discovery, authorization, commitCredentials, personManaged: true }) as unknown as (pi: ExtensionAPI) => void | Promise<void>;
  return {
    extension: { name: "mcp", factory: (pi: ExtensionAPI) => factory(quietEngineUi(discovery.wrap(pi, engine.statusEvent, name => mcpAuthorizationRevision(generations.get(name) ?? [])))) },
    statusEvent: engine.statusEvent,
    servers: servers.map(({ config: server }) => ({ name: server.name, ...(server.label ? { label: server.label } : {}) })),
  };
}

/** Commands the engine registers for its own terminal UI; Settings is ours. */
export const MCP_ENGINE_COMMANDS: readonly string[] = ["mcp", "pi-mcp", "mcp-auth"];

/**
 * A command the engine registered for one server's MCP prompt, and which
 * server it belongs to. The engine names them `mcp__<server>__<prompt>`
 * (`formatPromptCommandName`), so a command that names no configured server is
 * not one of these and is left alone.
 */
export function mcpPromptServer(
  commandName: string,
  servers: ReadonlyArray<{ name: string; label?: string }>,
): string | undefined {
  for (const server of servers) {
    if (commandName.startsWith(`${promptCommandPrefix(server.name)}__`)) return server.label ?? server.name;
  }
  return undefined;
}

/** `mcp__<server>`, the engine's own prefix for this server's prompt commands. */
function promptCommandPrefix(serverName: string): string {
  return `mcp__${getServerPrefix(serverName, "server")}`;
}

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
          const uiValue = Reflect.get(uiTarget, uiProperty, uiReceiver);
          // A person sees MCP state in Settings, not as a status line in a
          // chat (docs/mcp.md); the engine sets only `mcp` and `mcp-auth`.
          if (uiProperty === "setStatus") {
            return (key: string, text: string | undefined) => {
              if (key === "mcp" || key === "mcp-auth") return;
              (uiValue as (key: string, text: string | undefined) => void).call(uiTarget, key, text);
            };
          }
          // Routine progress is `info`; a failure the person must act on is
          // `warning` or `error`, and that still reaches them.
          if (uiProperty === "notify") {
            return (message: string, level: "info" | "warning" | "error" = "info") => {
              if (level === "info") return;
              (uiValue as (message: string, level?: string) => void).call(uiTarget, message, level);
            };
          }
          return typeof uiValue === "function" ? uiValue.bind(uiTarget) : uiValue;
        },
      });
    },
  });
}
