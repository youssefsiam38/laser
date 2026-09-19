/**
 * Capture a working tree into a hidden checkpoint ref through an isolated index.
 *
 * `git add` runs only against `GIT_INDEX_FILE` in this command's env. The
 * person's index, working tree, branches and reflog are not written.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, checkpointRef } from "@lasercode/protocol";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runGit as defaultRunGit, type GitRunOptions, type GitRunResult } from "./git-run.js";
import type { RepoRef } from "./repositories.js";
import { checkpointSessionKey } from "./session-key.js";

export type CheckpointGitRun = (options: GitRunOptions) => Promise<GitRunResult>;

export interface CaptureInput {
  repo: RepoRef;
  sessionPath: string;
  turn: number;
  entryId?: string;
  timeoutMs?: number;
  run?: CheckpointGitRun;
  /** When true, do not publish a ref — the snapshot may already be late. */
  aborted?: () => boolean;
}

export type CaptureResult = { ok: true; ref: string; commit: string } | { ok: false; error: string };

const indexLocks = new Map<string, Promise<void>>();
const sweptGitDirs = new Set<string>();

function durableIndexPath(gitDir: string): string {
  return join(gitDir, `${PRODUCT_NAME}-checkpoint-index`);
}

function sweepLegacyIndexes(gitDir: string): void {
  if (sweptGitDirs.has(gitDir)) return;
  sweptGitDirs.add(gitDir);
  const prefix = `${PRODUCT_NAME}-checkpoint-index-`;
  let names: string[] = [];
  try {
    names = readdirSync(gitDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    rmSync(join(gitDir, name), { force: true });
  }
}

async function withRepoIndex<T>(gitDir: string, work: () => Promise<T>): Promise<T> {
  const previous = indexLocks.get(gitDir) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  indexLocks.set(
    gitDir,
    previous.then(() => held),
  );
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

export function checkpointCommitMessage(turn: number, options?: { entryId?: string; failed?: boolean }): string {
  const lines = ["checkpoint", "", `Turn: ${turn}`];
  if (options?.entryId) lines.push(`Entry: ${options.entryId}`);
  if (options?.failed) lines.push("Failed: 1");
  return `${lines.join("\n")}\n`;
}

function identEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: PRODUCT_DISPLAY_NAME,
    GIT_AUTHOR_EMAIL: `${PRODUCT_NAME}@users.noreply.localhost`,
    GIT_COMMITTER_NAME: PRODUCT_DISPLAY_NAME,
    GIT_COMMITTER_EMAIL: `${PRODUCT_NAME}@users.noreply.localhost`,
  };
}

const ABORTED = "The checkpoint was not captured in time.";

/** Write the working tree (tracked + unignored untracked) to a tree object. Isolated index only. */
export async function writeIsolatedTree(
  repo: RepoRef,
  timeoutMs = 30_000,
  options?: { run?: CheckpointGitRun; aborted?: () => boolean },
): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  const exec = options?.run ?? defaultRunGit;
  const aborted = () => options?.aborted?.() === true;
  return withRepoIndex(repo.gitDir, async () => {
    sweepLegacyIndexes(repo.gitDir);
    const indexPath = durableIndexPath(repo.gitDir);
    const isolated = { GIT_INDEX_FILE: indexPath };
    const isolatedGit = (args: readonly string[]) => exec({ cwd: repo.path, args, env: isolated, timeoutMs });
    try {
      if (aborted()) return { ok: false, error: ABORTED };
      const head = await exec({ cwd: repo.path, args: ["rev-parse", "--verify", "--quiet", "HEAD"], timeoutMs: Math.min(timeoutMs, 8000) });
      if (head.timedOut || head.overflow) return { ok: false, error: "Reading HEAD took too long or the result was too large." };
      if (head.exitCode === 0 && head.stdout.trim()) {
        if (aborted()) return { ok: false, error: ABORTED };
        const read = await isolatedGit(["-c", "core.fsmonitor=false", "read-tree", "HEAD"]);
        if (read.timedOut || read.overflow) return { ok: false, error: "Reading HEAD into the isolated index took too long or the result was too large." };
        if (read.exitCode !== 0) return { ok: false, error: read.stderr.trim() || "Could not read HEAD into the isolated index." };
      }
      if (aborted()) return { ok: false, error: ABORTED };
      const add = await isolatedGit(["-c", "core.fsmonitor=false", "add", "-A", "--", "."]);
      if (add.timedOut || add.overflow) return { ok: false, error: "Snapshotting the working tree took too long or the result was too large." };
      if (add.exitCode !== 0) return { ok: false, error: add.stderr.trim() || "Could not snapshot the working tree into the isolated index." };
      if (aborted()) return { ok: false, error: ABORTED };
      const tree = await isolatedGit(["-c", "core.fsmonitor=false", "write-tree"]);
      if (tree.timedOut || tree.overflow) return { ok: false, error: "Writing the checkpoint tree took too long or the result was too large." };
      const treeOid = tree.stdout.trim();
      if (tree.exitCode !== 0 || !treeOid) return { ok: false, error: tree.stderr.trim() || "Could not write the checkpoint tree." };
      if (aborted()) return { ok: false, error: ABORTED };
      return { ok: true, tree: treeOid };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export async function publishFailedCheckpoint(input: CaptureInput, previousCommit?: string): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const exec = input.run ?? defaultRunGit;
  const sessionKey = checkpointSessionKey(input.sessionPath);
  const ref = checkpointRef(sessionKey, input.turn);
  const source = previousCommit ? `${previousCommit}^{tree}` : "HEAD^{tree}";
  const tree = await exec({
    cwd: input.repo.path,
    args: ["rev-parse", "--verify", "--quiet", source],
    timeoutMs: Math.min(timeoutMs, 8000),
  });
  const treeOid = tree.stdout.trim();
  if (tree.exitCode !== 0 || !treeOid) return false;
  const commit = await exec({
    cwd: input.repo.path,
    args: ["commit-tree", treeOid, "-m", checkpointCommitMessage(input.turn, { ...(input.entryId ? { entryId: input.entryId } : {}), failed: true })],
    env: identEnv(),
    timeoutMs: Math.min(timeoutMs, 8000),
  });
  const commitOid = commit.stdout.trim();
  if (commit.exitCode !== 0 || !commitOid) return false;
  const published = await exec({
    cwd: input.repo.path,
    args: ["update-ref", ref, commitOid],
    timeoutMs: Math.min(timeoutMs, 8000),
  });
  return published.exitCode === 0;
}

export async function captureCheckpoint(input: CaptureInput): Promise<CaptureResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const exec = input.run ?? defaultRunGit;
  const aborted = () => input.aborted?.() === true;
  const sessionKey = checkpointSessionKey(input.sessionPath);
  const ref = checkpointRef(sessionKey, input.turn);
  if (aborted()) return { ok: false, error: ABORTED };
  const tree = await writeIsolatedTree(input.repo, timeoutMs, {
    run: exec,
    ...(input.aborted ? { aborted: input.aborted } : {}),
  });
  if (!tree.ok) return { ok: false, error: tree.error };
  if (aborted()) return { ok: false, error: ABORTED };
  try {
    const commit = await exec({
      cwd: input.repo.path,
      args: ["commit-tree", tree.tree, "-m", checkpointCommitMessage(input.turn, input.entryId ? { entryId: input.entryId } : undefined)],
      env: identEnv(),
      timeoutMs: Math.min(timeoutMs, 8000),
    });
    const commitOid = commit.stdout.trim();
    if (commit.timedOut || commit.overflow) return { ok: false, error: "Writing the checkpoint commit took too long or the result was too large." };
    if (commit.exitCode !== 0 || !commitOid) {
      return { ok: false, error: commit.stderr.trim() || "Could not write the checkpoint commit." };
    }
    if (aborted()) return { ok: false, error: ABORTED };
    const published = await exec({
      cwd: input.repo.path,
      args: ["update-ref", ref, commitOid],
      timeoutMs: Math.min(timeoutMs, 8000),
    });
    if (published.timedOut || published.overflow) return { ok: false, error: "Publishing the checkpoint ref took too long or the result was too large." };
    if (published.exitCode !== 0) {
      return { ok: false, error: published.stderr.trim() || "Could not publish the checkpoint ref." };
    }
    return { ok: true, ref, commit: commitOid };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
