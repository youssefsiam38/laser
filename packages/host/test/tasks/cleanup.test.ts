/**
 * Crash cleanup of the command-log root (RP-6).
 *
 * It happens here, at host start, because that is the only moment at which a
 * leftover can be told from live work without guessing: this host has not
 * spawned a worker, so nothing is writing. Every rule below is about that.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLEANUP_PASS_ENTRIES, CLEANUP_REMOVALS_MAX, cleanupTaskLogsBeforeWorkers, nodeCleanupIo } from "../../src/tasks/cleanup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-log-cleanup-"));
  dirs.push(dir);
  return dir;
}

it("removes what a run that is gone left behind, whatever its age", async () => {
  const dir = root();
  // Age decides nothing: a directory written a second ago is as much a
  // leftover as one written last week, because no worker of this host exists
  // yet. The bug this replaces was a worker deleting a *live* session's
  // directory because it had been quiet for a day.
  for (const name of ["a".repeat(32), "b".repeat(32)]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "t-1.0.log"), "left behind");
  }
  writeFileSync(join(dir, "not-a-directory"), "kept: only directories are sessions");

  expect(await cleanupTaskLogsBeforeWorkers(dir)).toBe(2);
  expect(existsSync(join(dir, "a".repeat(32)))).toBe(false);
  expect(existsSync(join(dir, "b".repeat(32)))).toBe(false);
  expect(existsSync(join(dir, "not-a-directory"))).toBe(true);
});

it("walks every candidate cooperatively, with a ceiling on what it removes", async () => {
  const dir = root();
  const removed: string[] = [];
  let paused = 0;
  const names = Array.from({ length: CLEANUP_PASS_ENTRIES * 3 + 7 }, (_, index) => `s${index}`);
  const count = await cleanupTaskLogsBeforeWorkers(dir, {
    entries: async function* () {
      for (const name of names) yield { name, isDirectory: true };
    },
    remove: async (path) => {
      removed.push(path);
    },
    pause: async () => {
      paused += 1;
    },
  });
  expect(count).toBe(names.length);
  expect(removed).toHaveLength(names.length);
  // It yielded to the event loop instead of doing it all in one turn, and it
  // reached the last candidate rather than the first slice of a listing.
  expect(paused).toBe(3);
  expect(removed.at(-1)).toContain(names.at(-1)!);
  expect(CLEANUP_REMOVALS_MAX).toBeGreaterThan(names.length);
});

it("stops at its removal ceiling rather than turning housekeeping into a job", async () => {
  const dir = root();
  let removed = 0;
  const count = await cleanupTaskLogsBeforeWorkers(dir, {
    entries: async function* () {
      for (let index = 0; index < CLEANUP_REMOVALS_MAX + 500; index += 1) yield { name: `s${index}`, isDirectory: true };
    },
    remove: async () => {
      removed += 1;
    },
    pause: async () => {},
  });
  expect(count).toBe(CLEANUP_REMOVALS_MAX);
  expect(removed).toBe(CLEANUP_REMOVALS_MAX);
});

it("says nothing and fails nothing when there is no root, or a directory will not go", async () => {
  expect(await cleanupTaskLogsBeforeWorkers(join(root(), "never-made"))).toBe(0);
  const dir = root();
  mkdirSync(join(dir, "stubborn"));
  const count = await cleanupTaskLogsBeforeWorkers(dir, {
    ...nodeCleanupIo,
    remove: async () => {
      throw new Error("permission denied");
    },
  });
  expect(count).toBe(0);
  expect(existsSync(join(dir, "stubborn"))).toBe(true);
});
