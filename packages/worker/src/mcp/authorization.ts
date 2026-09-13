import { createHash, randomUUID } from "node:crypto";
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
  readonly code: "MCP_AUTHORIZATION_UPDATING" | "MCP_AUTHORIZATION_CHANGED";
  constructor(readonly reason: "updating" | "revoked", message: string) {
    super(message);
    this.code = reason === "updating" ? "MCP_AUTHORIZATION_UPDATING" : "MCP_AUTHORIZATION_CHANGED";
  }
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

  read(identity: string): Promise<McpAuthorizationGeneration | undefined> {
    return this.readBounded(identity, false);
  }

  private async readBounded(identity: string, ownsLock: boolean): Promise<McpAuthorizationGeneration | undefined> {
    const path = this.path(identity);
    const locked = async () => ownsLock ? false : lstat(`${path}.lock`).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        (async () => {
          // Open first, then bound the read itself; a replacement between stat and
          // read cannot turn this into an unbounded JSON allocation.
          if (await locked()) return undefined;
          const handle = await open(path, "r");
          try {
            const bytes = Buffer.alloc(MAX_BYTES + 1);
            if (controller.signal.aborted) return undefined;
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            if (bytesRead > MAX_BYTES || controller.signal.aborted) return undefined;
            const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
            return valid(parsed, identity) && !await locked() ? parsed : undefined;
          } finally { await handle.close(); }
        })().catch(() => undefined),
        new Promise<undefined>((done) => { timer = setTimeout(() => { controller.abort(); done(undefined); }, READ_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async current(snapshot: McpAuthorizationGeneration): Promise<boolean> {
    const now = await this.read(snapshot.identity);
    return now !== undefined && now.generation.epoch === snapshot.generation.epoch
      && now.generation.counter === snapshot.generation.counter;
  }

  /**
   * Account lookup for explicit sign-in/sign-out only. Reading the epoch is not
   * an authorization check and grants no cached data or call forwarding rights.
   */
  async credentialAccount(identity: string): Promise<string> {
    const snapshot = await this.readBounded(identity, true) ?? await this.establish(identity);
    return mcpAuthorizationAccount(snapshot);
  }

  /** Fresh authorization/setup only; never called by a stale runtime's guard. */
  async establish(identity: string): Promise<McpAuthorizationGeneration> {
    const current = await this.read(identity);
    if (current) return current;
    const key = this.path(identity);
    const existing = establishments.get(key);
    if (existing) return existing;
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
  async revoke<T>(identities: readonly string[], operation: (snapshots: ReadonlyMap<string, McpAuthorizationGeneration>) => Promise<T>, expected?: ReadonlyMap<string, McpAuthorizationGeneration>): Promise<T> {
    const snapshots = new Map<string, McpAuthorizationGeneration>();
    const affected = new Set(identities);
    const ordered = [...new Set([...identities, ...(expected?.keys() ?? [])])].sort();
    let result: T;
    const next = async (index: number): Promise<void> => {
      const identity = ordered[index];
      if (identity === undefined) { result = await operation(snapshots); return; }
      await this.write(identity, affected.has(identity), snapshot => { snapshots.set(identity, snapshot); return next(index + 1); }, expected?.get(identity));
    };
    await next(0);
    return result!;
  }

  private async write(identity: string, increment: boolean, operation?: (snapshot: McpAuthorizationGeneration) => Promise<void>, expected?: McpAuthorizationGeneration): Promise<McpAuthorizationGeneration> {
    const path = this.path(identity);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Atomic directory lock; no retry queue on a model/person hot path. A crashed
    // owner is reclaimable after proper-lockfile's stale interval.
    const release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 5_000 }).catch(() => {
      throw new McpAuthorizationError("updating", "MCP sign-in information is being updated. Try again after the Settings change finishes.");
    });
    let temporary: string | undefined;
    try {
      const previous = await this.readBounded(identity, true);
      if (expected && (!previous || previous.generation.epoch !== expected.generation.epoch || previous.generation.counter !== expected.generation.counter)) {
        throw new McpAuthorizationError("revoked", "MCP access changed while sign-in information was being refreshed. Check Settings → MCP servers before reconnecting.");
      }
      if (previous && !increment) {
        await operation?.(previous);
        return previous;
      }
      const next: McpAuthorizationGeneration = {
        identity,
        generation: previous && previous.generation.counter < Number.MAX_SAFE_INTEGER
          ? { epoch: previous.generation.epoch, counter: previous.generation.counter + 1 }
          : { epoch: randomUUID(), counter: 0 },
        updatedAt: Date.now(),
      };
      temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      temporary = undefined;
      // Windows does not permit opening directories through this API. Atomic
      // replacement still applies there; POSIX additionally flushes the rename.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await operation?.(next);
      return next;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await release();
    }
  }
}
