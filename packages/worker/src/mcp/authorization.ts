import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, unlink, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { DATA_DIR_NAME, type McpScope } from "@lasercode/protocol";
import type { McpConfiguredServer } from "./store.js";

/** Names and credentials are deliberately not authorization identities. */
export async function mcpAuthorizationIdentity(scope: McpScope, cwd: string, config: McpConfiguredServer): Promise<string> {
  const project = scope === "global" ? "global" : await realpath(cwd).catch(() => resolve(cwd));
  const transport = config.transport;
  const target = transport.kind === "http"
    ? ["http", transport.url]
    : transport.kind === "stdio"
      ? ["stdio", transport.command, transport.args ?? []]
      : ["socket", resolve(cwd, transport.path)];
  return createHash("sha256").update(JSON.stringify([scope, project, target])).digest("hex");
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

  /** Fresh authorization/setup only; never called by a stale runtime's guard. */
  establish(identity: string): Promise<McpAuthorizationGeneration> {
    return this.write(identity, false);
  }

  /** Revoke before returning success from a credential/configuration mutation. */
  bump(identity: string): Promise<McpAuthorizationGeneration> {
    return this.write(identity, true);
  }

  private async write(identity: string, increment: boolean): Promise<McpAuthorizationGeneration> {
    const path = this.path(identity);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Atomic directory lock; no retry queue on a model/person hot path. A crashed
    // owner is reclaimable after proper-lockfile's stale interval.
    const release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 5_000 }).catch(() => {
      throw new Error("MCP sign-in information is being updated. Try again.");
    });
    let temporary: string | undefined;
    try {
      const previous = await this.readBounded(identity, true);
      if (previous && !increment) return previous;
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
      return next;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await release();
    }
  }
}
