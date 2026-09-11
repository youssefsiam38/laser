/**
 * Laser's server vocabulary → the adapter's `McpConfig` (docs/mcp.md).
 *
 * Pure: configurations in, one isolated snapshot out. Secrets are resolved by
 * the caller and passed beside the configuration, so this module never reads a
 * file and a mapping test never needs one. Everything the adapter could
 * otherwise discover — host configs, imports, its own terminal affordances —
 * is fixed off here, and the fixed settings are the ones docs/mcp.md names.
 */
import type { McpServerConfig, McpStartup, McpToolExposure, McpValue } from "@lasercode/protocol";
// The adapter compiles its shared tool-name helpers to a public subpath, so
// the prefix a tool is registered under is the engine's own answer, not a
// second implementation that can drift from it.
import { formatToolName } from "pi-mcp-adapter/types";
import type { McpConfig, ServerEntry } from "./engine.js";

/** A resolved secret, by the field path the store keys it with. */
export type ResolvedSecrets = Map<string, string>;

/** Field paths a secret can sit at: `auth.token`, `auth.clientSecret`, `transport.env.X`, `transport.headers.X`. */
export function secretFieldPaths(config: McpServerConfig): string[] {
  const paths: string[] = [];
  const transport = config.transport;
  if (transport.kind === "stdio") {
    for (const [key, value] of Object.entries(transport.env ?? {})) if (isSecret(value)) paths.push(`transport.env.${key}`);
  }
  if (transport.kind === "http") {
    for (const [key, value] of Object.entries(transport.headers ?? {})) if (isSecret(value)) paths.push(`transport.headers.${key}`);
  }
  if (config.auth?.kind === "bearer" && isSecret(config.auth.token)) paths.push("auth.token");
  if (config.auth?.kind === "oauth" && config.auth.clientSecret !== undefined && isSecret(config.auth.clientSecret)) paths.push("auth.clientSecret");
  return paths;
}

export function isSecret(value: McpValue | undefined): value is { secret: true } {
  return typeof value === "object" && value !== null && (value as { secret?: unknown }).secret === true;
}

const LIFECYCLE: Record<McpStartup, NonNullable<ServerEntry["lifecycle"]>> = {
  "on-demand": "lazy",
  "on-demand-keep": "lazy-keep-alive",
  "at-start": "eager",
  always: "keep-alive",
};

function directTools(exposure: McpToolExposure, only: string[] | undefined): ServerEntry["directTools"] {
  if (exposure === "search") return "search";
  if (exposure === "on-demand") return false;
  return only && only.length > 0 ? only : true;
}

/** One server. `secrets` maps a field path to its value; a missing one is left unset. */
export function toServerEntry(config: McpServerConfig, secrets: ResolvedSecrets = new Map()): ServerEntry {
  const value = (raw: McpValue | undefined, path: string): string | undefined => {
    if (raw === undefined) return undefined;
    if (!isSecret(raw)) return raw;
    return secrets.get(path);
  };
  const strings = (record: Record<string, McpValue> | undefined, prefix: string): Record<string, string> | undefined => {
    if (!record) return undefined;
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(record)) {
      const resolved = value(raw, `${prefix}.${key}`);
      if (resolved !== undefined) out[key] = resolved;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const entry: ServerEntry = {};
  const transport = config.transport;
  if (transport.kind === "stdio") {
    entry.command = transport.command;
    if (transport.args?.length) entry.args = [...transport.args];
    const env = strings(transport.env, "transport.env");
    if (env) entry.env = env;
    if (transport.cwd) entry.cwd = transport.cwd;
    if (transport.inheritEnv === false) entry.inheritEnv = false;
  } else if (transport.kind === "http") {
    entry.url = transport.url;
    const headers = strings(transport.headers, "transport.headers");
    if (headers) entry.headers = headers;
    if (transport.stream === "sse" || transport.stream === "streamable-http") entry.httpTransport = transport.stream;
    if (transport.caFile) entry.caFile = transport.caFile;
  } else {
    entry.socket = transport.path;
  }

  const auth = config.auth;
  if (auth?.kind === "none") entry.auth = false;
  else if (auth?.kind === "bearer") {
    entry.auth = "bearer";
    const token = value(auth.token, "auth.token");
    if (token !== undefined) entry.bearerToken = token;
  } else if (auth?.kind === "oauth") {
    entry.auth = "oauth";
    const clientSecret = auth.clientSecret === undefined ? undefined : value(auth.clientSecret, "auth.clientSecret");
    const oauth = {
      ...(auth.clientId ? { clientId: auth.clientId } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...(auth.redirectUri ? { redirectUri: auth.redirectUri } : {}),
      ...(auth.authServerMetadataUrl ? { authServerMetadataUrl: auth.authServerMetadataUrl } : {}),
      ...(auth.grantType ? { grantType: auth.grantType } : {}),
    };
    if (Object.keys(oauth).length > 0) entry.oauth = oauth;
  }

  if (config.startup) entry.lifecycle = LIFECYCLE[config.startup];
  const tools = config.tools;
  if (tools) {
    const direct = directTools(tools.exposure, tools.only);
    if (direct !== undefined) entry.directTools = direct;
    if (tools.include?.length) entry.includeTools = [...tools.include];
    if (tools.exclude?.length) entry.excludeTools = [...tools.exclude];
    if (tools.approve !== undefined && tools.approve !== false) {
      entry.approveTools = Array.isArray(tools.approve) ? [...tools.approve] : tools.approve;
    }
  }
  if (config.idleMinutes !== undefined) entry.idleTimeout = config.idleMinutes;
  if (config.requestTimeoutMs !== undefined) entry.requestTimeoutMs = config.requestTimeoutMs;
  if (config.protocolVersion) entry.protocolVersion = config.protocolVersion;
  if (config.resourcesAsTools !== undefined) entry.exposeResources = config.resourcesAsTools;
  if (config.debug) entry.debug = true;
  if (config.disabled) entry.disabled = true;
  return entry;
}

/**
 * What the model's session gets. `settings` is Laser's, always: the person
 * configures servers, never the engine's terminal behaviour (AGENTS.md §6b).
 */
export function toAdapterConfig(
  servers: Array<{ config: McpServerConfig; secrets?: ResolvedSecrets }>,
): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  for (const { config, secrets } of servers) mcpServers[config.name] = toServerEntry(config, secrets ?? new Map());
  return {
    mcpServers,
    settings: {
      toolPrefix: "server",
      showStatusIcon: false,
      mcpFooterStatus: "off",
      notifyOnStartupConnect: false,
      hostConfigDiscovery: "off",
      autoAuth: false,
      sampling: true,
      elicitation: true,
      scriptMode: true,
    },
  };
}

/** The name the model calls a server's tool by, with `toolPrefix: "server"`. */
export function prefixedToolName(serverName: string, originalName: string): string {
  return formatToolName(originalName, serverName, "server");
}
