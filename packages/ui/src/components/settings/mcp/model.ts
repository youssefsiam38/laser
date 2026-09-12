/**
 * Settings → MCP servers: everything the page knows that is not a component
 * (docs/mcp.md "The experience"). Pure functions only, so the wording, the
 * name rules, the schema rendering and the tool-policy arithmetic are all
 * testable without a DOM.
 *
 * Two rules shape this file:
 *   - The protocol is the vocabulary (`@lasercode/protocol` `mcp.ts`); nothing
 *     here invents a field or a status.
 *   - Secrets are write-only. A stored value is never read back, so a field
 *     carries `stored` (there is a value) and `value` (what the person just
 *     typed), and only one of them ever reaches `mcp/save`.
 */
import {
  MCP_DIRECT_EXPOSURE_MAX_TOOLS,
  MCP_SERVER_NAME_PATTERN,
  type McpAuthKind,
  type McpCatalogEntry,
  type McpProtocolVersion,
  type McpScope,
  type McpServerConfig,
  type McpServerConfigInput,
  type McpServerState,
  type McpServerStatus,
  type McpStartup,
  type McpToolExposure,
  type McpToolInfo,
  type McpToolPolicy,
  type McpTransport,
  type McpTransportKind,
  type McpValue,
  type McpValueInput,
} from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// Words for a person

export type StatusTone = "live" | "attention" | "danger" | "muted" | "quiet";

export interface StatusWords {
  label: string;
  tone: StatusTone;
  /** One sentence of what the word means, for the row's title and the overview. */
  help: string;
  /** The status is a live connection being established. */
  working?: boolean;
}

export function statusWords(status: McpServerStatus): StatusWords {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "live", help: "Running and answering right now." };
    case "ready":
      return { label: "Ready", tone: "quiet", help: "Its tools are known and usable; it connects when one is called." };
    case "starting":
      return { label: "Starting", tone: "live", help: "Connecting.", working: true };
    case "needs-auth":
      return { label: "Needs sign-in", tone: "attention", help: "Sign in before it can be used." };
    case "failed":
      return { label: "Failed", tone: "danger", help: "The last attempt to connect did not work." };
    case "off":
      return { label: "Off", tone: "muted", help: "Switched off; it is never started." };
    case "unknown":
    default:
      return { label: "Not seen yet", tone: "muted", help: "Saved, but nothing has connected to it yet." };
  }
}

export function scopeLabel(scope: McpScope): string {
  return scope === "global" ? "Every project" : "This project";
}

/** What `shadowed` and `overridesGlobal` mean, in a sentence or nothing. */
export function scopeNote(state: McpServerState): string | undefined {
  if (state.overridesGlobal) return "This project switches the every-project server of this name off. Its definition is unchanged.";
  if (state.shadowed) return "This project has its own entry for this name, so this is not what it uses here.";
  return undefined;
}

/** "a moment ago", "3 minutes ago", "2 hours ago" — when a failure happened. */
export function failedAgoPhrase(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  if (seconds < 60) return "a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** "24 tools · 24 direct", or "24 tools" when nothing is direct yet. */
export function toolCountLabel(state: Pick<McpServerState, "toolCount" | "directToolCount">): string | undefined {
  if (state.toolCount === undefined) return undefined;
  const tools = `${state.toolCount} ${state.toolCount === 1 ? "tool" : "tools"}`;
  return state.directToolCount === undefined ? tools : `${tools} · ${state.directToolCount} direct`;
}

export function serverTitle(config: Pick<McpServerConfig, "name" | "label">): string {
  return config.label?.trim() || config.name;
}

export function rowKey(state: Pick<McpServerState, "scope" | "config">): string {
  return `${state.scope}:${state.config.name}`;
}

// ---------------------------------------------------------------------------
// Transport, in words and in full

export interface TransportSummary {
  /** Short enough for a row: `npx @playwright/mcp`, `mcp.context7.com`, `…/memory.sock`. */
  text: string;
  /** Command · HTTP · Socket. */
  kind: string;
  /** The whole thing, for a tooltip and the overview. */
  full: string;
}

export const TRANSPORT_LABEL: Record<McpTransportKind, string> = {
  stdio: "Command",
  http: "HTTP",
  socket: "Socket",
};

/**
 * `undefined` when the entry carries no definition of its own — the one
 * project entry that only switches a global server off (the protocol made
 * `transport` optional for exactly that shape).
 */
export function transportSummary(transport: McpTransport | undefined): TransportSummary | undefined {
  if (!transport) return undefined;
  if (transport.kind === "stdio") {
    const full = joinCommand(transport.command, transport.args ?? []);
    const target = (transport.args ?? []).find((arg) => !arg.startsWith("-"));
    const short = target ? `${transport.command} ${stripVersion(target)}` : transport.command;
    return { text: short, kind: TRANSPORT_LABEL.stdio, full };
  }
  if (transport.kind === "http") {
    let host = transport.url;
    try {
      host = new URL(transport.url).host;
    } catch {
      /* an unparseable URL is shown as written */
    }
    return { text: host, kind: TRANSPORT_LABEL.http, full: transport.url };
  }
  const slash = transport.path.lastIndexOf("/");
  return {
    text: slash > 0 ? `…/${transport.path.slice(slash + 1)}` : transport.path,
    kind: TRANSPORT_LABEL.socket,
    full: transport.path,
  };
}

/** `@playwright/mcp@latest` → `@playwright/mcp`; a bare `pkg@1.2.3` → `pkg`. */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export function joinCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteToken).join(" ");
}

function quoteToken(token: string): string {
  return /[\s"']/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

/**
 * A pasted command line becomes a command and its arguments:
 * `npx -y @playwright/mcp@latest` → `{ command: "npx", args: ["-y", "@playwright/mcp@latest"] }`.
 * Quotes hold a token together; nothing else is interpreted (no shell, ever).
 */
export function parseCommandLine(line: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\" && quote === '"' && i + 1 < line.length) {
      current += line[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  const [command = "", ...args] = tokens;
  return { command, args };
}

// ---------------------------------------------------------------------------
// Names

/** A label becomes a name the protocol accepts: `Playwright browser` → `playwright-browser`. */
export function deriveName(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    // The protocol's pattern wants a letter or a digit first.
    .replace(/^[^A-Za-z0-9]+|[-_]+$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

export function nameIssue(name: string): string | undefined {
  if (!name.trim()) return "Give the server a name. It goes in front of every tool the model sees.";
  if (name.length > 64) return "Names are at most 64 characters.";
  // One rule, the protocol's (`MCP_SERVER_NAME_PATTERN`): a letter or a digit
  // first, then letters, digits, hyphens and underscores.
  if (!MCP_SERVER_NAME_PATTERN.test(name)) return "Start with a letter or a digit, then letters, digits, hyphens and underscores only.";
  return undefined;
}

// ---------------------------------------------------------------------------
// Exposure

export function defaultExposure(toolCount: number): McpToolExposure {
  return toolCount <= MCP_DIRECT_EXPOSURE_MAX_TOOLS ? "direct" : "on-demand";
}

export const EXPOSURE_LABEL: Record<McpToolExposure, string> = {
  direct: "Each tool on its own",
  "on-demand": "On demand",
  search: "Found by searching",
};

export function exposureExplanation(exposure: McpToolExposure, toolCount: number | undefined): string {
  if (exposure === "direct") {
    return toolCount === undefined
      ? "Every tool is in the model’s list from the start."
      : `${toolCount} ${toolCount === 1 ? "tool is" : "tools are"} in the model’s list from the start, so it can call them without looking first.`;
  }
  if (exposure === "on-demand") {
    return toolCount === undefined
      ? "The model looks the tools up and calls them through one tool, which keeps its list short."
      : `${toolCount} tools would be a long list for every turn, so the model looks them up and calls them through one tool instead.`;
  }
  return "The tools stay out of the list until the model searches for one.";
}

// ---------------------------------------------------------------------------
// Input schemas: a compact shape, and a form

/** `{ url: string; fullPage?: boolean }` for an object schema; undefined for anything else. */
export function schemaToShape(schema: unknown): string | undefined {
  const object = asRecord(schema);
  if (!object || object["type"] !== "object") return undefined;
  const properties = asRecord(object["properties"]);
  if (!properties) return "{}";
  const required = new Set(Array.isArray(object["required"]) ? (object["required"] as unknown[]).filter(isString) : []);
  const parts = Object.entries(properties).map(([key, value]) => {
    const shape = typeName(value);
    const fallback = asRecord(value)?.["default"];
    const suffix = fallback === undefined ? "" : ` = ${JSON.stringify(fallback)}`;
    return `${key}${required.has(key) ? "" : "?"}: ${shape}${suffix}`;
  });
  if (!parts.length) return "{}";
  return `{ ${parts.join("; ")} }`;
}

function typeName(schema: unknown, depth = 0): string {
  const object = asRecord(schema);
  if (!object) return "unknown";
  const enumeration = object["enum"];
  if (Array.isArray(enumeration) && enumeration.length) return enumeration.map((value) => JSON.stringify(value)).join(" | ");
  const type = object["type"];
  if (type === "array") {
    const items = typeName(object["items"], depth + 1);
    return items.includes(" ") ? `Array<${items}>` : `${items}[]`;
  }
  if (type === "object") {
    if (depth > 0) return "object";
    return schemaToShape(object) ?? "object";
  }
  if (Array.isArray(type)) return type.filter(isString).join(" | ");
  if (isString(type)) return type;
  if (Array.isArray(object["anyOf"])) return (object["anyOf"] as unknown[]).map((entry) => typeName(entry, depth + 1)).join(" | ");
  if (Array.isArray(object["oneOf"])) return (object["oneOf"] as unknown[]).map((entry) => typeName(entry, depth + 1)).join(" | ");
  return "unknown";
}

export type ArgFieldKind = "string" | "text" | "number" | "boolean" | "enum" | "string-list" | "json";

export interface ArgField {
  name: string;
  kind: ArgFieldKind;
  required: boolean;
  description?: string | undefined;
  options?: string[] | undefined;
  /** The schema's own default, rendered into the field on first paint. */
  initial?: string | undefined;
  initialBoolean?: boolean | undefined;
}

/** The Run tab's form: one control per property it can type, JSON for the rest. */
export function schemaFields(schema: unknown): ArgField[] {
  const object = asRecord(schema);
  const properties = asRecord(object?.["properties"]);
  if (!properties) return [];
  const required = new Set(Array.isArray(object?.["required"]) ? (object!["required"] as unknown[]).filter(isString) : []);
  return Object.entries(properties).map(([name, raw]) => {
    const property = asRecord(raw) ?? {};
    const description = isString(property["description"]) ? property["description"] : undefined;
    const fallback = property["default"];
    const enumeration = property["enum"];
    const base = { name, required: required.has(name), description } as const;
    if (Array.isArray(enumeration) && enumeration.length && enumeration.every(isString)) {
      return { ...base, kind: "enum", options: enumeration as string[], initial: isString(fallback) ? fallback : undefined };
    }
    const type = property["type"];
    if (type === "boolean") return { ...base, kind: "boolean", initialBoolean: fallback === true };
    if (type === "number" || type === "integer") {
      return { ...base, kind: "number", initial: typeof fallback === "number" ? String(fallback) : undefined };
    }
    if (type === "array" && asRecord(property["items"])?.["type"] === "string") {
      return { ...base, kind: "string-list", initial: Array.isArray(fallback) ? (fallback as unknown[]).filter(isString).join("\n") : undefined };
    }
    if (type === "string") {
      const long = /prompt|body|content|text|script|code/i.test(name);
      return { ...base, kind: long ? "text" : "string", initial: isString(fallback) ? fallback : undefined };
    }
    return { ...base, kind: "json", initial: fallback === undefined ? undefined : JSON.stringify(fallback, null, 2) };
  });
}

export interface ArgValues {
  [name: string]: string | boolean;
}

export function initialArgValues(fields: readonly ArgField[]): ArgValues {
  const values: ArgValues = {};
  for (const field of fields) {
    if (field.kind === "boolean") values[field.name] = field.initialBoolean ?? false;
    else values[field.name] = field.initial ?? "";
  }
  return values;
}

/** Typed arguments for `mcp/call`, or the first thing that could not be read. */
export function buildArgs(
  fields: readonly ArgField[],
  values: ArgValues,
): { args: Record<string, unknown> } | { error: string } {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") {
      if (value === true || field.required) args[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (!text.trim()) {
      if (field.required) return { error: `${field.name} is required.` };
      continue;
    }
    if (field.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { error: `${field.name} has to be a number.` };
      args[field.name] = parsed;
      continue;
    }
    if (field.kind === "string-list") {
      args[field.name] = text
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
      continue;
    }
    if (field.kind === "json") {
      try {
        args[field.name] = JSON.parse(text);
      } catch {
        return { error: `${field.name} is not valid JSON.` };
      }
      continue;
    }
    args[field.name] = text;
  }
  return { args };
}

/** An image or audio block as something a browser can show or play. */
export function contentDataUri(block: { data: string; mimeType: string }): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

// ---------------------------------------------------------------------------
// Tool policy arithmetic. Every change is one whole `tools` object.

export function policyOf(config: Pick<McpServerConfig, "tools">): McpToolPolicy {
  return config.tools ?? { exposure: "direct" };
}

function withList(policy: McpToolPolicy, key: "only" | "exclude", list: string[] | undefined): McpToolPolicy {
  const next: McpToolPolicy = { ...policy };
  if (!list || !list.length) delete next[key];
  else next[key] = [...new Set(list)].sort();
  return next;
}

/**
 * What a tool's three switches show. This is the worker's own answer
 * (`McpToolInfo.visibility` / `.approval`), not a second reading of the
 * policy: a policy may hold globs, and the engine is the one that matched
 * them.
 */
export function toolState(tool: Pick<McpToolInfo, "visibility" | "approval">): { enabled: boolean; direct: boolean; ask: boolean } {
  return { enabled: tool.visibility !== "excluded", direct: tool.visibility === "direct", ask: tool.approval };
}

function isPattern(entry: string): boolean {
  return /[*?[\]]/.test(entry);
}

/**
 * Which switches must not be rewritten from here: a list of patterns (or an
 * `include` list, which decides which tools exist at all) cannot be edited
 * one tool at a time without quietly replacing it with literal names.
 */
export function policyPatternLocks(policy: McpToolPolicy): { enabled: boolean; direct: boolean; ask: boolean; any: boolean } {
  const enabled = policy.include !== undefined || (policy.exclude ?? []).some(isPattern);
  const direct = (policy.only ?? []).some(isPattern);
  const ask = policy.approve === true || (Array.isArray(policy.approve) ? policy.approve.some(isPattern) : false);
  return { enabled, direct, ask, any: enabled || direct || (Array.isArray(policy.approve) && policy.approve.some(isPattern)) };
}

export const PATTERN_POLICY_NOTE = "This server’s tool list uses patterns; edit it in the form.";

export function setToolEnabled(policy: McpToolPolicy, tool: string, enabled: boolean): McpToolPolicy {
  const exclude = new Set(policy.exclude ?? []);
  if (enabled) exclude.delete(tool);
  else exclude.add(tool);
  return withList(policy, "exclude", [...exclude]);
}

export function setToolDirect(policy: McpToolPolicy, tool: string, direct: boolean, allTools: readonly string[]): McpToolPolicy {
  // `only` absent means "every tool is direct", so switching one off has to
  // write the rest of the list out before removing it — and an *empty* set is
  // not "no restriction", it is "nothing is direct", which is what on demand
  // means. Deleting the key there would have made every tool direct, the
  // opposite of what the switch says.
  const only = new Set(policy.only ?? allTools);
  if (direct) only.add(tool);
  else only.delete(tool);
  if (!only.size) return withList({ ...policy, exposure: "on-demand" }, "only", undefined);
  const covers = allTools.length > 0 && allTools.every((name) => only.has(name));
  const next = withList(policy, "only", covers ? undefined : [...only]);
  return direct && policy.exposure !== "direct" ? { ...next, exposure: "direct" } : next;
}

/** Said out loud when the last direct tool is switched off. */
export const LAST_DIRECT_TOOL_NOTE =
  "Nothing is in the model’s list any more, so this server now answers on demand: the model looks its tools up and calls them through one tool.";

export function setToolApproved(policy: McpToolPolicy, tool: string, ask: boolean): McpToolPolicy {
  if (policy.approve === true) return policy;
  const approve = new Set(Array.isArray(policy.approve) ? policy.approve : []);
  if (ask) approve.add(tool);
  else approve.delete(tool);
  const next: McpToolPolicy = { ...policy };
  if (approve.size) next.approve = [...approve].sort();
  else delete next.approve;
  return next;
}

export function allToolsOn(policy: McpToolPolicy): McpToolPolicy {
  return withList(policy, "exclude", undefined);
}

export function allToolsOff(policy: McpToolPolicy, allTools: readonly string[]): McpToolPolicy {
  return withList(policy, "exclude", [...allTools]);
}

export function allToolsDirect(policy: McpToolPolicy): McpToolPolicy {
  return withList({ ...policy, exposure: "direct" }, "only", undefined);
}

/** Why the model cannot see this tool, or nothing when it can. */
export function toolVisibilityNote(tool: Pick<McpToolInfo, "visibility">): string | undefined {
  if (tool.visibility === "excluded") return "Switched off: the model never sees it.";
  if (tool.visibility === "on-demand") return "Reached on demand, through the server’s one search-and-call tool.";
  return undefined;
}

// ---------------------------------------------------------------------------
// The form behind Add and Edit

export interface ValueRow {
  id: string;
  key: string;
  /** What the person typed now. Empty with `stored` means "keep what is saved". */
  value: string;
  secret: boolean;
  stored: boolean;
}

export interface SecretField {
  value: string;
  stored: boolean;
}

export interface ServerForm {
  label: string;
  name: string;
  /** The person edited the name, so deriving it from the label stops. */
  nameEdited: boolean;
  kind: McpTransportKind;
  commandLine: string;
  env: ValueRow[];
  cwd: string;
  inheritEnv: boolean;
  url: string;
  headers: ValueRow[];
  stream: "auto" | "streamable-http" | "sse";
  caFile: string;
  socketPath: string;
  authKind: McpAuthKind;
  token: SecretField;
  oauthClientId: string;
  oauthClientSecret: SecretField;
  oauthScope: string;
  oauthRedirectUri: string;
  oauthMetadataUrl: string;
  oauthGrantType: "authorization_code" | "client_credentials";
  startup: McpStartup;
  idleMinutes: string;
  requestTimeoutMs: string;
  protocolVersion: McpProtocolVersion;
  resourcesAsTools: boolean;
  debug: boolean;
  exposure: McpToolExposure;
  /** Kept across an edit so per-tool choices survive a change of transport. */
  tools?: McpToolPolicy | undefined;
  catalogId?: string | undefined;
  disabled?: boolean | undefined;
}

let rowSeq = 0;
export function valueRow(partial: Partial<ValueRow> = {}): ValueRow {
  return { id: `row-${++rowSeq}`, key: "", value: "", secret: false, stored: false, ...partial };
}

export function emptyForm(): ServerForm {
  return {
    label: "",
    name: "",
    nameEdited: false,
    kind: "stdio",
    commandLine: "",
    env: [],
    cwd: "",
    inheritEnv: true,
    url: "",
    headers: [],
    stream: "auto",
    caFile: "",
    socketPath: "",
    authKind: "none",
    token: { value: "", stored: false },
    oauthClientId: "",
    oauthClientSecret: { value: "", stored: false },
    oauthScope: "",
    oauthRedirectUri: "",
    oauthMetadataUrl: "",
    oauthGrantType: "authorization_code",
    startup: "on-demand",
    idleMinutes: "",
    requestTimeoutMs: "",
    protocolVersion: "auto",
    resourcesAsTools: true,
    debug: false,
    exposure: "direct",
  };
}

function rowsOf(record: Record<string, McpValue> | undefined): ValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) =>
    typeof value === "string"
      ? valueRow({ key, value })
      : valueRow({ key, secret: true, stored: value.present !== false }),
  );
}

function secretOf(value: McpValue | undefined): SecretField {
  if (value === undefined) return { value: "", stored: false };
  return typeof value === "string" ? { value, stored: false } : { value: "", stored: value.present !== false };
}

export function configToForm(config: McpServerConfig): ServerForm {
  const form = emptyForm();
  form.name = config.name;
  form.label = config.label ?? "";
  form.nameEdited = true;
  const transport = config.transport;
  form.kind = transport?.kind ?? "stdio";
  form.startup = config.startup ?? "on-demand";
  form.idleMinutes = config.idleMinutes === undefined ? "" : String(config.idleMinutes);
  form.requestTimeoutMs = config.requestTimeoutMs === undefined ? "" : String(config.requestTimeoutMs);
  form.protocolVersion = config.protocolVersion ?? "auto";
  form.resourcesAsTools = config.resourcesAsTools !== false;
  form.debug = config.debug === true;
  form.exposure = config.tools?.exposure ?? "direct";
  form.tools = config.tools;
  form.catalogId = config.catalogId;
  form.disabled = config.disabled;
  // A project entry that only switches a global server off carries no
  // definition at all; the form then starts empty rather than guessing one.
  if (transport?.kind === "stdio") {
    form.commandLine = joinCommand(transport.command, transport.args ?? []);
    form.env = rowsOf(transport.env);
    form.cwd = transport.cwd ?? "";
    form.inheritEnv = transport.inheritEnv !== false;
  } else if (transport?.kind === "http") {
    form.url = transport.url;
    form.headers = rowsOf(transport.headers);
    form.stream = transport.stream ?? "auto";
    form.caFile = transport.caFile ?? "";
  } else if (transport?.kind === "socket") {
    form.socketPath = transport.path;
  }
  const auth = config.auth;
  form.authKind = auth?.kind ?? "none";
  if (auth?.kind === "bearer") form.token = secretOf(auth.token);
  if (auth?.kind === "oauth") {
    form.oauthClientId = auth.clientId ?? "";
    form.oauthClientSecret = secretOf(auth.clientSecret);
    form.oauthScope = auth.scope ?? "";
    form.oauthRedirectUri = auth.redirectUri ?? "";
    form.oauthMetadataUrl = auth.authServerMetadataUrl ?? "";
    form.oauthGrantType = auth.grantType ?? "authorization_code";
  }
  return form;
}

function valueInput(row: ValueRow): McpValueInput | undefined {
  if (row.value) return row.secret ? { secret: true, value: row.value } : row.value;
  // A row that had a stored secret keeps it until a value is typed, even
  // after the person un-marks it: un-marking is how you look, not how you
  // delete, and an empty string here would overwrite the saved value.
  if (row.stored) return { secret: true };
  return row.secret ? undefined : row.value;
}

/** A row whose saved secret is still in place although it is no longer marked secret. */
export function keepsStoredSecret(row: ValueRow): boolean {
  return row.stored && !row.value;
}

function recordOf(rows: readonly ValueRow[]): Record<string, McpValueInput> | undefined {
  const record: Record<string, McpValueInput> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const value = valueInput(row);
    if (value === undefined) continue;
    record[key] = value;
  }
  return Object.keys(record).length ? record : undefined;
}

function secretInput(field: SecretField): McpValueInput | undefined {
  if (field.value) return { secret: true, value: field.value };
  return field.stored ? { secret: true } : undefined;
}

function positive(text: string): number | undefined {
  const value = Number(text.trim());
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formToConfig(form: ServerForm): McpServerConfigInput {
  const transport: McpTransport<McpValueInput> =
    form.kind === "stdio"
      ? (() => {
          const { command, args } = parseCommandLine(form.commandLine);
          const env = recordOf(form.env);
          return {
            kind: "stdio" as const,
            command,
            ...(args.length ? { args } : {}),
            ...(env ? { env } : {}),
            ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
            ...(form.inheritEnv ? {} : { inheritEnv: false }),
          };
        })()
      : form.kind === "http"
        ? (() => {
            const headers = recordOf(form.headers);
            return {
              kind: "http" as const,
              url: form.url.trim(),
              ...(headers ? { headers } : {}),
              ...(form.stream === "auto" ? {} : { stream: form.stream }),
              ...(form.caFile.trim() ? { caFile: form.caFile.trim() } : {}),
            };
          })()
        : { kind: "socket" as const, path: form.socketPath.trim() };

  const config: McpServerConfigInput = {
    name: form.name.trim(),
    ...(form.label.trim() && form.label.trim() !== form.name.trim() ? { label: form.label.trim() } : {}),
    transport,
    startup: form.startup,
    tools: { ...(form.tools ?? {}), exposure: form.exposure },
  };
  if (form.kind === "http" && form.authKind !== "none") {
    if (form.authKind === "bearer") {
      const token = secretInput(form.token);
      if (token !== undefined) config.auth = { kind: "bearer", token };
    } else {
      const clientSecret = secretInput(form.oauthClientSecret);
      config.auth = {
        kind: "oauth",
        ...(form.oauthClientId.trim() ? { clientId: form.oauthClientId.trim() } : {}),
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        ...(form.oauthScope.trim() ? { scope: form.oauthScope.trim() } : {}),
        ...(form.oauthRedirectUri.trim() ? { redirectUri: form.oauthRedirectUri.trim() } : {}),
        ...(form.oauthMetadataUrl.trim() ? { authServerMetadataUrl: form.oauthMetadataUrl.trim() } : {}),
        ...(form.oauthGrantType === "authorization_code" ? {} : { grantType: form.oauthGrantType }),
      };
    }
  }
  const idle = positive(form.idleMinutes);
  if (idle !== undefined) config.idleMinutes = idle;
  const timeout = positive(form.requestTimeoutMs);
  if (timeout !== undefined) config.requestTimeoutMs = timeout;
  if (form.protocolVersion !== "auto") config.protocolVersion = form.protocolVersion;
  if (!form.resourcesAsTools) config.resourcesAsTools = false;
  if (form.debug) config.debug = true;
  if (form.disabled) config.disabled = true;
  if (form.catalogId) config.catalogId = form.catalogId;
  return config;
}

export interface FormIssues {
  name?: string;
  commandLine?: string;
  url?: string;
  socketPath?: string;
  token?: string;
}

export function formIssues(form: ServerForm): FormIssues {
  const issues: FormIssues = {};
  const name = nameIssue(form.name.trim());
  if (name) issues.name = name;
  if (form.kind === "stdio" && !parseCommandLine(form.commandLine).command) {
    issues.commandLine = "Type the command that starts the server, the way you would run it yourself.";
  }
  if (form.kind === "http") {
    const url = form.url.trim();
    if (!url) issues.url = "Paste the server’s address.";
    else if (!/^https?:\/\//i.test(url)) issues.url = "The address has to start with http:// or https://.";
  }
  if (form.kind === "socket" && !form.socketPath.trim()) issues.socketPath = "Give the path of the socket file.";
  // "Token" with nothing in it used to save a server with no sign-in at all,
  // which then failed at the server with a message nobody could act on.
  if (form.kind === "http" && form.authKind === "bearer" && !form.token.value && !form.token.stored) {
    issues.token = "Enter the token, or choose None.";
  }
  return issues;
}

export function hasIssues(issues: FormIssues): boolean {
  return Object.keys(issues).length > 0;
}

/** The gallery's definition with the options the person chose. */
export function catalogForm(entry: McpCatalogEntry, chosen: ReadonlySet<string>): ServerForm {
  const form = configToForm({ ...entry.config, name: deriveName(entry.name), catalogId: entry.id } as McpServerConfig);
  form.label = entry.name;
  form.nameEdited = false;
  const base = entry.config.transport;
  if (base?.kind === "stdio") {
    const extra = (entry.options ?? []).flatMap((option) => {
      if (option.kind === "choice") return option.choices.find((choice) => chosen.has(`${option.id}:${choice.id}`))?.args ?? [];
      return chosen.has(option.id) && !catalogOptionReason(option, chosen) ? [option.arg] : [];
    });
    form.commandLine = joinCommand(base.command, [...(base.args ?? []), ...extra]);
  }
  form.catalogId = entry.id;
  return form;
}

export function defaultCatalogOptions(entry: McpCatalogEntry): Set<string> {
  return new Set((entry.options ?? []).flatMap((option) => option.kind === "choice"
    ? [`${option.id}:${option.default}`]
    : option.default ? [option.id] : []));
}

export function catalogOptionReason(option: NonNullable<McpCatalogEntry["options"]>[number], chosen: ReadonlySet<string>): string | undefined {
  if (option.kind === "choice" || !option.requiresChoice) return undefined;
  const requirement = option.requiresChoice;
  return chosen.has(`${requirement.id}:${requirement.value}`) ? undefined : requirement.reason;
}

// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
