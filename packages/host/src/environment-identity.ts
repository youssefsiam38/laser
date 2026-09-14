/**
 * This environment's identity (RP-9).
 *
 * A durable revision has to mean "this conversation, in this environment": the
 * same bytes on someone else's machine, in a second install, or in another
 * hosted workspace must not validate a cached view here. That needs one stable
 * value per environment, and the only honest place for it is the one directory
 * this environment owns — not a path, an origin, a hostname or a port, all of
 * which move without the environment changing.
 *
 * Two values come out of it:
 *
 * - `id` — a random UUID, created once and kept in `<stateDir>/environment.json`.
 *   It stays inside the trusted host and worker processes. It is not a secret
 *   (it crosses to the worker as a spawn argument, visible to the same person's
 *   own process table), but it is never published: not in a result, not in a
 *   log line, not in a diagnostic export.
 * - `key` — the public, opaque, irreversible 132-bit value clients key their
 *   caches by. RP-13's environment descriptor will carry this same key.
 *
 * A file we cannot read or parse is replaced under an exclusive lock. That
 * invalidates device caches, which is safe; keeping a value we cannot trust
 * would not be.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { environmentKeyOf } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

const FILE_NAME = "environment.json";
const FILE_VERSION = 1;
const LOCK_ATTEMPTS = 8;
/** A UUID and nothing else; anything shorter is not an identity we minted. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvironmentIdentity {
  /** Trusted processes only. Never send, log or export this. */
  readonly id: string;
  /** Public, opaque, stable. Safe in results. */
  readonly key: string;
}

/** Internal state-machine seam; this module is not part of the host package's public exports. */
export interface EnvironmentIdentityFiles {
  prepare(path: string): boolean;
  read(path: string): string | undefined;
  acquire(path: string): { kind: "acquired"; token: unknown } | { kind: "contended" } | { kind: "unavailable" };
  install(path: string): string | undefined;
  release(path: string, token: unknown): void;
  wait(attempt: number): void;
  transientId(): string;
}

export function environmentIdentity(stateDir: string, files: EnvironmentIdentityFiles = nodeIdentityFiles): EnvironmentIdentity {
  const path = join(stateDir, FILE_NAME);
  const existing = files.read(path);
  const id = existing ?? createIdentity(path, files);
  return { id, key: environmentKeyOf(nodeRevisionHasher, id) };
}

function parseIdentity(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const record = parsed as { version?: unknown; id?: unknown } | null;
    if (record?.version !== FILE_VERSION || typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return undefined;
    return record.id;
  } catch {
    return undefined;
  }
}

/**
 * Every mutation happens while holding `<path>.lock`. A contender never
 * unlinks `path`: after acquiring the lock it re-reads, so a winner installed
 * between the initial read and lock acquisition is adopted rather than erased.
 */
function createIdentity(path: string, files: EnvironmentIdentityFiles): string {
  if (!files.prepare(path)) return files.transientId();
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const lock = files.acquire(lockPath);
    if (lock.kind === "unavailable") return files.transientId();
    if (lock.kind === "contended") {
      // Installation is a completed rename, so a valid value is safe to adopt
      // even just before its owner removes the lock.
      const winner = files.read(path);
      if (winner) return winner;
      files.wait(attempt);
      continue;
    }

    try {
      // This is the decisive re-read under exclusive ownership. Only an absent
      // or still-invalid predecessor reaches `install`, which may replace it.
      const winner = files.read(path);
      if (winner) return winner;
      const installed = files.install(path);
      if (installed) return installed;
    } finally {
      files.release(lockPath, lock.token);
    }
    files.wait(attempt);
  }

  // A contended/unwritable state directory still gets a process-lifetime id.
  return files.transientId();
}

const sleep = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const nodeIdentityFiles: EnvironmentIdentityFiles = {
  prepare(path) {
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
  read(path) {
    try {
      return parseIdentity(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  },
  acquire(path) {
    try {
      return { kind: "acquired", token: openSync(path, "wx", 0o600) };
    } catch (error) {
      return (error as { code?: string }).code === "EEXIST" ? { kind: "contended" } : { kind: "unavailable" };
    }
  },
  install(path) {
    const id = randomUUID();
    const temporary = `${path}.${process.pid}.${id}.tmp`;
    let fd: number | undefined;
    try {
      // The final name sees complete bytes in one rename. The lock, not rename,
      // supplies exclusivity; rename is used only while that lock is held.
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: FILE_VERSION, id, createdAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      return id;
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      return undefined;
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or best-effort cleanup */ }
    }
  },
  release(path, token) {
    try { closeSync(token as number); } finally {
      try { unlinkSync(path); } catch { /* best-effort lock cleanup */ }
    }
  },
  wait(attempt) {
    sleep(Math.min(4, 1 << attempt));
  },
  transientId: randomUUID,
};
