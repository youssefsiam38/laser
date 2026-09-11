/**
 * The MCP engine seam (M14-T2, docs/mcp.md).
 *
 * `pi-mcp-adapter` ships TypeScript as its executable source: its package
 * entry is `index.ts` and only four small subpaths are compiled to `dist`.
 * Node refuses to strip types for files under `node_modules`, so a compiled
 * worker cannot `import("pi-mcp-adapter")` directly — the engine loads its
 * extensions through jiti and so do we, with the same pinned jiti the engine
 * itself depends on. Everything the adapter imports that is plain JavaScript
 * (the engine, the MCP SDK) still resolves natively, so there is exactly one
 * engine instance in the process.
 *
 * Only this file knows where the adapter lives. The rest of the worker sees
 * the narrow structural interfaces below, and nothing above the worker sees
 * the adapter at all (AGENTS.md invariant 1).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpConfig, ServerEntry } from "pi-mcp-adapter/types";

export type { McpConfig, ServerEntry } from "pi-mcp-adapter/types";

/** One live connection the inspector holds, as much of it as the worker uses. */
export interface McpConnection {
  client: McpClient;
  tools: McpEngineTool[];
  resources: McpEngineResource[];
  prompts: McpEnginePrompt[];
  instructions?: string;
  status: "connected" | "closed" | "needs-auth";
}

export interface McpEngineTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}
export interface McpEngineResource {
  uri?: string;
  uriTemplate?: string;
  name: string;
  description?: string;
  mimeType?: string;
}
export interface McpEnginePrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpClient {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: unknown): Promise<unknown>;
  ping(options?: unknown): Promise<unknown>;
  getServerVersion(): { name?: string; version?: string; title?: string } | undefined;
  getServerCapabilities(): Record<string, unknown> | undefined;
  getInstructions(): string | undefined;
  /** The revision the handshake settled on. */
  getNegotiatedProtocolVersion?(): string | undefined;
  listResourceTemplates?(params?: unknown, options?: unknown): Promise<{ resourceTemplates?: McpEngineResource[] }>;
}

export interface McpManager {
  connect(name: string, definition: ServerEntry, signal?: AbortSignal): Promise<McpConnection>;
  close(name: string): Promise<void>;
  closeAll(): Promise<void>;
  getConnection(name: string): McpConnection | undefined;
  setOAuthRuntime?(runtime: unknown): void;
  setAuthStorageOptions?(options: Record<string, unknown>): void;
  setRuntimeSignal?(signal: AbortSignal | undefined): void;
}

export type McpAuthStatusValue = "authenticated" | "not_authenticated" | "expired" | string;

export interface McpAuthOptions {
  runtime?: unknown;
  signal?: AbortSignal;
  /** The caller opens the browser, never the engine (docs/mcp.md "Sign-in"). */
  openAuthorizationUrl?: (url: string) => void | Promise<void>;
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  authStorageOptions?: Record<string, unknown>;
}

export interface McpAuthFlow {
  createOAuthRuntime(signal?: AbortSignal): unknown;
  shutdownOAuth(runtime: unknown): Promise<void> | void;
  startAuth(name: string, url: string, definition?: ServerEntry, options?: McpAuthOptions): Promise<{ authorizationUrl: string }>;
  authenticate(name: string, url: string, definition?: ServerEntry, options?: McpAuthOptions): Promise<McpAuthStatusValue>;
  completeAuthFromInput(name: string, input: string, options?: McpAuthOptions): Promise<McpAuthStatusValue>;
  getAuthStatus(name: string, options?: McpAuthOptions): Promise<McpAuthStatusValue>;
  removeAuth(name: string, options?: McpAuthOptions): Promise<void>;
  supportsOAuth(definition: ServerEntry): boolean;
}

export interface McpCachedServer {
  tools?: Array<{ name?: string; originalName?: string }>;
  resources?: unknown[];
  prompts?: unknown[];
}

export interface McpEngine {
  /** The adapter extension factory, for `extensionFactories` (never file discovery). */
  createMcpAdapter(options: { config: McpConfig }): InlineExtension;
  Manager: new (defaultCwd?: string) => McpManager;
  auth: McpAuthFlow;
  /** Channel the adapter publishes its status snapshots on. */
  statusEvent: string;
  /** Tool counts for a server that has connected before, without connecting. */
  cachedServers(): Record<string, McpCachedServer>;
}

const require = createRequire(import.meta.url);

/** `<package>/dist/types.js` → `<package>`: the manifest itself is not exported. */
export function adapterRoot(): string {
  return dirname(dirname(require.resolve("pi-mcp-adapter/types")));
}

let loading: Promise<McpEngine> | undefined;

/**
 * Load the engine once per worker process. Lazy on purpose: a project with no
 * MCP server must not pay a transpile, and nothing here runs in a session that
 * has no server configured.
 */
export function loadMcpEngine(): Promise<McpEngine> {
  loading ??= (async (): Promise<McpEngine> => {
    const root = adapterRoot();
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { moduleCache: true, interopDefault: true });
    const load = async <T>(file: string): Promise<T> => (await jiti.import(join(root, file))) as T;
    const [index, manager, auth, cache] = await Promise.all([
      load<{ createMcpAdapter: McpEngine["createMcpAdapter"]; MCP_STATUS_EVENT: string }>("index.ts"),
      load<{ McpServerManager: McpEngine["Manager"] }>("server-manager.ts"),
      load<McpAuthFlow>("mcp-auth-flow.ts"),
      import("pi-mcp-adapter/metadata-cache"),
    ]);
    return {
      createMcpAdapter: index.createMcpAdapter,
      Manager: manager.McpServerManager,
      auth,
      statusEvent: index.MCP_STATUS_EVENT,
      cachedServers: () => {
        try {
          const loaded = cache.loadMetadataCache() as { servers?: Record<string, McpCachedServer> } | null;
          return loaded?.servers ?? {};
        } catch {
          return {};
        }
      },
    };
  })();
  return loading;
}

/** Tests only: forget the loaded engine so a fresh process state can be built. */
export function resetMcpEngineForTests(): void {
  loading = undefined;
}
