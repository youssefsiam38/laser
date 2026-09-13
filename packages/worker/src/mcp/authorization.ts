import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { open, mkdir, rename, unlink, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { DATA_DIR_NAME, type McpScope } from "@lasercode/protocol";
import { interpolateEnvVars, resolveConfigPath, resolveServerUrl } from "pi-mcp-adapter/utils";
import type { McpConfiguredServer } from "./store.js";

/** Names and credentials are deliberately not authorization identities. */
export async function mcpAuthorizationIdentity(scope: McpScope, cwd: string, config: McpConfiguredServer): Promise<string> {
  const project = scope === "global" ? "global" : await realpath(cwd).catch(() => resolve(cwd));
  const transport = config.transport;
  const launchDirectory = await realpath(cwd).catch(() => resolve(cwd));
  let target: unknown;
  try {
    if (transport.kind === "http") target = ["http", new URL(resolveServerUrl({ url: transport.url })!).href];
    else if (transport.kind === "stdio") {
      const directory = resolve(launchDirectory, resolveConfigPath(transport.cwd) ?? launchDirectory);
      const workingDirectory = await realpath(directory).catch(() => directory);
      // Even an explicit cwd receives its invoking project's environment overlay.
      target = ["stdio", transport.command, (transport.args ?? []).map(argument => interpolateEnvVars(argument)), workingDirectory, launchDirectory];
    } else target = ["socket", resolve(launchDirectory, resolveConfigPath(transport.path)!)];
  } catch {
    // Broken/missing environment references must remain removable in Settings.
    // Such definitions cannot connect; this fallback never grants execution.
    target = ["unresolved", transport];
  }
  return createHash("sha256").update(JSON.stringify([scope, project, target])).digest("hex");
}

/** A configuration slot is a revocation guard, never a credential/cache account. */
export async function mcpConfigurationIdentity(scope: McpScope, cwd: string, name: string): Promise<string> {
  const project = scope === "global" ? "global" : await realpath(cwd).catch(() => resolve(cwd));
  return createHash("sha256").update(JSON.stringify(["configuration", scope, project, name])).digest("hex");
}

/** Primary target first; a global definition also observes this project's override. */
export async function mcpAuthorizationIdentities(scope: McpScope, cwd: string, config: McpConfiguredServer): Promise<string[]> {
  return Promise.all([
    mcpAuthorizationIdentity(scope, cwd, config),
    mcpConfigurationIdentity(scope, cwd, config.name),
    ...(scope === "global" ? [mcpConfigurationIdentity("project", cwd, config.name)] : []),
  ]);
}

/** An epoch prevents a repaired/torn file from ever validating an old generation. */
export interface McpAuthorizationGeneration {
  identity: string;
  generation: { epoch: string; counter: number };
  updatedAt: number;
}

const ID = /^[a-f0-9]{64}$/;
const EPOCH = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 512;
const READ_MS = 100;
const readDiagnostics = channel("mcp.authorization.read");

function valid(value: unknown, identity: string): value is McpAuthorizationGeneration {
  if (!value || typeof value !== "object") return false;
  const v = value as McpAuthorizationGeneration;
  return v.identity === identity && typeof v.generation?.epoch === "string" && EPOCH.test(v.generation.epoch)
    && Number.isSafeInteger(v.generation.counter) && v.generation.counter >= 0
    && Number.isSafeInteger(v.updatedAt) && v.updatedAt >= 0;
}

/** Credential accounts exclude configuration guards and counters; repairs rotate the epoch. */
export function mcpAuthorizationAccount(snapshot: McpAuthorizationGeneration): string {
  return `${snapshot.identity}:${snapshot.generation.epoch}`;
}

/** Stable logical scope; observation timestamps and caller order are not authority. */
export function mcpAuthorizationPartition(snapshots: readonly (McpAuthorizationGeneration | undefined)[]): string {
  return JSON.stringify(snapshots.filter((value): value is McpAuthorizationGeneration => value !== undefined)
    .map(({ identity, generation }) => ({ identity, generation: { epoch: generation.epoch, counter: generation.counter } }))
    .sort((a, b) => a.identity.localeCompare(b.identity)));
}

/** Opaque status attribution, not a capability or a credential account. */
export function mcpAuthorizationRevision(snapshots: readonly (McpAuthorizationGeneration | undefined)[]): string {
  return createHash("sha256").update(mcpAuthorizationPartition(snapshots)).digest("hex");
}

export class McpAuthorizationError extends Error {
  override readonly name = "McpAuthorizationError";
  readonly code: "MCP_AUTHORIZATION_UPDATING" | "MCP_AUTHORIZATION_CHANGED" | "MCP_AUTHORIZATION_UNAVAILABLE";
  constructor(readonly reason: "updating" | "revoked" | "unavailable", message: string) {
    super(message);
    this.code = reason === "updating" ? "MCP_AUTHORIZATION_UPDATING"
      : reason === "unavailable" ? "MCP_AUTHORIZATION_UNAVAILABLE" : "MCP_AUTHORIZATION_CHANGED";
  }
}

/** Failure to observe a record is not evidence that it needs repair. */
type AuthorizationRead =
  | { kind: "present"; snapshot: McpAuthorizationGeneration }
  | { kind: "missing" }
  | { kind: "corrupt" }
  | { kind: "unavailable" }
  | { kind: "locked" };

function requireAvailable(read: AuthorizationRead) {
  if (read.kind === "unavailable") {
    throw new McpAuthorizationError("unavailable", "MCP sign-in information could not be checked. Try again.");
  }
  if (read.kind === "locked") {
    throw new McpAuthorizationError("updating", "MCP sign-in information is being updated. Try again after the Settings change finishes.");
  }
  return read;
}

// Only first-use establishment coalesces, across registry instances in this worker.
// Mutations never join this map and reads never wait for a mutation lock.
const establishments = new Map<string, Promise<McpAuthorizationGeneration>>();

/**
 * One small atomic file per identity, shared by project workers. Reads never take
 * a lock or scan the registry. Unknown/corrupt/unavailable is always stale, never
 * generation zero. Only an explicit establish/bump can repair it under a lock.
 */
export class McpAuthorizationRegistry {
  readonly directory: string;
  constructor(agentDir: string) {
    this.directory = join(agentDir, DATA_DIR_NAME, "mcp-authorization");
  }

  private path(identity: string): string {
    if (!ID.test(identity)) throw new Error("Invalid MCP authorization identity.");
    return join(this.directory, `${identity}.json`);
  }

  async read(identity: string): Promise<McpAuthorizationGeneration | undefined> {
    const result = await this.readBounded(identity, false);
    return result.kind === "present" ? result.snapshot : undefined;
  }

  private async readBounded(identity: string, ownsLock: boolean): Promise<AuthorizationRead> {
    const path = this.path(identity);
    const started = performance.now();
    let phase = "lock-before";
    const refused = (kind: Exclude<AuthorizationRead["kind"], "present">, reason: string, code?: string): AuthorizationRead => {
      if (readDiagnostics.hasSubscribers) readDiagnostics.publish({ identity, reason, code, phase, ownsLock, elapsedMs: performance.now() - started });
      return { kind };
    };
    const lockState = async (): Promise<AuthorizationRead | undefined> => {
      if (ownsLock) return undefined;
      try { await lstat(`${path}.lock`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" ? undefined : refused("unavailable", "lock-error", code);
      }
      return refused("locked", phase === "lock-before" ? "locked-before" : "locked-after");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        (async (): Promise<AuthorizationRead> => {
          // Open first, then bound the read itself; a replacement between stat and
          // read cannot turn this into an unbounded JSON allocation.
          const before = await lockState();
          if (before) return before;
          phase = "open";
          const handle = await open(path, "r");
          try {
            const bytes = Buffer.alloc(MAX_BYTES + 1);
            if (controller.signal.aborted) return refused("unavailable", "aborted-before-read");
            phase = "read";
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            if (bytesRead > MAX_BYTES) return refused("corrupt", "oversize");
            if (controller.signal.aborted) return refused("unavailable", "aborted-after-read");
            phase = "parse";
            let parsed: unknown;
            try { parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
            catch { return refused("corrupt", "parse-error"); }
            if (!valid(parsed, identity)) return refused("corrupt", "invalid");
            phase = "lock-after";
            return await lockState() ?? { kind: "present", snapshot: parsed };
          } finally { phase = "close"; await handle.close(); }
        })().catch((error: NodeJS.ErrnoException) => refused(phase === "open" && error.code === "ENOENT" ? "missing" : "unavailable", "read-error", error.code ?? error.name)),
        new Promise<AuthorizationRead>((done) => { timer = setTimeout(() => { controller.abort(); done(refused("unavailable", "deadline")); }, READ_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async current(snapshot: McpAuthorizationGeneration): Promise<boolean> {
    const now = await this.read(snapshot.identity);
    const current = now !== undefined && now.generation.epoch === snapshot.generation.epoch
      && now.generation.counter === snapshot.generation.counter;
    if (!current && now && readDiagnostics.hasSubscribers) readDiagnostics.publish({ identity: snapshot.identity, reason: "generation-mismatch", expected: snapshot.generation, actual: now.generation });
    return current;
  }

  /**
   * Account lookup for explicit sign-in/sign-out only. Reading the epoch is not
   * an authorization check and grants no cached data or call forwarding rights.
   */
  async credentialAccount(identity: string): Promise<string> {
    const read = requireAvailable(await this.readBounded(identity, true));
    const snapshot = read.kind === "present" ? read.snapshot : await this.establish(identity);
    return mcpAuthorizationAccount(snapshot);
  }

  /** Fresh authorization/setup only; never called by a stale runtime's guard. */
  async establish(identity: string): Promise<McpAuthorizationGeneration> {
    const current = await this.readBounded(identity, false);
    if (current.kind === "present") return current.snapshot;
    if (current.kind === "unavailable") requireAvailable(current);
    const key = this.path(identity);
    const existing = establishments.get(key);
    if (existing) return existing;
    // Only this worker's first-use establishment can join its existing lock.
    // A real mutation lock stays refused; unavailable reads never join a write.
    requireAvailable(current);
    const pending = this.write(identity, false);
    establishments.set(key, pending);
    try { return await pending; }
    finally { if (establishments.get(key) === pending) establishments.delete(key); }
  }

  /** Revoke before returning success from a credential/configuration mutation. */
  bump(identity: string): Promise<McpAuthorizationGeneration> {
    return this.write(identity, true);
  }

  /** Hold all affected identities stale until a configuration mutation settles. */
  revoke<T>(identities: readonly string[], operation: (snapshots: ReadonlyMap<string, McpAuthorizationGeneration>) => Promise<T>, expected?: ReadonlyMap<string, McpAuthorizationGeneration>): Promise<T> {
    return this.mutate(new Map(identities.map(identity => [identity, true])), operation, expected);
  }

  private write(identity: string, increment: boolean): Promise<McpAuthorizationGeneration> {
    return this.mutate(new Map([[identity, increment]]), async snapshots => snapshots.get(identity)!);
  }

  /** Preflight the whole lock set before any write; never roll back revocation. */
  private async mutate<T>(changes: ReadonlyMap<string, boolean>, operation: (snapshots: ReadonlyMap<string, McpAuthorizationGeneration>) => Promise<T>, expected?: ReadonlyMap<string, McpAuthorizationGeneration>): Promise<T> {
    const ordered = [...new Set([...changes.keys(), ...(expected?.keys() ?? [])])].sort();
    const snapshots = new Map<string, McpAuthorizationGeneration>();
    if (!ordered.length) return operation(snapshots);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const releases: Array<() => Promise<void>> = [];
    let failed = false;
    try {
      for (const identity of ordered) {
        // Canonical order, no retries. A crashed owner remains reclaimable by
        // proper-lockfile; live locks fence reads throughout preflight/callback.
        const release = await lockfile.lock(this.path(identity), { realpath: false, retries: 0, stale: 5_000 }).catch(() => {
          throw new McpAuthorizationError("updating", "MCP sign-in information is being updated. Try again after the Settings change finishes.");
        });
        releases.push(release);
      }
      const previous = new Map<string, McpAuthorizationGeneration | undefined>();
      for (const identity of ordered) {
        const read = requireAvailable(await this.readBounded(identity, true));
        const snapshot = read.kind === "present" ? read.snapshot : undefined;
        const comparison = expected?.get(identity);
        if (comparison && (!snapshot || snapshot.generation.epoch !== comparison.generation.epoch || snapshot.generation.counter !== comparison.generation.counter)) {
          throw new McpAuthorizationError("revoked", "MCP access changed while sign-in information was being refreshed. Check Settings → MCP servers before reconnecting.");
        }
        previous.set(identity, snapshot);
      }
      for (const identity of ordered) {
        const before = previous.get(identity);
        const next: McpAuthorizationGeneration = before && !changes.get(identity) ? before : {
          identity,
          generation: before && before.generation.counter < Number.MAX_SAFE_INTEGER
            ? { epoch: before.generation.epoch, counter: before.generation.counter + 1 }
            : { epoch: randomUUID(), counter: 0 },
          updatedAt: Date.now(),
        };
        // CAS-only guards and established non-mutating reads keep exact bytes.
        if (next !== before) await this.persist(next);
        snapshots.set(identity, next);
      }
      // A write failure leaves earlier advances intact but never reaches this
      // callback. Callback failure likewise cannot restore old authorization.
      return await operation(snapshots);
    } catch (error) { failed = true; throw error; }
    finally {
      const released = await Promise.allSettled(releases.reverse().map(async release => release()));
      const failure = released.find(result => result.status === "rejected");
      if (!failed && failure?.status === "rejected") throw failure.reason;
    }
  }

  /** One durable atomic replacement, not an all-or-nothing multi-file commit. */
  private async persist(snapshot: McpAuthorizationGeneration): Promise<void> {
    const path = this.path(snapshot.identity);
    let temporary: string | undefined;
    try {
      temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      temporary = undefined;
      // Windows does not permit opening directories through this API. Atomic
      // replacement still applies there; POSIX additionally flushes the rename.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
}
