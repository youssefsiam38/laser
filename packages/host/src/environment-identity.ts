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
 * A file we cannot read or parse is replaced. That invalidates device caches,
 * which is safe; keeping a value we cannot trust would not be.
 */
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { environmentKeyOf } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

const FILE_NAME = "environment.json";
const FILE_VERSION = 1;
/** A UUID and nothing else; anything shorter is not an identity we minted. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvironmentIdentity {
  /** Trusted processes only. Never send, log or export this. */
  readonly id: string;
  /** Public, opaque, stable. Safe in results. */
  readonly key: string;
}

export function environmentIdentity(stateDir: string): EnvironmentIdentity {
  const path = join(stateDir, FILE_NAME);
  const existing = readIdentity(path);
  const id = existing ?? createIdentity(path);
  return { id, key: environmentKeyOf(nodeRevisionHasher, id) };
}

function readIdentity(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = parsed as { version?: unknown; id?: unknown } | null;
    if (record?.version !== FILE_VERSION || typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return undefined;
    return record.id;
  } catch {
    return undefined;
  }
}

/**
 * Created exclusively (`wx`) and a loser re-reads the winner, so concurrent
 * hosts never overwrite each other's identity. A state directory we cannot
 * write to still yields a working process-lifetime identity: revisions stay
 * correct for this run, and only cross-restart cache reuse is lost.
 */
function createIdentity(path: string): string {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
  } catch {
    return randomUUID();
  }
  // An invalid predecessor cannot be adopted. Remove it, then compete to
  // create the replacement without ever overwriting another host's winner.
  try {
    unlinkSync(path);
  } catch {
    /* absent, or not ours to replace */
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomUUID();
    const temporary = `${path}.${process.pid}.${id}.tmp`;
    let fd: number | undefined;
    try {
      // Finish private bytes first, then link that inode into the final name.
      // `link` is exclusive: unlike rename it cannot replace another winner.
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: FILE_VERSION, id, createdAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      fd = undefined;
      linkSync(temporary, path);
      unlinkSync(temporary);
      return id;
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temporary); } catch { /* best effort */ }
      // The exclusive install lost a race: adopt its complete winner.
      const winner = readIdentity(path);
      if (winner) return winner;
    }
  }

  // A state directory we cannot write still gets a process-lifetime identity.
  return randomUUID();
}
