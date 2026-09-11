/**
 * Importing what other tools left on this machine (docs/mcp.md "Importing").
 *
 * Laser reads those files, never writes them. The engine owns where they are —
 * `findAvailableImportConfigs` is its own discovery table — and this module
 * owns the translation into Laser's vocabulary, because the engine's reader
 * for a host file is internal to it. Anything a source declares that Laser
 * cannot represent is reported as unsupported, in a sentence, rather than
 * being imported as something it is not.
 *
 * A credential found inline becomes `{ secret: true }` in the configuration
 * and its value is moved into the secrets store when the import is applied.
 */
import type {
  McpAuth,
  McpImportServer,
  McpImportSource,
  McpImportSourceId,
  McpScope,
  McpServerConfig,
  McpTransport,
  McpValue,
} from "@lasercode/protocol";
import { MCP_SERVER_NAME_PATTERN, PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { findAvailableImportConfigs } from "pi-mcp-adapter/config";

/** Header and environment names that hold a credential rather than a setting. */
const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key)$/i;

const LABELS: Record<McpImportSourceId, string> = {
  "project-mcp-json": "This project's .mcp.json",
  "shared-global": "Shared MCP configuration",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Where a source's servers live inside its file, by source. */
function serversOf(raw: unknown, id: McpImportSourceId): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) return {};
  const candidate = id === "codex"
    ? record["mcp_servers"] ?? record["mcpServers"]
    : id === "opencode"
      ? record["mcp"]
      : record["mcpServers"] ?? record["mcp-servers"] ?? record["servers"];
  return asRecord(candidate) ?? {};
}

async function readSource(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const clean = text.replace(/^\uFEFF/, "");
  if (path.endsWith(".toml")) {
    try {
      return parseToml(clean) as unknown;
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(stripJsonComments(clean)) as unknown;
  } catch {
    return undefined;
  }
}

/** `//` and `/* *\/` comments, as VS Code and Cursor write them. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** Every source found on this machine, with its servers already translated. */
export async function detectImportSources(cwd: string): Promise<McpImportSource[]> {
  const candidates: Array<{ id: McpImportSourceId; path: string }> = [
    { id: "project-mcp-json", path: join(resolve(cwd), ".mcp.json") },
  ];
  // The shared file has two conventional homes; the first that exists wins,
  // in the engine's own precedence order.
  for (const path of [join(homedir(), ".config", "mcp", "mcp.json"), join(homedir(), ".agents", "mcp.json")]) {
    if (candidates.some((candidate) => candidate.id === "shared-global")) break;
    if (existsSync(path)) candidates.push({ id: "shared-global", path });
  }
  // The engine owns the host-config discovery table; only its reading is ours.
  let discovered: Array<{ kind: string; path: string }> = [];
  try {
    discovered = findAvailableImportConfigs(resolve(cwd)) as Array<{ kind: string; path: string }>;
  } catch {
    discovered = [];
  }
  for (const entry of discovered) {
    const id = entry.kind as McpImportSourceId;
    if (id in LABELS && !candidates.some((candidate) => candidate.id === id)) candidates.push({ id, path: entry.path });
  }

  const sources: McpImportSource[] = [];
  for (const candidate of candidates) {
    const raw = await readSource(candidate.path);
    if (raw === undefined) continue;
    const servers: McpImportServer[] = [];
    for (const [name, entry] of Object.entries(serversOf(raw, candidate.id))) {
      const translated = translate(name, entry, candidate.id);
      if (translated) servers.push(translated);
    }
    if (servers.length > 0) sources.push({ id: candidate.id, label: LABELS[candidate.id], path: candidate.path, servers });
  }
  return sources;
}

/** One foreign entry in Laser's vocabulary, with its inline secrets named. */
export function translate(name: string, entry: unknown, id: McpImportSourceId): McpImportServer | undefined {
  const usable = MCP_SERVER_NAME_PATTERN.test(name) ? name : name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  if (!usable || !MCP_SERVER_NAME_PATTERN.test(usable)) return undefined;
  const record = asRecord(entry);
  if (!record) return undefined;
  const inlineSecrets: string[] = [];
  const unsupported: string[] = [];

  const openCodeLocal = id === "opencode" && record["type"] === "local" && Array.isArray(record["command"]);
  const command = openCodeLocal ? String((record["command"] as unknown[])[0] ?? "") : string(record["command"]);
  const url = string(record["url"]) ?? string(record["serverUrl"]) ?? string(record["endpoint"]);
  const socket = string(record["socket"]);

  let transport: McpTransport;
  if (command) {
    const args = openCodeLocal
      ? (record["command"] as unknown[]).slice(1).map(String)
      : Array.isArray(record["args"]) ? record["args"].map(String) : undefined;
    const env = secretRecord(asRecord(record["env"] ?? record["environment"]), (key) => SECRET_KEY.test(key), "transport.env", inlineSecrets);
    transport = {
      kind: "stdio",
      command,
      ...(args?.length ? { args } : {}),
      ...(env ? { env } : {}),
      ...(string(record["cwd"]) ? { cwd: string(record["cwd"])! } : {}),
    };
  } else if (url) {
    const headers = secretRecord(asRecord(record["headers"] ?? record["http_headers"]), (key) => SECRET_HEADER.test(key) || SECRET_KEY.test(key), "transport.headers", inlineSecrets);
    const declared = string(record["type"]) ?? string(record["transport"]) ?? string(record["httpTransport"]);
    transport = {
      kind: "http",
      url,
      ...(headers ? { headers } : {}),
      ...(declared === "sse" ? { stream: "sse" as const } : declared === "streamable-http" || declared === "http" ? { stream: "streamable-http" as const } : {}),
    };
  } else if (socket) {
    transport = { kind: "socket", path: socket };
  } else {
    return {
      name: usable,
      config: { name: usable, transport: { kind: "stdio", command: "" } },
      conflicts: [],
      inlineSecrets: [],
      unsupported: "This entry names neither a command, a URL nor a socket, so there is nothing to connect to.",
    };
  }

  let auth: McpAuth | undefined;
  const bearer = string(record["bearerToken"]) ?? string(record["bearer_token"]);
  const oauth = record["oauth"];
  if (bearer) {
    auth = { kind: "bearer", token: { secret: true } };
    inlineSecrets.push("auth.token");
  } else if (record["auth"] === "oauth" || (oauth && typeof oauth === "object")) {
    const config = asRecord(oauth) ?? {};
    if (string(config["clientSecret"])) inlineSecrets.push("auth.clientSecret");
    auth = {
      kind: "oauth",
      ...(string(config["clientId"]) ? { clientId: string(config["clientId"])! } : {}),
      ...(string(config["clientSecret"]) ? { clientSecret: { secret: true } as McpValue } : {}),
      ...(string(config["scope"]) ? { scope: string(config["scope"])! } : {}),
      ...(string(config["authServerMetadataUrl"]) ? { authServerMetadataUrl: string(config["authServerMetadataUrl"])! } : {}),
    };
  } else if (record["auth"] === false) {
    auth = { kind: "none" };
  }
  if (auth && transport.kind !== "http") {
    auth = undefined;
    unsupported.push("its sign-in settings apply to HTTP servers only and were left out");
  }
  if (string(record["bearerTokenEnv"]) || string(record["bearer_token_env_var"])) {
    unsupported.push("its bearer token comes from an environment variable, which a desktop app does not have; add the token here instead");
  }
  if (record["requestHeadersCommand"]) unsupported.push(`it signs each request with an external command, which ${PRODUCT_DISPLAY_NAME} does not run`);
  if (record["enabled"] === false || record["disabled"] === true) {
    // Kept, but off: a person can turn it on after importing.
  }

  const config: McpServerConfig = {
    name: usable,
    transport,
    ...(auth ? { auth } : {}),
    ...(record["enabled"] === false || record["disabled"] === true ? { disabled: true } : {}),
    tools: { exposure: "direct" },
    startup: "on-demand",
  };
  return {
    name: usable,
    config,
    conflicts: [],
    inlineSecrets,
    ...(unsupported.length > 0 ? { unsupported: `Imported without ${unsupported.join("; ")}.` } : {}),
  };
}

/** The inline values a source held, by field path, for the secrets store. */
export function inlineSecretValues(entry: unknown, id: McpImportSourceId): Map<string, string> {
  const record = asRecord(entry) ?? {};
  const values = new Map<string, string>();
  const openCodeLocal = id === "opencode" && record["type"] === "local";
  const env = asRecord(record["env"] ?? record["environment"]);
  for (const [key, value] of Object.entries(env ?? {})) {
    if (SECRET_KEY.test(key) && typeof value === "string") values.set(`transport.env.${key}`, value);
  }
  const headers = asRecord(record["headers"] ?? record["http_headers"]);
  for (const [key, value] of Object.entries(headers ?? {})) {
    if ((SECRET_HEADER.test(key) || SECRET_KEY.test(key)) && typeof value === "string") values.set(`transport.headers.${key}`, value);
  }
  const bearer = string(record["bearerToken"]) ?? string(record["bearer_token"]);
  if (bearer) values.set("auth.token", bearer);
  const oauth = asRecord(record["oauth"]);
  const clientSecret = string(oauth?.["clientSecret"]);
  if (clientSecret) values.set("auth.clientSecret", clientSecret);
  void openCodeLocal;
  return values;
}

/** Read one source's raw entries again, for `apply`. */
export async function readSourceEntries(path: string, id: McpImportSourceId): Promise<Record<string, unknown>> {
  const raw = await readSource(path);
  return serversOf(raw, id);
}

/** Mark conflicts against what Laser already has. */
export function markConflicts(servers: McpImportServer[], existing: Map<McpScope, Set<string>>): McpImportServer[] {
  return servers.map((server) => ({
    ...server,
    conflicts: [...existing.entries()].filter(([, names]) => names.has(server.name)).map(([scope]) => scope),
  }));
}

function secretRecord(
  source: Record<string, unknown> | undefined,
  isSecret: (key: string) => boolean,
  prefix: string,
  inlineSecrets: string[],
): Record<string, McpValue> | undefined {
  if (!source) return undefined;
  const out: Record<string, McpValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (isSecret(key)) {
      out[key] = { secret: true };
      inlineSecrets.push(`${prefix}.${key}`);
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
