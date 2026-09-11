/**
 * Every `mcp/*` method for one project (docs/mcp.md "The method table").
 *
 * The worker owns configuration, the inspector's connections and the status a
 * person is shown. Status comes from three places, in this order: the
 * inspector's live knowledge, the newest snapshot a session of this project
 * reported, and the engine's metadata cache — which is what makes a server
 * that has connected once show its tool count without connecting again. A
 * session's shutdown snapshot is empty by design, so an empty snapshot is
 * treated as "no information" and never blanks a live one.
 */
import type {
  ClientRequests,
  McpImportSource,
  McpImportSourceId,
  McpInspection,
  McpRuntimeSnapshot,
  McpScope,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
} from "@lasercode/protocol";
import { ErrorCodes, ProtocolError } from "@lasercode/protocol";
import { secretFieldPaths, type ResolvedSecrets } from "./adapter-config.js";
import { detectImportSources, inlineSecretValues, markConflicts, readSourceEntries } from "./import.js";
import { McpInspector } from "./inspector.js";
import { McpStore, type EffectiveServer } from "./store.js";

export interface McpServiceOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
  /** Broadcast after every configuration write and every sign-in. */
  changed: () => void;
}

/** One session's newest snapshot, with the moment it arrived. */
interface SessionSnapshot {
  snapshot: McpRuntimeSnapshot;
  at: number;
}

export class McpService {
  private readonly store: McpStore;
  private readonly inspector: McpInspector;
  private readonly snapshots = new Map<string, SessionSnapshot>();

  constructor(private readonly options: McpServiceOptions) {
    this.store = new McpStore(options.agentDir);
    this.inspector = new McpInspector(options.cwd);
  }

  /** The store, for the driver's "does this project have any server" question. */
  configuration(): McpStore {
    return this.store;
  }

  /** A snapshot a session reported. An empty one carries no information. */
  observeSnapshot(sessionPath: string, snapshot: McpRuntimeSnapshot): void {
    if (snapshot.servers.length === 0) {
      this.snapshots.delete(sessionPath);
      return;
    }
    this.snapshots.set(sessionPath, { snapshot, at: Date.now() });
    this.options.changed();
  }

  sessionClosed(sessionPath: string): void {
    this.snapshots.delete(sessionPath);
  }

  async dispose(): Promise<void> {
    await this.inspector.dispose();
  }

  // -------------------------------------------------------------- methods

  async list(): Promise<ClientRequests["mcp/list"]["result"]> {
    return { servers: await this.states() };
  }

  async save(params: ClientRequests["mcp/save"]["params"]): Promise<ClientRequests["mcp/save"]["result"]> {
    await this.store.save(params.scope, this.options.cwd, params.server, params.originalName);
    await this.inspector.closeServer(params.scope, params.originalName ?? params.server.name);
    if (params.originalName && params.originalName !== params.server.name) {
      await this.inspector.closeServer(params.scope, params.server.name);
    }
    this.options.changed();
    return { servers: await this.states() };
  }

  async remove(params: ClientRequests["mcp/remove"]["params"]): Promise<ClientRequests["mcp/remove"]["result"]> {
    await this.store.remove(params.scope, this.options.cwd, params.name);
    await this.inspector.closeServer(params.scope, params.name);
    this.options.changed();
    return { servers: await this.states() };
  }

  async inspect(params: ClientRequests["mcp/inspect"]["params"]): Promise<McpInspection> {
    if (params.server) {
      // An unsaved definition from the add flow: its secrets are the ones it
      // carries, plus whatever is already stored under the same name.
      const config = params.server as unknown as McpServerConfig;
      const secrets = await this.draftSecrets(params.scope, params.server);
      return this.inspector.inspect({ scope: params.scope, config, secrets, ephemeral: true });
    }
    if (!params.name) throw new ProtocolError(ErrorCodes.InvalidParams, "Name the server to inspect, or send the definition to test.");
    const found = await this.find(params.scope, params.name);
    return this.inspector.inspect({ scope: found.scope, config: found.config, secrets: await this.secretsFor(found.config, found.scope) });
  }

  async ping(params: ClientRequests["mcp/ping"]["params"]): Promise<ClientRequests["mcp/ping"]["result"]> {
    const found = await this.find(params.scope, params.name);
    return this.inspector.ping(found.scope, found.config, await this.secretsFor(found.config, found.scope));
  }

  async call(params: ClientRequests["mcp/call"]["params"]): Promise<ClientRequests["mcp/call"]["result"]> {
    const found = await this.find(params.scope, params.name);
    return this.inspector.call(found.scope, found.config, await this.secretsFor(found.config, found.scope), params.tool, params.args);
  }

  async disconnect(params: ClientRequests["mcp/disconnect"]["params"]): Promise<ClientRequests["mcp/disconnect"]["result"]> {
    await this.inspector.closeServer(params.scope, params.name);
    return {};
  }

  async authStart(params: ClientRequests["mcp/auth/start"]["params"]): Promise<ClientRequests["mcp/auth/start"]["result"]> {
    const found = await this.find(params.scope, params.name);
    const started = await this.inspector.authStart(found.scope, found.config, await this.secretsFor(found.config, found.scope), () => this.options.changed());
    if (started.alreadyAuthorized) {
      this.options.changed();
      return { authorizationUrl: "", callbackListening: false, manualHint: `"${found.config.name}" is already signed in.` };
    }
    return {
      authorizationUrl: started.authorizationUrl,
      callbackListening: started.callbackListening,
      ...(started.manualHint ? { manualHint: started.manualHint } : {}),
    };
  }

  async authComplete(params: ClientRequests["mcp/auth/complete"]["params"]): Promise<ClientRequests["mcp/auth/complete"]["result"]> {
    const found = await this.find(params.scope, params.name);
    const input = params.redirectUrl ?? params.code;
    if (!input) throw new ProtocolError(ErrorCodes.InvalidParams, "Paste the address the browser landed on, or the code it showed.");
    const result = await this.inspector.authComplete(found.scope, found.config, input);
    if (result.status !== "needs-auth") this.options.changed();
    return { status: result.status, ...(result.detail ? { detail: result.detail } : {}) };
  }

  async authLogout(params: ClientRequests["mcp/auth/logout"]["params"]): Promise<ClientRequests["mcp/auth/logout"]["result"]> {
    const found = await this.find(params.scope, params.name);
    await this.inspector.authLogout(found.scope, found.config);
    this.options.changed();
    return { status: "needs-auth" };
  }

  async importDetect(): Promise<ClientRequests["mcp/import/detect"]["result"]> {
    const sources = await detectImportSources(this.options.cwd);
    const existing = await this.existingNames();
    return { sources: sources.map((source) => ({ ...source, servers: markConflicts(source.servers, existing) })) };
  }

  async importApply(params: ClientRequests["mcp/import/apply"]["params"]): Promise<ClientRequests["mcp/import/apply"]["result"]> {
    const sources = await detectImportSources(this.options.cwd);
    const source = sources.find((candidate) => candidate.id === params.source);
    if (!source) throw new ProtocolError(ErrorCodes.InvalidParams, "That configuration is no longer on this machine. Look again.");
    const entries = await readSourceEntries(source.path, params.source as McpImportSourceId);
    const existing = await this.existingNames();
    const imported: string[] = [];
    for (const name of params.names) {
      const server = source.servers.find((candidate) => candidate.name === name);
      if (!server) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is not in ${source.label} any more.`);
      if (server.unsupported) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" cannot be imported: ${server.unsupported}`);
      const conflicts = existing.get(params.scope)?.has(name) === true;
      if (conflicts && !params.replace) {
        throw new ProtocolError(ErrorCodes.InvalidParams, `A server named "${name}" already exists here. Choose Replace to overwrite it.`);
      }
      const values = inlineSecretValues(entries[name], params.source as McpImportSourceId);
      const withSecrets = structuredClone(server.config) as McpServerConfig;
      await this.store.save(params.scope, this.options.cwd, withInlineSecrets(withSecrets, values) as never, conflicts ? name : undefined);
      imported.push(name);
    }
    if (imported.length > 0) this.options.changed();
    return { servers: await this.states(), imported };
  }

  // ------------------------------------------------------------ internals

  private async find(scope: McpScope, name: string): Promise<{ scope: McpScope; config: McpServerConfig }> {
    const { servers } = await this.store.effective(this.options.cwd, this.options.projectTrusted);
    const exact = servers.find((server) => server.scope === scope && server.config.name === name);
    // A project entry that only switches a global server off names a server
    // whose definition is the global one; inspecting it inspects that.
    if (exact && (exact.config as { transport?: unknown }).transport !== undefined) return { scope, config: exact.config };
    const fallback = servers.find((server) => server.config.name === name && (server.config as { transport?: unknown }).transport !== undefined);
    if (fallback) return { scope: fallback.scope, config: fallback.config };
    throw new ProtocolError(ErrorCodes.InvalidParams, `No MCP server named "${name}" is saved for this project.`);
  }

  private async secretsFor(config: McpServerConfig, scope?: McpScope): Promise<ResolvedSecrets> {
    const scopes: McpScope[] = scope ? [scope] : ["project", "global"];
    const values = new Map<string, string>();
    for (const candidate of scopes) {
      for (const [field, value] of await this.store.secretsFor(candidate, this.options.cwd, config.name)) {
        if (!values.has(field)) values.set(field, value);
      }
    }
    return values;
  }

  /** Draft secrets: new values in the request win over anything stored. */
  private async draftSecrets(scope: McpScope, input: ClientRequests["mcp/save"]["params"]["server"]): Promise<ResolvedSecrets> {
    const stored = await this.store.secretsFor(scope, this.options.cwd, input.name);
    const values = new Map(stored);
    const take = (value: unknown, field: string) => {
      const secret = value as { secret?: boolean; value?: string } | undefined;
      if (secret?.secret === true && typeof secret.value === "string") values.set(field, secret.value);
      else if (typeof value === "string") values.delete(field);
    };
    const transport = input.transport as { env?: Record<string, unknown>; headers?: Record<string, unknown> };
    for (const [key, value] of Object.entries(transport.env ?? {})) take(value, `transport.env.${key}`);
    for (const [key, value] of Object.entries(transport.headers ?? {})) take(value, `transport.headers.${key}`);
    if (input.auth?.kind === "bearer") take(input.auth.token, "auth.token");
    if (input.auth?.kind === "oauth" && input.auth.clientSecret !== undefined) take(input.auth.clientSecret, "auth.clientSecret");
    return values;
  }

  private async existingNames(): Promise<Map<McpScope, Set<string>>> {
    const [globals, projects] = await Promise.all([
      this.store.read("global", this.options.cwd),
      this.store.read("project", this.options.cwd, this.options.projectTrusted),
    ]);
    return new Map<McpScope, Set<string>>([
      ["global", new Set(globals.servers.map((server) => server.name))],
      ["project", new Set(projects.servers.map((server) => server.name))],
    ]);
  }

  /** The newest snapshot any session of this project reported for a server. */
  private runtimeStatus(name: string): { status: McpServerStatus; toolCount?: number; directToolCount?: number; resourceCount?: number; failedAgoSeconds?: number } | undefined {
    let newest: { at: number; server: McpRuntimeSnapshot["servers"][number] } | undefined;
    for (const { snapshot, at } of this.snapshots.values()) {
      const server = snapshot.servers.find((candidate) => candidate.name === name);
      if (server && (!newest || at > newest.at)) newest = { at, server };
    }
    if (!newest) return undefined;
    const { server } = newest;
    return {
      status: server.status,
      toolCount: server.toolCount,
      directToolCount: server.directToolCount,
      ...(server.resourceCount !== undefined ? { resourceCount: server.resourceCount } : {}),
      ...(server.failedAgoSeconds !== undefined ? { failedAgoSeconds: server.failedAgoSeconds } : {}),
    };
  }

  private async states(): Promise<McpServerState[]> {
    const { servers, malformed } = await this.store.effective(this.options.cwd, this.options.projectTrusted);
    const states: McpServerState[] = [];
    for (const server of servers) states.push(await this.stateOf(server));
    for (const entry of malformed) {
      if (!entry.name) continue;
      states.push({
        scope: entry.scope,
        config: { name: entry.name, transport: { kind: "stdio", command: "" } },
        status: "failed",
        detail: entry.detail,
      });
    }
    return states;
  }

  private async stateOf(server: EffectiveServer): Promise<McpServerState> {
    const { scope, config } = server;
    const present = await this.store.secretPresence(scope, this.options.cwd, config.name);
    const state: McpServerState = {
      scope,
      config: withSecretPresence(config, present),
      ...(server.shadowed ? { shadowed: true } : {}),
      ...(server.overridesGlobal ? { overridesGlobal: true } : {}),
      status: "unknown",
    };
    if (config.disabled) return { ...state, status: "off" };
    if (server.shadowed) return { ...state, status: "off", detail: "This project uses its own server of the same name." };

    const inspecting = this.inspector.inspecting(scope, config.name);
    const latencyMs = this.inspector.latency(scope, config.name);
    const runtime = this.runtimeStatus(config.name);
    const cached = await this.inspector.cachedCounts(config.name).catch(() => undefined);
    const status: McpServerStatus = inspecting
      ? "connected"
      : runtime?.status ?? (cached && cached.toolCount > 0 ? "ready" : "unknown");
    return {
      ...state,
      status,
      ...(runtime?.toolCount !== undefined ? { toolCount: runtime.toolCount } : cached ? { toolCount: cached.toolCount } : {}),
      ...(runtime?.directToolCount !== undefined ? { directToolCount: runtime.directToolCount } : {}),
      ...(runtime?.resourceCount !== undefined ? { resourceCount: runtime.resourceCount } : cached ? { resourceCount: cached.resourceCount } : {}),
      ...(cached?.promptCount ? { promptCount: cached.promptCount } : {}),
      ...(runtime?.failedAgoSeconds !== undefined ? { failedAgoSeconds: runtime.failedAgoSeconds } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(inspecting ? { inspecting: true } : {}),
    };
  }
}

/** Report whether a stored secret exists, never the value. */
function withSecretPresence(config: McpServerConfig, present: Set<string>): McpServerConfig {
  const copy = structuredClone(config) as McpServerConfig;
  for (const field of secretFieldPaths(copy)) {
    const target = fieldOwner(copy, field);
    if (target) target.owner[target.key] = { secret: true, present: present.has(field) };
  }
  return copy;
}

function fieldOwner(config: McpServerConfig, field: string): { owner: Record<string, unknown>; key: string } | undefined {
  const parts = field.split(".");
  if (parts[0] === "auth" && parts[1]) return config.auth ? { owner: config.auth as unknown as Record<string, unknown>, key: parts[1] } : undefined;
  if (parts[0] === "transport" && parts[1] && parts[2] !== undefined) {
    const container = (config.transport as unknown as Record<string, Record<string, unknown>>)[parts[1]];
    // A key may itself contain a dot; the field path keeps everything after
    // the container name.
    return container ? { owner: container, key: parts.slice(2).join(".") } : undefined;
  }
  return undefined;
}

/** Put an imported inline value back as a save-time secret input. */
function withInlineSecrets(config: McpServerConfig, values: Map<string, string>): McpServerConfig {
  const copy = structuredClone(config) as McpServerConfig;
  for (const [field, value] of values) {
    const target = fieldOwner(copy, field);
    if (target && target.owner[target.key] !== undefined) target.owner[target.key] = { secret: true, value };
  }
  return copy;
}

export function isEmptySnapshot(snapshot: McpRuntimeSnapshot): boolean {
  return snapshot.servers.length === 0;
}

export type { McpImportSource };
