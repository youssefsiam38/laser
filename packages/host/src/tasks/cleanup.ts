/**
 * What a crashed run left in the command-log root (RP-6).
 *
 * Command logs live in one private directory of the host's state, shared by
 * every worker this host starts. Nothing inside it can tell, from the outside,
 * whether a session directory belongs to a command that is still writing: a
 * quiet command holding one segment open for a day leaves a directory that
 * looks exactly like a run that died. A worker deleting "old" directories from
 * that shared root would eventually delete another worker's live session.
 *
 * So the cleanup happens here, once, **at host start — before any worker has
 * been spawned**. At that moment this host has no writers at all, so every
 * directory in its own root is left over from a run that is gone. Ownership
 * during the run belongs to the runtimes that wrote the files and to the task
 * register that knows which tasks still exist; age never decides anything
 * while a worker could be writing.
 *
 * It is bounded and cooperative: an async directory iterator with a cursor,
 * a pause every `CLEANUP_PASS_ENTRIES` entries and a hard removal ceiling, so
 * a root with a hundred thousand leftovers cannot hold the event loop.
 */
import { opendir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Entries one pass looks at before yielding to the event loop. */
export const CLEANUP_PASS_ENTRIES = 200;
/** Directories one whole cleanup may remove. Housekeeping, not a repair job. */
export const CLEANUP_REMOVALS_MAX = 10_000;

export interface CleanupIo {
  entries(directory: string): AsyncIterable<{ name: string; isDirectory: boolean }>;
  remove(path: string): Promise<void>;
  pause(): Promise<void>;
}

export const nodeCleanupIo: CleanupIo = {
  entries: async function* (directory: string) {
    const handle = await opendir(directory);
    for await (const entry of handle) yield { name: entry.name, isDirectory: entry.isDirectory() };
  },
  remove: (path) => rm(path, { recursive: true, force: true }),
  pause: () => new Promise<void>((resolve) => setImmediate(resolve)),
};

/**
 * Remove every session directory in `root`. Safe **only** before this host has
 * spawned a worker; the caller is what guarantees that, which is why this
 * takes no age and makes no guess.
 */
export async function cleanupTaskLogsBeforeWorkers(root: string, io: CleanupIo = nodeCleanupIo): Promise<number> {
  let removed = 0;
  let seen = 0;
  try {
    for await (const entry of io.entries(root)) {
      seen += 1;
      if (seen % CLEANUP_PASS_ENTRIES === 0) await io.pause();
      if (removed >= CLEANUP_REMOVALS_MAX) break;
      if (!entry.isDirectory) continue;
      try {
        await io.remove(join(root, entry.name));
        removed += 1;
      } catch {
        // Not ours to remove, or gone already. Neither is a reason to fail.
      }
    }
  } catch {
    // No root yet: nothing was left behind.
  }
  return removed;
}
