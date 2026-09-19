/**
 * Delete a session's checkpoint refs from every repository its working
 * directory belongs to. Best-effort: a missing git or a directory that is not
 * a repository is not a reason to refuse deleting the transcript.
 */
import { CHECKPOINT_REF_NAMESPACE } from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { runGit } from "@lasercode/protocol/git-run";
import { createWorkspaceResolver } from "../workspace.js";

const resolver = createWorkspaceResolver();

async function repoRoots(cwd: string): Promise<string[]> {
  const shape = await resolver.resolve(cwd, { rescan: true }).catch(() => undefined);
  if (!shape) return [];
  return shape.repositories.map((row) => row.root);
}

async function deleteRefs(repo: string, prefix: string): Promise<number> {
  const listed = await runGit({ cwd: repo, args: ["for-each-ref", "--format=%(refname)", prefix], timeoutMs: 8000 }).catch(
    () => undefined,
  );
  if (!listed || listed.exitCode !== 0 || listed.timedOut || listed.overflow) return 0;
  const refs = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  let removed = 0;
  for (const ref of refs) {
    const deleted = await runGit({ cwd: repo, args: ["update-ref", "-d", ref], timeoutMs: 8000 }).catch(() => undefined);
    if (deleted && deleted.exitCode === 0) removed += 1;
  }
  if (refs.length > 0) {
    await runGit({ cwd: repo, args: ["pack-refs", `--include=${CHECKPOINT_REF_NAMESPACE}/**`], timeoutMs: 15_000 }).catch(
      () => undefined,
    );
  }
  return removed;
}

export async function deleteSessionCheckpoints(cwd: string, sessionPath: string): Promise<number> {
  const prefix = `${CHECKPOINT_REF_NAMESPACE}/${checkpointSessionKey(sessionPath)}`;
  let removed = 0;
  for (const repo of await repoRoots(cwd)) removed += await deleteRefs(repo, prefix);
  return removed;
}

/** Retention Off: drop every checkpoint ref in this project's repositories now. */
export async function deleteAllCheckpoints(cwd: string): Promise<number> {
  let removed = 0;
  for (const repo of await repoRoots(cwd)) removed += await deleteRefs(repo, CHECKPOINT_REF_NAMESPACE);
  return removed;
}
