/**
 * The inspector (docs/mcp.md "Inspecting"): one connection per server, held
 * outside every session, so a person can see what a server is, ping it and
 * run one of its tools before the model ever calls it.
 *
 * Connections live in the worker, keyed by scope and name, and are closed when
 * the server is saved, removed or disconnected. Nothing here writes a file,
 * and a tool result is bounded in memory — the inspector never spills output
 * to disk the way a session's tool call may.
 */
import type {
  McpCallResult,
  McpInspection,
  McpPromptInfo,
  McpResourceInfo,
  McpScope,
  McpServerCapabilities,
  McpServerConfig,
  McpToolInfo,
  McpToolPolicy,
} from "@lasercode/protocol";
import { getToolNameCandidates, isToolAllowed, matchesToolPattern } from "pi-mcp-adapter/types";
import { prefixedToolName, toServerEntry, type ResolvedSecrets } from "./adapter-config.js";
import type { McpConfiguredServer } from "./store.js";
import { loadMcpEngine, type McpConnection, type McpEngine, type McpEngineResource, type McpManager, type ServerEntry } from "./engine.js";

/** Inline text a person is shown, matching the engine's own 50 KiB guard. */
const MAX_TEXT_BYTES = 51_200;
const CONNECT_TIMEOUT_MS = 30_000;

export interface LiveCounts {
  toolCount: number;
  directToolCount: number;
  resourceCount: number;
  promptCount: number;
}

export interface InspectTarget {
  scope: McpScope;
  config: McpConfiguredServer;
  secrets: ResolvedSecrets;
  /** An unsaved definition from the add flow; closed as soon as it is answered. */
  ephemeral?: boolean;
}

export class McpInspector {
  private engine: McpEngine | undefined;
  private manager: McpManager | undefined;
  private oauthRuntime: unknown;
  /** Definitions of the connections currently held, by key. */
  private readonly held = new Map<string, { name: string; entry: ServerEntry; latencyMs?: number; counts?: LiveCounts }>();
  private ephemeralCounter = 0;

  constructor(private readonly cwd: string) {}

  static key(scope: McpScope, name: string): string {
    return `${scope}:${name}`;
  }

  /** True when a live connection is held for this server right now. */
  inspecting(scope: McpScope, name: string): boolean {
    return this.held.has(McpInspector.key(scope, name));
  }

  latency(scope: McpScope, name: string): number | undefined {
    return this.held.get(McpInspector.key(scope, name))?.latencyMs;
  }

  /** What the held connection actually advertises, for the list's counts. */
  liveCounts(scope: McpScope, name: string): LiveCounts | undefined {
    return this.held.get(McpInspector.key(scope, name))?.counts;
  }

  private async engineOrLoad(): Promise<McpEngine> {
    this.engine ??= await loadMcpEngine();
    return this.engine;
  }

  private async managerOrCreate(): Promise<McpManager> {
    const engine = await this.engineOrLoad();
    if (!this.manager) {
      const manager = new engine.Manager(this.cwd);
      this.oauthRuntime ??= engine.auth.createOAuthRuntime();
      manager.setOAuthRuntime?.(this.oauthRuntime);
      this.manager = manager;
    }
    return this.manager;
  }

  /** Tool counts the engine already knows for a server, without connecting. */
  async cachedCounts(name: string): Promise<{ toolCount: number; resourceCount: number; promptCount: number } | undefined> {
    const engine = await this.engineOrLoad().catch(() => undefined);
    const cached = engine?.cachedServers()[name];
    if (!cached) return undefined;
    return {
      toolCount: cached.tools?.length ?? 0,
      resourceCount: cached.resources?.length ?? 0,
      promptCount: cached.prompts?.length ?? 0,
    };
  }

  /** Connect (or reuse) and describe the server, in the person's vocabulary. */
  async inspect(target: InspectTarget, signal?: AbortSignal): Promise<McpInspection> {
    const { scope, config } = target;
    const key = target.ephemeral ? `draft:${(this.ephemeralCounter += 1)}` : McpInspector.key(scope, config.name);
    const started = Date.now();
    const base: McpInspection = { name: config.name, scope, status: "unknown", tools: [], resources: [], prompts: [] };
    if (config.disabled) {
      return { ...base, status: "off", detail: "This server is turned off. Turn it on to connect and list its tools." };
    }
    try {
      const connection = await this.connect(key, config, target.secrets, signal);
      if (connection.status === "needs-auth") {
        return { ...base, status: "needs-auth", detail: signInDetail(config.name) };
      }
      const latencyMs = Date.now() - started;
      const held = this.held.get(key);
      const tools = toolInfos(config, connection);
      if (held) {
        held.latencyMs = latencyMs;
        held.counts = {
          toolCount: tools.length,
          directToolCount: tools.filter((tool) => tool.visibility === "direct").length,
          resourceCount: connection.resources.length,
          promptCount: connection.prompts.length,
        };
      }
      const client = connection.client;
      const version = safe(() => client.getServerVersion());
      const capabilities = safe(() => client.getServerCapabilities());
      const templates = capabilities?.resources
        ? await client.listResourceTemplates?.().then((result) => result?.resourceTemplates ?? []).catch(() => [])
        : [];
      const inspection: McpInspection = {
        ...base,
        status: "connected",
        ...(version?.name ? { server: { name: version.name, ...(version.version ? { version: version.version } : {}), ...(version.title ? { title: version.title } : {}) } } : {}),
        ...(protocolVersion(client) ? { protocolVersion: protocolVersion(client)! } : {}),
        ...(capabilities ? { capabilities: toCapabilities(capabilities) } : {}),
        ...(connection.instructions ?? safe(() => client.getInstructions()) ? { instructions: (connection.instructions ?? client.getInstructions())! } : {}),
        tools,
        resources: [
          ...connection.resources.map((resource) => toResource(resource, false)),
          ...(templates ?? []).map((template) => toResource(template, true)),
        ],
        prompts: connection.prompts.map(toPrompt),
        latencyMs,
      };
      if (target.ephemeral) await this.close(key);
      return inspection;
    } catch (error) {
      if (target.ephemeral) await this.close(key);
      const failure = describeFailure(error, config.name);
      return { ...base, status: failure.status, detail: failure.detail, ...(failure.stderr ? { stderr: failure.stderr } : {}) };
    }
  }

  /** One `ping` round trip; connects first when nothing is held. */
  async ping(scope: McpScope, config: McpConfiguredServer, secrets: ResolvedSecrets, signal?: AbortSignal): Promise<{ status: McpInspection["status"]; latencyMs?: number; detail?: string }> {
    const key = McpInspector.key(scope, config.name);
    try {
      const connection = await this.connect(key, config, secrets, signal);
      if (connection.status === "needs-auth") return { status: "needs-auth", detail: signInDetail(config.name) };
      const started = Date.now();
      await connection.client.ping();
      const latencyMs = Date.now() - started;
      const held = this.held.get(key);
      if (held) held.latencyMs = latencyMs;
      return { status: "connected", latencyMs };
    } catch (error) {
      const failure = describeFailure(error, config.name);
      return { status: failure.status, detail: failure.detail };
    }
  }

  /** Run one tool on the inspector connection and bound its result. */
  async call(
    scope: McpScope,
    config: McpConfiguredServer,
    secrets: ResolvedSecrets,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const key = McpInspector.key(scope, config.name);
    const started = Date.now();
    try {
      const connection = await this.connect(key, config, secrets, signal);
      if (connection.status === "needs-auth") {
        return { ok: false, durationMs: Date.now() - started, content: [], error: signInDetail(config.name) };
      }
      const original = originalToolName(config.name, tool, connection);
      const result = await connection.client.callTool({ name: original, arguments: args });
      return toCallResult(result, Date.now() - started);
    } catch (error) {
      return { ok: false, durationMs: Date.now() - started, content: [], error: describeFailure(error, config.name).detail };
    }
  }

  /** Begin sign-in. The URL is returned; the worker never opens a browser. */
  async authStart(
    scope: McpScope,
    config: McpConfiguredServer,
    secrets: ResolvedSecrets,
    onComplete: () => void,
  ): Promise<{ authorizationUrl: string; callbackListening: boolean; manualHint?: string; alreadyAuthorized?: boolean }> {
    const engine = await this.engineOrLoad();
    const entry = toServerEntry(config, secrets);
    const url = entry.url;
    if (!url || !engine.auth.supportsOAuth(entry)) {
      throw new Error(`"${config.name}" does not sign in with OAuth. It is reached over ${config.transport.kind === "http" ? "HTTP without sign-in" : "a command"}.`);
    }
    await this.managerOrCreate();
    const options = { runtime: this.oauthRuntime, authStorageOptions: {}, openAuthorizationUrl: () => {} };
    const { authorizationUrl } = await engine.auth.startAuth(config.name, url, entry, options);
    if (!authorizationUrl) return { authorizationUrl: "", callbackListening: false, alreadyAuthorized: true };
    const callbackListening = isLoopbackRedirect(authorizationUrl);
    if (callbackListening) {
      // The engine's own loopback listener finishes the flow; the browser is
      // opened by the app, once, from wherever the person is (docs/mcp.md).
      void engine.auth
        .authenticate(config.name, url, entry, options)
        .then(async (status) => {
          if (status !== "authenticated") return;
          await this.close(McpInspector.key(scope, config.name)).catch(() => {});
          onComplete();
        })
        .catch(() => {});
    }
    return {
      authorizationUrl,
      callbackListening,
      ...(callbackListening ? {} : { manualHint: "Sign in, then copy the address the browser lands on and paste it back here." }),
    };
  }

  /** Finish sign-in from a pasted callback URL or code. */
  async authComplete(scope: McpScope, config: McpConfiguredServer, input: string): Promise<{ status: McpInspection["status"]; detail?: string }> {
    const engine = await this.engineOrLoad();
    await this.managerOrCreate();
    const status = await engine.auth.completeAuthFromInput(config.name, input, { runtime: this.oauthRuntime, authStorageOptions: {} });
    await this.close(McpInspector.key(scope, config.name)).catch(() => {});
    if (status !== "authenticated") {
      return { status: "needs-auth", detail: `Sign-in for "${config.name}" did not complete. Start it again and paste the full address the browser landed on.` };
    }
    return {
      status: "ready",
      detail: `Signed in to "${config.name}". Conversations already running keep the servers they started with; this one is used the next time it connects.`,
    };
  }

  /** Forget stored credentials for a server. */
  async authLogout(scope: McpScope, config: McpConfiguredServer): Promise<void> {
    const engine = await this.engineOrLoad();
    await engine.auth.removeAuth(config.name, { runtime: this.oauthRuntime, authStorageOptions: {} });
    await this.close(McpInspector.key(scope, config.name)).catch(() => {});
  }

  /** Close one connection. Safe when nothing is held. */
  async close(key: string): Promise<void> {
    const held = this.held.get(key);
    this.held.delete(key);
    if (!held || !this.manager) return;
    await this.manager.close(key).catch(() => {});
  }

  async closeServer(scope: McpScope, name: string): Promise<void> {
    await this.close(McpInspector.key(scope, name));
  }

  /** Worker shutdown: every child process the inspector started goes with it. */
  async dispose(): Promise<void> {
    const manager = this.manager;
    this.held.clear();
    this.manager = undefined;
    await manager?.closeAll().catch(() => {});
    const engine = this.engine;
    if (engine && this.oauthRuntime) await Promise.resolve(engine.auth.shutdownOAuth(this.oauthRuntime)).catch(() => {});
    this.oauthRuntime = undefined;
  }

  private async connect(key: string, config: McpConfiguredServer, secrets: ResolvedSecrets, signal?: AbortSignal): Promise<McpConnection> {
    const manager = await this.managerOrCreate();
    const entry = toServerEntry(config, secrets);
    const existing = manager.getConnection(key);
    const held = this.held.get(key);
    if (existing && existing.status === "connected" && held && sameDefinition(held.entry, entry)) return existing;
    if (held && !sameDefinition(held.entry, entry)) await this.close(key);
    const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // The manager keys connections by name; the inspector's key carries the
    // scope, so a project server and a global one of the same name are two
    // connections and never the same child process.
    const connection = await manager.connect(key, entry, combined);
    this.held.set(key, { name: config.name, entry });
    return connection;
  }
}

function sameDefinition(a: ServerEntry, b: ServerEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The revision the handshake settled on, as the MCP client reports it. */
function protocolVersion(client: unknown): string | undefined {
  const value = client as { getNegotiatedProtocolVersion?: () => string | undefined; transport?: { protocolVersion?: string } };
  const negotiated = safe(() => value.getNegotiatedProtocolVersion?.());
  if (typeof negotiated === "string") return negotiated;
  const fromTransport = value.transport?.protocolVersion;
  return typeof fromTransport === "string" ? fromTransport : undefined;
}

function toCapabilities(raw: Record<string, unknown>): McpServerCapabilities {
  const tools = raw["tools"] as { listChanged?: boolean } | undefined;
  return {
    tools: !!tools,
    resources: !!raw["resources"],
    prompts: !!raw["prompts"],
    logging: !!raw["logging"],
    toolListChanged: tools?.listChanged === true,
  };
}

function toResource(resource: McpEngineResource, template: boolean): McpResourceInfo {
  return {
    uri: resource.uri ?? resource.uriTemplate ?? "",
    name: resource.name,
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(template ? { template: true } : {}),
  };
}

function toPrompt(prompt: { name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }): McpPromptInfo {
  return {
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    arguments: (prompt.arguments ?? []).map((argument) => ({
      name: argument.name,
      ...(argument.description ? { description: argument.description } : {}),
      ...(argument.required !== undefined ? { required: argument.required } : {}),
    })),
  };
}

/** Effective visibility and approval under the server's own tool policy. */
export function toolInfos(config: McpServerConfig, connection: Pick<McpConnection, "tools">): McpToolInfo[] {
  const policy: McpToolPolicy = config.tools ?? { exposure: "direct" };
  return connection.tools.map((tool) => {
    const candidates = getToolNameCandidates(tool.name, config.name, "server", false);
    const allowed = isToolAllowed(tool.name, config.name, "server", policy.include, policy.exclude);
    const onlyListed = policy.only && policy.only.length > 0 ? matchesToolPattern(candidates, policy.only) : true;
    const visibility: McpToolInfo["visibility"] = !allowed
      ? "excluded"
      : policy.exposure === "direct" && onlyListed
        ? "direct"
        : "on-demand";
    const approval = policy.approve === true
      || (Array.isArray(policy.approve) && matchesToolPattern(candidates, policy.approve));
    const annotations = toAnnotations(tool.annotations);
    return {
      name: prefixedToolName(config.name, tool.name),
      originalName: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      visibility,
      approval,
      ...(annotations ? { annotations } : {}),
    };
  });
}

function toAnnotations(raw: Record<string, unknown> | undefined): McpToolInfo["annotations"] | undefined {
  if (!raw) return undefined;
  const annotations = {
    ...(typeof raw["readOnlyHint"] === "boolean" ? { readOnly: raw["readOnlyHint"] as boolean } : {}),
    ...(typeof raw["destructiveHint"] === "boolean" ? { destructive: raw["destructiveHint"] as boolean } : {}),
    ...(typeof raw["idempotentHint"] === "boolean" ? { idempotent: raw["idempotentHint"] as boolean } : {}),
    ...(typeof raw["openWorldHint"] === "boolean" ? { openWorld: raw["openWorldHint"] as boolean } : {}),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/** The person may pass the prefixed name or the server's own. */
function originalToolName(serverName: string, tool: string, connection: Pick<McpConnection, "tools">): string {
  if (connection.tools.some((candidate) => candidate.name === tool)) return tool;
  const match = connection.tools.find((candidate) => prefixedToolName(serverName, candidate.name) === tool);
  return match?.name ?? tool;
}

/** The engine's tool result, bounded, in the protocol's own content shapes. */
export function toCallResult(raw: unknown, durationMs: number): McpCallResult {
  const result = (raw ?? {}) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
  const content: McpCallResult["content"] = [];
  let firstText: string | undefined;
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const part = block as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; mimeType?: string; text?: string }; uri?: string };
    if (part.type === "text" && typeof part.text === "string") {
      const { text, truncated } = boundText(part.text);
      firstText ??= part.text;
      content.push({ type: "text", text: truncated ? `${text}\n\n[Output truncated: the server returned more than 50 KB.]` : text });
    } else if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
      content.push({ type: part.type, data: part.data, mimeType: part.mimeType ?? "application/octet-stream" });
    } else if (part.type === "resource") {
      const resource = part.resource ?? {};
      content.push({
        type: "resource",
        uri: resource.uri ?? part.uri ?? "",
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...(typeof resource.text === "string" ? { text: boundText(resource.text).text } : {}),
      });
    } else if (part.type === "resource_link" && typeof part.uri === "string") {
      content.push({ type: "resource", uri: part.uri, ...(part.mimeType ? { mimeType: part.mimeType } : {}) });
    }
  }
  const ok = result.isError !== true;
  return {
    ok,
    durationMs,
    content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(ok ? {} : { error: firstText ?? "The server reported an error but said nothing about it." }),
  };
}

function boundText(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= MAX_TEXT_BYTES) return { text, truncated: false };
  return { text: buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8"), truncated: true };
}

function signInDetail(name: string): string {
  return `"${name}" needs you to sign in before it will answer. Choose Sign in, then finish in your browser.`;
}

/** A failure as a person should read it: the server's own words, no stack. */
export function describeFailure(error: unknown, name: string): { status: McpInspection["status"]; detail: string; stderr?: string[] } {
  if (isAbort(error)) {
    return { status: "failed", detail: `"${name}" did not answer within 30 seconds. Check the command or address, then try again.` };
  }
  const message = messageOf(error);
  const stderr = stderrOf(error);
  if (/unauthor|401|needs? auth|authentication required/i.test(message)) {
    return { status: "needs-auth", detail: signInDetail(name), ...(stderr ? { stderr } : {}) };
  }
  return {
    status: "failed",
    detail: `"${name}" could not be reached: ${message}`,
    ...(stderr ? { stderr } : {}),
  };
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function messageOf(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts = error.errors.map((inner) => messageOf(inner)).filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : cleanMessage(error.message);
  }
  return cleanMessage(error instanceof Error ? error.message : String(error));
}

/** Everything before the first stack frame, on one line, bounded. */
function cleanMessage(raw: string): string {
  const withoutStack = raw.split(/\n\s+at\s+/)[0] ?? raw;
  const line = withoutStack.replace(/\s+/g, " ").trim();
  return line.length > 600 ? `${line.slice(0, 600)}…` : line || "the connection failed without a message.";
}

/** The tail the engine appends in brackets when a stdio server wrote to stderr. */
function stderrOf(error: unknown): string[] | undefined {
  const message = error instanceof Error ? error.message : "";
  const match = /\(([^()]*)\)\s*$/.exec(message);
  if (!match?.[1]) return undefined;
  const lines = match[1].split(" — ").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines.slice(-20) : undefined;
}

/** A loopback redirect means the engine is listening for the callback itself. */
export function isLoopbackRedirect(authorizationUrl: string): boolean {
  try {
    const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (!redirect) return false;
    const host = new URL(redirect).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
