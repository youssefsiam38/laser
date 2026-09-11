/**
 * Where MCP configuration lives (docs/mcp.md "Where configuration lives").
 *
 *   <agentDir>/<data dir>/mcp.json          every project
 *   <project>/.laser/mcp.json               this project, commit it
 *   <agentDir>/<data dir>/mcp-secrets.json  0600, never shared
 *
 * A project file never holds a secret value: the field carries
 * `{ "secret": true }` and the value lives in the secrets file, keyed by
 * scope, project, server name and field path. Writes take a lock on the
 * stable path and replace atomically, exactly like `search-connections.json`
 * (`web-search.ts`); reads are tolerant, because a file a person edits by
 * hand must never cost them the servers that are still valid.
 *
 * Project files are read only when the project is trusted, the same rule
 * `.laser/settings.json` follows.
 */
import { DATA_DIR_NAME, MCP_SERVER_NAME_PATTERN, PROJECT_DIR_NAME, mcpServerConfigInputSchema, type McpScope, type McpSecretInput, type McpServerConfig, type McpServerConfigInput, type McpValue, type McpValueInput } from "@lasercode/protocol";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { secretFieldPaths } from "./adapter-config.js";

interface StoreFile {
  version: 1;
  servers: McpServerConfig[];
}

interface SecretEntry {
  scope: McpScope;
  /** Project scope only: the project the secret belongs to. */
  cwd?: string;
  name: string;
  field: string;
  value: string;
}
interface SecretsFile {
  version: 1;
  secrets: SecretEntry[];
}

/** An entry Laser could not read. It is never started; the person is told. */
export interface MalformedEntry {
  scope: McpScope;
  /** The name it carried, when it carried a usable one. */
  name?: string;
  /** What to call it in a list when it has no usable name. */
  label: string;
  detail: string;
}

export interface ScopeContents {
  servers: McpServerConfig[];
  malformed: MalformedEntry[];
  /**
   * The entries exactly as the file holds them. A write starts from these, so
   * an entry Laser could not read survives a save of a different server.
   */
  raw: unknown[];
  /** The file itself could not be parsed; nothing may be written over it. */
  unreadable?: string;
}

export interface EffectiveServer {
  scope: McpScope;
  config: McpServerConfig;
  /** A project entry of the same name replaces this global one here. */
  shadowed?: boolean;
  /** This project entry only switches the global definition off here. */
  overridesGlobal?: boolean;
  /** In the set the engine is given for this project (name → definition). */
  effective?: boolean;
}

const NAME_LIMIT = 64;

export class McpStore {
  constructor(private readonly agentDir: string) {}

  globalPath(): string {
    return join(this.agentDir, DATA_DIR_NAME, "mcp.json");
  }
  projectPath(cwd: string): string {
    return join(resolve(cwd), PROJECT_DIR_NAME, "mcp.json");
  }
  secretsPath(): string {
    return join(this.agentDir, DATA_DIR_NAME, "mcp-secrets.json");
  }
  private pathFor(scope: McpScope, cwd: string): string {
    return scope === "global" ? this.globalPath() : this.projectPath(cwd);
  }

  /** One scope as written, with unreadable entries separated out. */
  async read(scope: McpScope, cwd: string, projectTrusted?: boolean): Promise<ScopeContents> {
    if (scope === "project" && projectTrusted === false) return { servers: [], malformed: [], raw: [] };
    return parseScope(await readJson(this.pathFor(scope, cwd)), scope, this.pathFor(scope, cwd));
  }

  /**
   * Both scopes overlaid by name. The global list is the base; a project entry
   * of the same name replaces it, and a project entry that carries only a name
   * and `disabled` switches the global one off for this project.
   */
  async effective(cwd: string, projectTrusted?: boolean): Promise<{ servers: EffectiveServer[]; malformed: MalformedEntry[] }> {
    const [globals, projects] = await Promise.all([
      this.read("global", cwd),
      this.read("project", cwd, projectTrusted),
    ]);
    const projectByName = new Map(projects.servers.map((server) => [server.name, server]));
    const servers: EffectiveServer[] = [];
    const malformed = [...projects.malformed, ...globals.malformed];
    for (const config of projects.servers) {
      if (isDisableOnly(config)) {
        // The one entry with no definition of its own. It reads as the server
        // it switches off, so a person sees what is being turned off here.
        const global = globals.servers.find((candidate) => candidate.name === config.name);
        if (!global) {
          projectByName.delete(config.name);
          malformed.push({
            scope: "project",
            name: config.name,
            label: config.name,
            detail: `"${config.name}" switches off a server this project does not have. Remove the entry, or add the server.`,
          });
          continue;
        }
        servers.push({ scope: "project", config: { ...global, disabled: true }, overridesGlobal: true, effective: false });
        continue;
      }
      servers.push({ scope: "project", config, effective: !config.disabled });
    }
    for (const config of globals.servers) {
      // A project entry of the same name — a replacement or a switch-off —
      // means this definition is not what the project uses.
      const shadowed = projectByName.has(config.name);
      servers.push({
        scope: "global",
        config,
        ...(shadowed ? { shadowed: true } : {}),
        effective: !shadowed && !config.disabled,
      });
    }
    return { servers, malformed };
  }

  /** The definitions the engine is given for this project, in list order. */
  async enabled(cwd: string, projectTrusted?: boolean): Promise<Array<{ scope: McpScope; config: McpConfiguredServer }>> {
    const { servers } = await this.effective(cwd, projectTrusted);
    return servers
      .filter((server) => server.effective && isConfigured(server.config))
      .map(({ scope, config }) => ({ scope, config: config as McpConfiguredServer }));
  }

  /**
   * Create or replace one server. Validates against the protocol schema and
   * the product's own rules, moves new secret values into the secrets file and
   * writes `{ secret: true }` in their place.
   */
  async save(scope: McpScope, cwd: string, input: McpServerConfigInput, originalName?: string): Promise<void> {
    const parsed = mcpServerConfigInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(firstIssue(parsed.error.issues) ?? "This server's settings are not valid. Check the fields and try again.");
    }
    const server = parsed.data as McpServerConfigInput;
    if (server.transport === undefined) {
      if (scope !== "project") throw new Error("Only this project can switch a server off; a server without a way to connect cannot be saved for every project.");
      const globals = await this.read("global", cwd);
      if (!globals.servers.some((candidate) => candidate.name === server.name)) {
        throw new Error(`There is no server named "${server.name}" to switch off for this project.`);
      }
    }
    await this.writeScope(scope, cwd, async (servers, secrets) => {
      const previousName = originalName ?? server.name;
      const index = servers.findIndex((entry) => entry.name === previousName);
      if (originalName && index < 0) throw new Error(`No server named "${originalName}" is saved here.`);
      if (server.name !== previousName && servers.some((entry) => entry.name === server.name)) {
        throw new Error(`A server named "${server.name}" already exists here. Choose another name.`);
      }
      const previous = index >= 0 ? servers[index] : undefined;
      if (originalName && server.name !== originalName) renameSecrets(secrets, scope, cwd, originalName, server.name);
      const stored = this.applySecrets(scope, cwd, server, previous, secrets);
      if (index >= 0) servers[index] = stored;
      else servers.push(stored);
    });
  }

  /** Delete one server and every secret it owned. */
  async remove(scope: McpScope, cwd: string, name: string): Promise<void> {
    await this.writeScope(scope, cwd, (servers, secrets) => {
      const index = servers.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`No server named "${name}" is saved here.`);
      servers.splice(index, 1);
      dropSecrets(secrets, scope, cwd, name);
    });
  }

  /** Resolved secret values for one server, in memory only. */
  async secretsFor(scope: McpScope, cwd: string, name: string): Promise<Map<string, string>> {
    const file = await this.readSecrets();
    const values = new Map<string, string>();
    for (const entry of file.secrets) {
      if (entry.scope !== scope || entry.name !== name) continue;
      if (scope === "project" && entry.cwd !== resolve(cwd)) continue;
      values.set(entry.field, entry.value);
    }
    return values;
  }

  /** Which secret fields have a stored value, for `present` in a response. */
  async secretPresence(scope: McpScope, cwd: string, name: string): Promise<Set<string>> {
    return new Set((await this.secretsFor(scope, cwd, name)).keys());
  }

  // ------------------------------------------------------------- internals

  private applySecrets(
    scope: McpScope,
    cwd: string,
    input: McpServerConfigInput,
    previous: McpServerConfig | undefined,
    secrets: SecretEntry[],
  ): McpServerConfig {
    const stored = structuredClone(input) as unknown as McpServerConfig;
    // The switch-off entry has no fields a secret could sit in.
    if (input.transport === undefined) return stored;
    const written = new Set<string>();
    const take = (value: McpValueInput | undefined, field: string): McpValue | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === "string") {
        dropSecret(secrets, scope, cwd, input.name, field);
        return value;
      }
      written.add(field);
      const fresh = (value as McpSecretInput).value;
      if (typeof fresh === "string") setSecret(secrets, scope, cwd, input.name, field, fresh);
      return { secret: true };
    };
    const transport = stored.transport as { env?: Record<string, McpValue>; headers?: Record<string, McpValue> };
    const inputTransport = input.transport as { env?: Record<string, McpValueInput>; headers?: Record<string, McpValueInput> };
    for (const kind of ["env", "headers"] as const) {
      const source = inputTransport[kind];
      if (!source) continue;
      const target: Record<string, McpValue> = {};
      for (const [key, value] of Object.entries(source)) {
        const resolved = take(value, `transport.${kind}.${key}`);
        if (resolved !== undefined) target[key] = resolved;
      }
      transport[kind] = target;
    }
    if (input.auth?.kind === "bearer") {
      const token = take(input.auth.token, "auth.token");
      (stored.auth as { token: McpValue }).token = token ?? { secret: true };
    }
    if (input.auth?.kind === "oauth" && input.auth.clientSecret !== undefined) {
      const secret = take(input.auth.clientSecret, "auth.clientSecret");
      if (secret !== undefined) (stored.auth as { clientSecret?: McpValue }).clientSecret = secret;
    }
    // A field that stopped being a secret, or a server whose shape changed,
    // must not leave an orphan value behind in a file nobody reads again.
    const live = new Set(secretFieldPaths(stored));
    for (const field of previous ? secretFieldPaths(previous) : []) {
      if (!live.has(field) && !written.has(field)) dropSecret(secrets, scope, cwd, input.name, field);
    }
    // A kept `{ secret: true }` with no stored value is honest: the person is
    // asked for one. A value is never invented from another scope.
    return stored;
  }

  /**
   * The secrets file. A read degrades to "no secrets stored" when the file
   * cannot be parsed — a list must still answer — but a write refuses (see
   * `writeScope`), so a corrupt file is never replaced with an empty one.
   */
  private async readSecrets(): Promise<SecretsFile & { unreadable?: string }> {
    const file = await readJson(this.secretsPath());
    const raw = file.kind === "value" ? file.value : undefined;
    const secrets = Array.isArray((raw as SecretsFile | undefined)?.secrets) ? (raw as SecretsFile).secrets : [];
    return {
      version: 1,
      ...(file.kind === "unreadable"
        ? { unreadable: `The stored MCP secrets in ${this.secretsPath()} could not be read: ${file.detail}. Fix that file (or move it aside) and try again; nothing was changed.` }
        : {}),
      secrets: secrets.filter((entry): entry is SecretEntry =>
        !!entry && typeof entry.name === "string" && typeof entry.field === "string" && typeof entry.value === "string"
        && (entry.scope === "global" || entry.scope === "project")),
    };
  }

  /**
   * One transaction over a scope's file and the secrets file. Both are locked
   * on their stable paths and replaced atomically; a failed validation leaves
   * both files exactly as they were.
   */
  private async writeScope(
    scope: McpScope,
    cwd: string,
    update: (servers: McpServerConfig[], secrets: SecretEntry[]) => void | Promise<void>,
  ): Promise<void> {
    const file = this.pathFor(scope, cwd);
    const releaseServers = await lock(file, "Another MCP server is being saved. Wait for it to finish and retry.");
    let releaseSecrets: (() => Promise<void>) | undefined;
    try {
      releaseSecrets = await lock(this.secretsPath(), "Another MCP server is being saved. Wait for it to finish and retry.");
      const contents = parseScope(await readJson(file), scope, file);
      const secretsFile = await this.readSecrets();
      // A file Laser cannot parse is a file a person is editing, or one a tool
      // wrote badly. Either way it is theirs: say what is wrong with it and
      // change nothing, rather than replace their work with our view of it.
      if (contents.unreadable) throw new Error(contents.unreadable);
      if (secretsFile.unreadable) throw new Error(secretsFile.unreadable);
      const known = new Set(contents.servers.map((server) => server.name));
      const servers = contents.servers;
      const secrets = secretsFile.secrets;
      await update(servers, secrets);
      await writeAtomic(file, { version: 1, servers: mergeIntoRaw(contents.raw, servers, known) }, scope === "global" ? 0o600 : 0o644);
      await writeAtomic(this.secretsPath(), { version: 1, secrets } satisfies SecretsFile, 0o600);
    } finally {
      await releaseSecrets?.();
      await releaseServers();
    }
  }
}

/** A project entry that only switches a global server off (docs/mcp.md). */
export function isDisableOnly(config: McpServerConfig): boolean {
  return config.transport === undefined;
}

/** Every entry the engine can be given carries a way to connect. */
export type McpConfiguredServer = McpServerConfig & { transport: NonNullable<McpServerConfig["transport"]> };

export function isConfigured(config: McpServerConfig): config is McpConfiguredServer {
  return config.transport !== undefined;
}

function parseScope(file: ReadResult, scope: McpScope, path: string): ScopeContents {
  const servers: McpServerConfig[] = [];
  const malformed: MalformedEntry[] = [];
  if (file.kind === "unreadable") {
    const detail = `The MCP server settings in ${path} could not be read: ${file.detail}. Fix that file (or move it aside) and try again; nothing was changed.`;
    return { servers, malformed: [{ scope, label: "Unreadable settings", detail }], raw: [], unreadable: detail };
  }
  const raw = file.kind === "value" && Array.isArray((file.value as StoreFile | undefined)?.servers)
    ? ((file.value as StoreFile).servers as unknown[])
    : [];
  const seen = new Set<string>();
  let index = 0;
  for (const entry of raw) {
    index += 1;
    const record = entry as { name?: unknown; disabled?: unknown; transport?: unknown } | null;
    const name = typeof record?.name === "string" ? record.name : undefined;
    if (!name || !MCP_SERVER_NAME_PATTERN.test(name) || name.length > NAME_LIMIT) {
      malformed.push({
        scope,
        label: name && name.trim() ? name.slice(0, 64) : `Entry ${index}`,
        detail: name
          ? `"${name}" is not a usable name: use letters, digits, hyphens and underscores, up to 64 characters. It was skipped.`
          : `The ${ordinal(index)} entry in ${path} has no name, so it was skipped.`,
      });
      continue;
    }
    if (seen.has(name)) {
      malformed.push({ scope, name, label: name, detail: `Two saved servers are named "${name}". Only the first is used; remove the duplicate.` });
      continue;
    }
    const parsed = mcpServerConfigInputSchema.safeParse(entry);
    if (!parsed.success) {
      seen.add(name);
      malformed.push({
        scope,
        name,
        label: name,
        detail: `"${name}" could not be read: ${firstIssue(parsed.error.issues) ?? "its saved settings are not valid."} Edit it, or remove and add it again.`,
      });
      continue;
    }
    seen.add(name);
    servers.push(parsed.data as unknown as McpServerConfig);
  }
  return { servers, malformed, raw };
}

function ordinal(index: number): string {
  const names = ["first", "second", "third", "fourth", "fifth"];
  return names[index - 1] ?? `${index}th`;
}

/**
 * The list to write: every entry the file already held, in its own order, with
 * the ones Laser understands replaced by their updated form and the ones it
 * could not read left exactly as they are. A removal drops only an entry that
 * parsed; nothing else in the person's file is touched.
 */
function mergeIntoRaw(raw: unknown[], servers: McpServerConfig[], known: Set<string>): unknown[] {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const written = new Set<string>();
  const out: unknown[] = [];
  for (const entry of raw) {
    const name = typeof (entry as { name?: unknown } | null)?.name === "string" ? (entry as { name: string }).name : undefined;
    if (name && byName.has(name) && !written.has(name)) {
      out.push(byName.get(name));
      written.add(name);
      continue;
    }
    // A name that parsed on the way in and is gone now was removed on purpose.
    if (name && known.has(name) && !byName.has(name)) continue;
    out.push(entry);
  }
  for (const server of servers) if (!written.has(server.name)) out.push(server);
  return out;
}

function firstIssue(issues: Array<{ path: PropertyKey[]; message: string }>): string | undefined {
  const issue = issues[0];
  if (!issue) return undefined;
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function matches(entry: SecretEntry, scope: McpScope, cwd: string, name: string): boolean {
  if (entry.scope !== scope || entry.name !== name) return false;
  return scope === "global" || entry.cwd === resolve(cwd);
}

function setSecret(secrets: SecretEntry[], scope: McpScope, cwd: string, name: string, field: string, value: string): void {
  const index = secrets.findIndex((entry) => matches(entry, scope, cwd, name) && entry.field === field);
  const stored: SecretEntry = { scope, ...(scope === "project" ? { cwd: resolve(cwd) } : {}), name, field, value };
  if (index >= 0) secrets[index] = stored;
  else secrets.push(stored);
}

function dropSecret(secrets: SecretEntry[], scope: McpScope, cwd: string, name: string, field: string): void {
  for (let index = secrets.length - 1; index >= 0; index -= 1) {
    const entry = secrets[index]!;
    if (matches(entry, scope, cwd, name) && entry.field === field) secrets.splice(index, 1);
  }
}

function dropSecrets(secrets: SecretEntry[], scope: McpScope, cwd: string, name: string): void {
  for (let index = secrets.length - 1; index >= 0; index -= 1) {
    if (matches(secrets[index]!, scope, cwd, name)) secrets.splice(index, 1);
  }
}

function renameSecrets(secrets: SecretEntry[], scope: McpScope, cwd: string, from: string, to: string): void {
  for (const entry of secrets) if (matches(entry, scope, cwd, from)) entry.name = to;
}

/** Absent, read, or there and unreadable — three different answers. */
type ReadResult =
  | { kind: "absent" }
  | { kind: "value"; value: unknown }
  | { kind: "unreadable"; detail: string };

async function readJson(path: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw new Error("Could not read the MCP server settings. Check access to app data and retry.");
  }
  try {
    return { kind: "value", value: JSON.parse(text.replace(/^\uFEFF/, "")) as unknown };
  } catch (error) {
    return { kind: "unreadable", detail: (error as Error).message.replace(/\s+/g, " ").trim() };
  }
}

async function lock(path: string, busy: string): Promise<() => Promise<void>> {
  // `<project>/.laser` is committed and shared; only the agent directory is
  // the person's alone, so the restrictive mode applies there only.
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, ...(directory.includes(DATA_DIR_NAME) ? { mode: 0o700 } : {}) });
  // Lock the stable path, never the inode the atomic replace swaps out.
  return lockfile
    .lock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })
    .catch(() => {
      throw new Error(busy);
    });
}

async function writeAtomic(path: string, value: unknown, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
