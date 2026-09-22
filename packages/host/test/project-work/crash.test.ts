/**
 * M21-T2: what survives a process that dies mid-write.
 *
 * A real child process, really killed with SIGKILL, then the database reopened
 * in this one. Two moments matter:
 *
 * - **after a commit** — the item is there, exactly as it was written, and the
 *   key sequence has moved past it;
 * - **before a commit** — the item is not there at all, and the key it had
 *   taken is handed to the next item, so there is no gap and no duplicate.
 *
 * Everything the store writes is inside one transaction, which is what makes
 * both of these true rather than hopeful.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { person, specBody } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));

function runUntilKilled(file: string, mode: "commit-then-kill" | "kill-before-commit", projectRoot: string): { stdout: string; signal: string | null } {
  const result = spawnSync(
    process.execPath,
    ["--import", join(here, "ts-resolve.mjs"), join(here, "crash-fixture.ts"), file, mode, projectRoot],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return { stdout: result.stdout, signal: result.signal };
}

describe("a process that dies while writing", () => {
  it("keeps exactly what had committed, and the key that went with it", () => {
    const base = mkdtempSync(join(tmpdir(), "project-work-crash-"));
    const file = join(base, "project-work.db");
    const projectRoot = join(base, "alpha");
    try {
      const killed = runUntilKilled(file, "commit-then-kill", projectRoot);
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.stdout).not.toContain("survived");

      const store = new ProjectWorkStore({ file });
      try {
        const projectId = store.projectIdFor(projectRoot, { create: false });
        expect(projectId).toBeDefined();
        const items = store.list({ projectId: projectId! }).items;
        expect(items.map((item) => item.key).sort()).toEqual(["SPEC-1", "SPEC-2"]);
        // Exact data, not just a row: the body is the one that was written.
        const second = store.get({ projectId: projectId!, key: "SPEC-2" });
        expect(second.body?.body).toEqual(specBody("second"));
        expect(second.entity.revisionCount).toBe(1);
        expect(store.verifyRevisionDigest(projectId!, second.revision.revisionId)).toBe(true);
        expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
        // The sequence moved past the key that was issued.
        expect(store.peekNextKeys(projectId!).spec).toBe("SPEC-3");
        // …and the next create takes the next key, not a used one.
        const next = store.create({ projectId: projectId!, kind: "spec", title: "Third", body: specBody("third"), origin: person, idempotencyKey: "three" });
        expect(next.entity.key).toBe("SPEC-3");
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps nothing of a write that had not committed, and issues that key next", () => {
    const base = mkdtempSync(join(tmpdir(), "project-work-crash-"));
    const file = join(base, "project-work.db");
    const projectRoot = join(base, "alpha");
    try {
      const killed = runUntilKilled(file, "kill-before-commit", projectRoot);
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.stdout).not.toContain("survived");

      const store = new ProjectWorkStore({ file });
      try {
        const projectId = store.projectIdFor(projectRoot, { create: false })!;
        const items = store.list({ projectId }).items;
        expect(items.map((item) => item.key)).toEqual(["SPEC-1"]);
        expect(store.get({ projectId, key: "SPEC-1" }).body?.body).toEqual(specBody("first"));
        expect(store.integrityCheck()).toEqual({ ok: true, problems: [] });
        // The key the dead write had taken was rolled back with it: no gap.
        expect(store.peekNextKeys(projectId).spec).toBe("SPEC-2");
        const next = store.create({ projectId, kind: "spec", title: "Second, again", body: specBody("second again"), origin: person, idempotencyKey: "two" });
        expect(next.entity.key).toBe("SPEC-2");
        // The idempotency record died with the transaction, so this is a real
        // write rather than a replay of something that never happened.
        expect(next.replayed).toBeUndefined();
        expect(store.seq(projectId)).toBe(2);
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
