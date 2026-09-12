/**
 * Every `mcp/*` method for one project (docs/mcp.md "The method table").
 *
 * The worker owns configuration, the inspector's connections and the status a
 * person is shown. Status comes from the inspector's held connection, the
 * newest session snapshot, this worker's last inspection, then the engine's
 * metadata cache — a server's known tool count survives disconnecting. A
 * session's shutdown snapshot is empty by design, so an empty snapshot is
 * treated as "no information" and never blanks a live one.
 */
import { createHash } from "node:crypto";
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
import { McpInspector, toolInfos } from "./inspector.js";
import { isConfigured, McpStore, type EffectiveServer, type McpConfiguredServer } from "./store.js";

export interface McpServiceOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
  /** Broadcast after configuration writes and changes to reported status/counts. */
  changed: () => void;
}

/** One session's newest snapshot, with the moment it arrived. */
interface SessionSnapshot {
  snapshot: McpRuntimeSnapshot;
  at: number;
}

interface RememberedInspection {
  definition: string;
  at: number;
  state: Pick<McpServerState, "status" | "detail" | "toolCount" | "directToolCount" | "resourceCount" | "promptCount" | "latencyMs">;
  toolNames?: string[];
}

export class McpService {
  private readonly store: McpStore;
  private readonly inspector: McpInspector;
  private readonly snapshots = new Map<string, SessionSnapshot>();
  private readonly inspections = new Map<string, RememberedInspection>();
  private readonly drafts = new Map<string, RememberedInspection>();

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
    // The engine republishes on every connect, catalogue refresh and tool-list
    // change; a page that reloads on each of those flickers for no news.
    const previous = this.snapshots.get(sessionPath);
    const unchanged = previous !== undefined && JSON.stringify(previous.snapshot) === JSON.stringify(snapshot);
    this.snapshots.set(sessionPath, { snapshot, at: Date.now() });
    if (!unchanged) this.options.changed();
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
    const key = McpInspector.key(params.scope, params.server.name);
    const definition = inspectionDefinition(params.server);
    const previous = this.inspections.get(McpInspector.key(params.scope, params.originalName ?? params.server.name));
    const draft = this.drafts.get(definition);
    const saved = previous?.definition === definition ? previous : undefined;
    const remembered = draft && (!saved || draft.at > saved.at) ? draft : saved;
    if (params.originalName) this.inspections.delete(McpInspector.key(params.scope, params.originalName));
    if (remembered) this.inspections.set(key, remembered);
    else this.inspections.delete(key);
    this.options.changed();
    return { servers: await this.states() };
  }

  async remove(params: ClientRequests["mcp/remove"]["params"]): Promise<ClientRequests["mcp/remove"]["result"]> {
    await this.store.remove(params.scope, this.options.cwd, params.name);
    await this.inspector.closeServer(params.scope, params.name);
    this.inspections.delete(McpInspector.key(params.scope, params.name));
    this.options.changed();
    return { servers: await this.states() };
  }

  async inspect(params: ClientRequests["mcp/inspect"]["params"]): Promise<McpInspection> {
    return this.reportChanges(async () => {
      if (params.server) {
        // An unsaved definition from the add flow: its secrets are the ones it
        // carries, plus whatever is already stored under the same name.
        const config = params.server as unknown as McpServerConfig;
        if (!isConfigured(config)) throw new ProtocolError(ErrorCodes.InvalidParams, "Choose how to connect to this server before testing it.");
        const secrets = await this.draftSecrets(params.scope, params.server);
        const result = await this.inspector.inspect({ scope: params.scope, config, secrets, ephemeral: true });
        const remembered = this.remember(config, result);
        this.drafts.set(remembered.definition, remembered);
        return result;
      }
      if (!params.name) throw new ProtocolError(ErrorCodes.InvalidParams, "Name the server to inspect, or send the definition to test.");
      const found = await this.find(params.scope, params.name);
      const result = await this.inspector.inspect({ scope: found.scope, config: found.config, secrets: await this.secretsFor(found.config, found.scope) });
      this.inspections.set(McpInspector.key(found.scope, found.config.name), this.remember(found.config, result));
      return result;
    });
  }

  async ping(params: ClientRequests["mcp/ping"]["params"]): Promise<ClientRequests["mcp/ping"]["result"]> {
    return this.reportChanges(async () => {
      const found = await this.find(params.scope, params.name);
      const result = await this.inspector.ping(found.scope, found.config, await this.secretsFor(found.config, found.scope));
      const key = McpInspector.key(found.scope, found.config.name);
      const previous = this.inspections.get(key);
      const { detail: _detail, ...previousState } = previous?.state ?? {};
      this.inspections.set(key, {
        definition: inspectionDefinition(found.config), at: Date.now(),
        ...(previous?.toolNames ? { toolNames: previous.toolNames } : {}),
        state: { ...previousState, ...this.inspector.liveCounts(found.scope, found.config.name), ...result,
          status: result.status === "connected" ? "ready" : result.status },
      });
      return result;
    });
  }

  async call(params: ClientRequests["mcp/call"]["params"]): Promise<ClientRequests["mcp/call"]["result"]> {
    const found = await this.find(params.scope, params.name);
    return this.inspector.call(found.scope, found.config, await this.secretsFor(found.config, found.scope), params.tool, params.args);
  }

  async disconnect(params: ClientRequests["mcp/disconnect"]["params"]): Promise<ClientRequests["mcp/disconnect"]["result"]> {
    return this.reportChanges(async () => {
      await this.inspector.closeServer(params.scope, params.name);
      return {};
    });
  }

  async authStart(params: ClientRequests["mcp/auth/start"]["params"]): Promise<ClientRequests["mcp/auth/start"]["result"]> {
    const found = await this.find(params.scope, params.name);
    const before = await this.reported();
    const started = await this.inspector.authStart(found.scope, found.config, await this.secretsFor(found.config, found.scope), () => {
      // Loopback completion happens outside the request; inspect through the
      // normal path so its notification and reported status agree.
      void this.inspect({ cwd: this.options.cwd, scope: found.scope, name: found.config.name }).catch(() => {});
    });
    if (started.alreadyAuthorized) {
      this.rememberAuth(found.scope, found.config, { status: "ready" });
      if (before !== await this.reported()) this.options.changed();
      return { alreadyAuthorized: true, authorizationUrl: "", callbackListening: false };
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
    const before = await this.reported();
    const result = await this.inspector.authComplete(found.scope, found.config, input);
    this.rememberAuth(found.scope, found.config, result);
    if (before !== await this.reported()) this.options.changed();
    return { status: result.status, ...(result.detail ? { detail: result.detail } : {}) };
  }

  async authLogout(params: ClientRequests["mcp/auth/logout"]["params"]): Promise<ClientRequests["mcp/auth/logout"]["result"]> {
    const found = await this.find(params.scope, params.name);
    const before = await this.reported();
    await this.inspector.authLogout(found.scope, found.config);
    this.rememberAuth(found.scope, found.config, { status: "needs-auth" });
    if (before !== await this.reported()) this.options.changed();
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
      if (server.unsupported) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" ${server.unsupported[0]!.toLowerCase()}${server.unsupported.slice(1)}`);
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

  private rememberAuth(scope: McpScope, config: McpServerConfig, result: { status: McpServerStatus; detail?: string }): void {
    const key = McpInspector.key(scope, config.name);
    const previous = this.inspections.get(key);
    const { detail: _detail, ...previousState } = previous?.state ?? {};
    this.inspections.set(key, { definition: inspectionDefinition(config), at: Date.now(),
      ...(previous?.toolNames ? { toolNames: previous.toolNames } : {}),
      state: { ...previousState, ...result } });
  }

  private remember(config: McpServerConfig, result: McpInspection): RememberedInspection {
    return { definition: inspectionDefinition(config), at: Date.now(),
      toolNames: result.tools.map((tool) => tool.originalName),
      state: { status: result.status === "connected" ? "ready" : result.status,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        toolCount: result.tools.length, directToolCount: result.tools.filter((tool) => tool.visibility === "direct").length,
        resourceCount: result.resources.filter((resource) => !resource.template).length, promptCount: result.prompts.length },
    };
  }

  /** Latency alone is not a status change; repeated inspection must not flicker. */
  private async reported(): Promise<string> {
    return JSON.stringify((await this.states()).map(({ scope, config, status, detail, toolCount, directToolCount, resourceCount, promptCount, inspecting }) =>
      ({ scope, name: config.name, status, detail, toolCount, directToolCount, resourceCount, promptCount, inspecting })));
  }

  private async reportChanges<T>(operation: () => Promise<T>): Promise<T> {
    const before = await this.reported();
    try { return await operation(); }
    finally { if (before !== await this.reported()) this.options.changed(); }
  }

  private async find(scope: McpScope, name: string): Promise<{ scope: McpScope; config: McpConfiguredServer }> {
    const { servers } = await this.store.effective(this.options.cwd, this.options.projectTrusted);
    const exact = servers.find((server) => server.scope === scope && server.config.name === name);
    // A project entry that only switches a global server off carries the
    // global definition, so naming it at project scope still finds a server.
    if (exact && isConfigured(exact.config)) return { scope, config: exact.config };
    const fallback = servers.find((server) => server.config.name === name && isConfigured(server.config));
    if (fallback && isConfigured(fallback.config)) return { scope: fallback.scope, config: fallback.config };
    throw new ProtocolError(ErrorCodes.InvalidParams, `No MCP server named "${name}" is saved for this project.`);
  }

  private async secretsFor(config: McpServerConfig, scope?: McpScope): Promise<ResolvedSecrets> {
    const scopes: McpScope[] = scope ? [scope] : ["project", "global"];
    const values = new Map<string, string>();
    const resolved = await Promise.all(scopes.map(candidate => this.store.secretsFor(candidate, this.options.cwd, config.name)));
    // Promise completion order cannot change project-before-global precedence.
    for (const secrets of resolved) {
      for (const [field, value] of secrets) {
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
      states.push({
        scope: entry.scope,
        // Nothing about it could be trusted, sometimes not even its name; the
        // row exists so a person is told, rather than finding a server
        // silently missing. `label` is what to call it in a list.
        config: { name: entry.name ?? entry.label, ...(entry.name ? {} : { label: entry.label }) },
        status: "failed",
        detail: entry.detail,
      });
    }
    return states;
  }

  private async stateOf(server: EffectiveServer): Promise<McpServerState> {
    const { scope, config } = server;
    // A switch-off row shows the global definition, so its stored secrets are
    // the global ones; reading them at project scope would show every secret
    // field as empty.
    const secretScope: McpScope = server.overridesGlobal ? "global" : scope;
    const present = await this.store.secretPresence(secretScope, this.options.cwd, config.name);
    const state: McpServerState = {
      scope,
      config: withSecretPresence(config, present),
      ...(server.shadowed ? { shadowed: true } : {}),
      ...(server.overridesGlobal ? { overridesGlobal: true } : {}),
      status: "unknown",
    };
    if (config.disabled) return { ...state, status: "off" };
    if (server.shadowed) return { ...state, status: "off", detail: "This project uses its own server of the same name." };

    if (this.inspector.inspecting(scope, config.name)) {
      const latencyMs = this.inspector.latency(scope, config.name);
      return { ...state, ...this.inspector.liveCounts(scope, config.name), status: "connected", inspecting: true,
        ...(latencyMs !== undefined ? { latencyMs } : {}) };
    }
    const runtime = this.runtimeStatus(config.name);
    if (runtime) return { ...state, ...runtime };
    const remembered = this.inspections.get(McpInspector.key(scope, config.name));
    if (remembered?.definition === inspectionDefinition(config)) {
      const directToolCount = remembered.toolNames
        ? toolInfos(config, { tools: remembered.toolNames.map((name) => ({ name })) }).filter((tool) => tool.visibility === "direct").length
        : remembered.state.directToolCount;
      return { ...state, ...remembered.state, ...(directToolCount !== undefined ? { directToolCount } : {}) };
    }
    const cached = await this.inspector.cachedCounts(config.name).catch(() => undefined);
    return { ...state, ...(cached ? { ...cached, status: "ready" } : {}) };
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

/** Stable identity of what was tested, never retaining or hashing secret values. */
export function inspectionDefinition(config: McpServerConfig): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record["secret"] === true) return { secret: true };
      return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, canonical(record[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical({ transport: config.transport, auth: config.auth ?? { kind: "none" } }))).digest("hex");
}

export function isEmptySnapshot(snapshot: McpRuntimeSnapshot): boolean {
  return snapshot.servers.length === 0;
}

export type { McpImportSource };
