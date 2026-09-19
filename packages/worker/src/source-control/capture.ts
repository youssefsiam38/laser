/**
 * Capture a working tree into a hidden checkpoint ref through an isolated index.
 *
 * `git add` runs only against `GIT_INDEX_FILE` in this command's env. The
 * person's index, working tree, branches and reflog are not written.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, checkpointRef } from "@lasercode/protocol";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git-run.js";
import type { RepoRef } from "./repositories.js";
import { checkpointSessionKey } from "./session-key.js";

export interface CaptureInput {
  repo: RepoRef;
  sessionPath: string;
  turn: number;
  entryId?: string;
  timeoutMs?: number;
}

export type CaptureResult = { ok: true; ref: string; commit: string } | { ok: false; error: string };

/** Write the working tree (tracked + unignored untracked) to a tree object. Isolated index only. */
export async function writeIsolatedTree(repo: RepoRef, timeoutMs = 30_000): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  const indexPath = join(repo.gitDir, `${PRODUCT_NAME}-checkpoint-index-${randomUUID()}`);
  const isolated = { GIT_INDEX_FILE: indexPath };
  const isolatedGit = (args: readonly string[]) => runGit({ cwd: repo.path, args, env: isolated, timeoutMs });
  try {
    const head = await runGit({ cwd: repo.path, args: ["rev-parse", "--verify", "--quiet", "HEAD"], timeoutMs: Math.min(timeoutMs, 8000) });
    if (head.exitCode === 0 && head.stdout.trim()) {
      const read = await isolatedGit(["-c", "core.fsmonitor=false", "read-tree", "HEAD"]);
      if (read.exitCode !== 0) return { ok: false, error: read.stderr.trim() || "Could not read HEAD into the isolated index." };
    }
    const add = await isolatedGit(["-c", "core.fsmonitor=false", "add", "-A", "--", "."]);
    if (add.exitCode !== 0) return { ok: false, error: add.stderr.trim() || "Could not snapshot the working tree into the isolated index." };
    const tree = await isolatedGit(["-c", "core.fsmonitor=false", "write-tree"]);
    const treeOid = tree.stdout.trim();
    if (tree.exitCode !== 0 || !treeOid) return { ok: false, error: tree.stderr.trim() || "Could not write the checkpoint tree." };
    return { ok: true, tree: treeOid };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  }
}

export async function captureCheckpoint(input: CaptureInput): Promise<CaptureResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const sessionKey = checkpointSessionKey(input.sessionPath);
  const ref = checkpointRef(sessionKey, input.turn);
  const tree = await writeIsolatedTree(input.repo, timeoutMs);
  if (!tree.ok) return { ok: false, error: tree.error };
  const ident = {
    GIT_AUTHOR_NAME: PRODUCT_DISPLAY_NAME,
    GIT_AUTHOR_EMAIL: `${PRODUCT_NAME}@users.noreply.localhost`,
    GIT_COMMITTER_NAME: PRODUCT_DISPLAY_NAME,
    GIT_COMMITTER_EMAIL: `${PRODUCT_NAME}@users.noreply.localhost`,
  };
  try {
    const message = input.entryId
      ? `checkpoint turn=${input.turn} entry=${input.entryId}`
      : `checkpoint turn=${input.turn}`;
    const commit = await runGit({
      cwd: input.repo.path,
      args: ["commit-tree", tree.tree, "-m", message],
      env: ident,
      timeoutMs: Math.min(timeoutMs, 8000),
    });
    const commitOid = commit.stdout.trim();
    if (commit.exitCode !== 0 || !commitOid) {
      return { ok: false, error: commit.stderr.trim() || "Could not write the checkpoint commit." };
    }
    const published = await runGit({
      cwd: input.repo.path,
      args: ["update-ref", ref, commitOid],
      timeoutMs: Math.min(timeoutMs, 8000),
    });
    if (published.exitCode !== 0) {
      return { ok: false, error: published.stderr.trim() || "Could not publish the checkpoint ref." };
    }
    return { ok: true, ref, commit: commitOid };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
