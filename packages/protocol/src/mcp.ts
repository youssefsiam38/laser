/**
 * MCP servers — Laser's own vocabulary (docs/mcp.md).
 *
 * The engine underneath is an exact-pinned upstream adapter; nothing above the
 * worker knows its field names. Everything here is what a person configures
 * and what a person is shown. Secrets never travel in a status response.
 */

import type { FeatureScope } from "./features.js";

export type McpScope = FeatureScope;

// ---------------------------------------------------------------------------
// Values and secrets

/**
 * A configured value that is kept out of the config file. In a response,
 * `present` says whether a value is stored for it; in a save request a plain
 * `{ secret: true }` keeps the stored value, and `McpSecretInput` replaces it.
 */
export interface McpSecretRef {
  secret: true;
  present?: boolean;
}
export interface McpSecretInput {
  secret: true;
  value: string;
}
/** Stored and reported. `${VAR}` / `$env:VAR` references stay literal strings. */
export type McpValue = string | McpSecretRef;
/** Accepted by `mcp/save`. */
export type McpValueInput = string | McpSecretRef | McpSecretInput;

// ---------------------------------------------------------------------------
// Transport, auth, policy

export type McpStdioTransport<V = McpValue> = {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, V>;
  cwd?: string;
  /** Default true: the app's environment reaches the child. */
  inheritEnv?: boolean;
};
export type McpHttpTransport<V = McpValue> = {
  kind: "http";
  url: string;
  headers?: Record<string, V>;
  /** `auto` negotiates Streamable HTTP with SSE fallback. */
  stream?: "auto" | "streamable-http" | "sse";
  /** PEM CA bundle for this origin only. */
  caFile?: string;
};
export type McpSocketTransport = {
  kind: "socket";
  path: string;
};
export type McpTransport<V = McpValue> = McpStdioTransport<V> | McpHttpTransport<V> | McpSocketTransport;
export type McpTransportKind = McpTransport["kind"];

export type McpAuth<V = McpValue> =
  | { kind: "none" }
  | { kind: "bearer"; token: V }
  | {
      kind: "oauth";
      clientId?: string;
      clientSecret?: V;
      scope?: string;
      redirectUri?: string;
      authServerMetadataUrl?: string;
      grantType?: "authorization_code" | "client_credentials";
    };
export type McpAuthKind = McpAuth["kind"];

/** When a server's process or connection starts, in words a person chooses between. */
export const MCP_STARTUP_MODES = ["on-demand", "on-demand-keep", "at-start", "always"] as const;
export type McpStartup = (typeof MCP_STARTUP_MODES)[number];

/** How a server's tools reach the model. */
export const MCP_TOOL_EXPOSURES = ["direct", "on-demand", "search"] as const;
export type McpToolExposure = (typeof MCP_TOOL_EXPOSURES)[number];

export interface McpToolPolicy {
  exposure: McpToolExposure;
  /** With `direct`: only these original tool names are direct; the rest stay on demand. */
  only?: string[];
  /** Names or globs; tools not matched do not exist for this server. */
  include?: string[];
  /** Names or globs; applied after `include`. */
  exclude?: string[];
  /** `true` asks before every call; a list asks for matching names or globs. */
  approve?: boolean | string[];
}

export const MCP_PROTOCOL_VERSIONS = ["legacy", "auto", "2026-07-28"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

// ---------------------------------------------------------------------------
// One server

export interface McpServerConfigBase<V = McpValue> {
  /** Unique within its scope; letters, digits, `-` and `_`. It prefixes the server's tool names. */
  name: string;
  /** What a person sees; defaults to `name`. */
  label?: string;
  /**
   * Absent only on a project entry that does nothing but switch a global
   * server off for that project: `{ name, disabled: true }` (docs/mcp.md).
   * Every other entry carries one.
   */
  transport?: McpTransport<V>;
  /** HTTP only. Absent means `none` for stdio and socket, and auto-detected sign-in for HTTP. */
  auth?: McpAuth<V>;
  startup?: McpStartup;
  tools?: McpToolPolicy;
  idleMinutes?: number;
  requestTimeoutMs?: number;
  protocolVersion?: McpProtocolVersion;
  /** Expose the server's resources as read tools (default true). */
  resourcesAsTools?: boolean;
  debug?: boolean;
  /** Kept in the file, never started. A project entry with only `name` and `disabled` switches a global server off there. */
  disabled?: boolean;
  /** Which curated entry this came from, when it did. */
  catalogId?: string;
}
/** As stored and as reported: secrets are references. */
export type McpServerConfig = McpServerConfigBase<McpValue>;
/** As accepted by `mcp/save`: secrets may carry a new value. */
export type McpServerConfigInput = McpServerConfigBase<McpValueInput>;

/** Plain words for a person; the engine's internal states collapse into these. */
export const MCP_SERVER_STATUSES = ["connected", "ready", "starting", "needs-auth", "failed", "off", "unknown"] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export interface McpServerState {
  scope: McpScope;
  config: McpServerConfig;
  /**
   * On a global row: a project entry of the same name exists, so this
   * definition is not what this project uses (replaced, or switched off).
   */
  shadowed?: boolean;
  /**
   * On a project row: this entry carries no definition of its own; it only
   * switches the global server off for this project. Its `config` is the
   * global definition with `disabled: true`, so the row reads like the server
   * it switches off.
   */
  overridesGlobal?: boolean;
  status: McpServerStatus;
  /** From the newest session snapshot or the inspector, when either has seen the server. */
  toolCount?: number;
  directToolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  /** Seconds since the failure that produced `failed`. */
  failedAgoSeconds?: number;
  /** Why it failed or needs attention, written for a person. */
  detail?: string;
  /** Milliseconds, from the last `mcp/ping` or inspect. */
  latencyMs?: number;
  /** The inspector holds a live connection to it right now. */
  inspecting?: boolean;
}

// ---------------------------------------------------------------------------
// Inspection

export interface McpToolInfo {
  /** The name the model calls (prefixed). */
  name: string;
  /** The server's own name for it. */
  originalName: string;
  title?: string;
  description: string;
  /** JSON Schema, as the server advertised it. */
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Effective visibility under the server's tool policy. */
  visibility: "direct" | "on-demand" | "excluded";
  /** A call asks the person first under the server's policy. */
  approval: boolean;
  /** Advertised annotations: read-only, destructive, idempotent, open-world. */
  annotations?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** A URI template rather than one resource. */
  template?: boolean;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  logging: boolean;
  /** Tool-list change notifications. */
  toolListChanged: boolean;
}

export interface McpInspection {
  name: string;
  scope: McpScope;
  status: McpServerStatus;
  /** From the server's `initialize` result. */
  server?: { name: string; version?: string; title?: string };
  protocolVersion?: string;
  capabilities?: McpServerCapabilities;
  /** The usage instructions the server publishes, verbatim. */
  instructions?: string;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  /** Time to connect and list, milliseconds. */
  latencyMs?: number;
  /** A failure or sign-in requirement, written for a person. */
  detail?: string;
  /** The last lines the server wrote to stderr, when it failed. */
  stderr?: string[];
}

/** A tool result as the server returned it, with the engine's own guard applied. */
export interface McpCallResult {
  ok: boolean;
  durationMs: number;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
    | { type: "resource"; uri: string; mimeType?: string; text?: string }
  >;
  structuredContent?: unknown;
  /** Error text when `ok` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Sign-in

export interface McpAuthStart {
  /** Open this in a browser. */
  authorizationUrl: string;
  /** The app listens on a loopback callback; completion arrives on its own. */
  callbackListening: boolean;
  /** Where the browser lands when the callback cannot reach the app, for pasting back. */
  manualHint?: string;
}

// ---------------------------------------------------------------------------
// Import

export const MCP_IMPORT_SOURCES = [
  "project-mcp-json",
  "shared-global",
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "windsurf",
  "codex",
  "opencode",
] as const;
export type McpImportSourceId = (typeof MCP_IMPORT_SOURCES)[number];

export interface McpImportServer {
  name: string;
  config: McpServerConfig;
  /** The same name already exists in Laser at this scope. */
  conflicts: McpScope[];
  /** A secret was found inline in the source file; it will be moved to the secrets store. */
  inlineSecrets: string[];
  /** Skipped: what the source declares that Laser cannot represent. */
  unsupported?: string;
}

export interface McpImportSource {
  id: McpImportSourceId;
  /** e.g. `Claude Code`, `Project .mcp.json`. */
  label: string;
  path: string;
  servers: McpImportServer[];
}

// ---------------------------------------------------------------------------
// Curated catalog

export interface McpCatalogOption {
  id: string;
  label: string;
  description: string;
  /** Appended to `args` when on. */
  arg: string;
  default: boolean;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage: string;
  /** What the machine needs, in a sentence, when it needs anything. */
  requires?: string;
  /** Sign-in the server will ask for. */
  auth?: McpAuthKind;
  config: Omit<McpServerConfig, "name" | "catalogId">;
  options?: McpCatalogOption[];
}

export const MCP_KNOWN_SERVERS: readonly McpCatalogEntry[] = [
  {
    id: "playwright",
    name: "Playwright",
    description: "Drive a real browser: open pages, click, type, read the page as the model sees it, take screenshots. The most used MCP server for testing web apps.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    requires: "Google Chrome, or run once with the Chromium it can install for itself.",
    config: {
      transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
    options: [
      {
        id: "isolated",
        label: "Fresh browser per conversation",
        description: "Each conversation gets its own browser profile, so several can drive a browser at once. Turn off to keep logins between conversations, which also means one conversation at a time.",
        arg: "--isolated",
        default: true,
      },
      {
        id: "headless",
        label: "Hide the browser window",
        description: "Run the browser without a window. Leave off to watch the model work.",
        arg: "--headless",
        default: false,
      },
    ],
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description: "Inspect a running Chrome: performance traces, network requests, console output, screenshots.",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    requires: "Google Chrome.",
    config: {
      transport: { kind: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
  },
  {
    id: "context7",
    name: "Context7",
    description: "Current documentation and code examples for libraries, fetched by version.",
    homepage: "https://context7.com",
    config: {
      transport: { kind: "http", url: "https://mcp.context7.com/mcp" },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about any public GitHub repository and read its generated documentation.",
    homepage: "https://deepwiki.com",
    config: {
      transport: { kind: "http", url: "https://mcp.deepwiki.com/mcp" },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, code search and repository data from your GitHub account.",
    homepage: "https://github.com/github/github-mcp-server",
    auth: "oauth",
    config: {
      transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
      auth: { kind: "oauth" },
      startup: "on-demand",
      tools: { exposure: "on-demand" },
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search and edit pages and databases in your Notion workspace.",
    homepage: "https://developers.notion.com/docs/mcp",
    auth: "oauth",
    config: {
      transport: { kind: "http", url: "https://mcp.notion.com/mcp" },
      auth: { kind: "oauth" },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles from your Linear workspace.",
    homepage: "https://linear.app/docs/mcp",
    auth: "oauth",
    config: {
      transport: { kind: "http", url: "https://mcp.linear.app/mcp" },
      auth: { kind: "oauth" },
      startup: "on-demand",
      tools: { exposure: "direct" },
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Errors, traces and releases from your Sentry organisation.",
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
    auth: "oauth",
    config: {
      transport: { kind: "http", url: "https://mcp.sentry.dev/mcp" },
      auth: { kind: "oauth" },
      startup: "on-demand",
      tools: { exposure: "on-demand" },
    },
  },
] as const;

/** Direct exposure is the default for a server with this many tools or fewer. */
export const MCP_DIRECT_EXPOSURE_MAX_TOOLS = 40;

// ---------------------------------------------------------------------------
// Runtime snapshot from the companion module (engine-neutral copy)

export interface McpRuntimeServer {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  directToolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
}
export interface McpRuntimeSnapshot {
  servers: McpRuntimeServer[];
  totalTools: number;
  connectedCount: number;
}

// ---------------------------------------------------------------------------
// Wire

declare module "./messages.js" {
  interface ClientRequests {
    /** Both scopes for this project. Changes apply to sessions started afterwards (D-221). */
    "mcp/list": { params: { cwd: string }; result: { servers: McpServerState[] } };
    "mcp/save": {
      params: { cwd: string; scope: McpScope; server: McpServerConfigInput; /** Rename: the entry this replaces. */ originalName?: string };
      result: { servers: McpServerState[] };
    };
    "mcp/remove": { params: { cwd: string; scope: McpScope; name: string }; result: { servers: McpServerState[] } };
    "mcp/inspect": {
      /** `server` inspects an unsaved definition (the add flow); `name` inspects a saved one. */
      params: { cwd: string; scope: McpScope; name?: string; server?: McpServerConfigInput };
      result: McpInspection;
    };
    "mcp/ping": { params: { cwd: string; scope: McpScope; name: string }; result: { status: McpServerStatus; latencyMs?: number; detail?: string } };
    "mcp/call": {
      params: { cwd: string; scope: McpScope; name: string; tool: string; args: Record<string, unknown> };
      result: McpCallResult;
    };
    "mcp/disconnect": { params: { cwd: string; scope: McpScope; name: string }; result: {} };
    "mcp/auth/start": { params: { cwd: string; scope: McpScope; name: string }; result: McpAuthStart };
    "mcp/auth/complete": {
      params: { cwd: string; scope: McpScope; name: string; redirectUrl?: string; code?: string };
      result: { status: McpServerStatus; detail?: string };
    };
    "mcp/auth/logout": { params: { cwd: string; scope: McpScope; name: string }; result: { status: McpServerStatus } };
    "mcp/import/detect": { params: { cwd: string }; result: { sources: McpImportSource[] } };
    "mcp/import/apply": {
      params: { cwd: string; source: McpImportSourceId; names: string[]; scope: McpScope; /** Replace entries whose names conflict. */ replace?: boolean };
      result: { servers: McpServerState[]; imported: string[] };
    };
  }
  interface HostNotifications {
    /** A configuration write or a status change for this project; reload `mcp/list`. */
    "mcp/changed": { cwd: string };
  }
}
