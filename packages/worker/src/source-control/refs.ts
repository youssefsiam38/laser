import { CHECKPOINT_REF_NAMESPACE, parseCheckpointRef, type CheckpointInfo } from "@lasercode/protocol";
import { runGit } from "./git-run.js";
import type { RepoRef } from "./repositories.js";
import { checkpointSessionKey } from "./session-key.js";

const LIST_FORMAT = "%(refname)%00%(objectname)%00%(creatordate:iso-strict)%00%(contents:subject)";

export async function listSessionCheckpoints(repo: RepoRef, sessionPath: string): Promise<CheckpointInfo[]> {
  const prefix = `${CHECKPOINT_REF_NAMESPACE}/${checkpointSessionKey(sessionPath)}`;
  const listed = await runGit({
    cwd: repo.path,
    args: ["for-each-ref", `--format=${LIST_FORMAT}`, prefix],
    timeoutMs: 8000,
  }).catch(() => undefined);
  if (!listed || listed.exitCode !== 0 || !listed.stdout) return [];
  const rows: CheckpointInfo[] = [];
  for (const chunk of listed.stdout.split("\n")) {
    if (!chunk) continue;
    const [ref, commit, createdAt, subject] = chunk.split("\0");
    if (!ref || !commit) continue;
    const parsed = parseCheckpointRef(ref);
    if (!parsed) continue;
    const entryId = entryIdFromSubject(subject ?? "");
    rows.push({
      turn: parsed.turn,
      ref,
      commit,
      createdAt: createdAt || "",
      ...(entryId ? { entryId } : {}),
    });
  }
  rows.sort((a, b) => a.turn - b.turn);
  return rows;
}

export async function deleteCheckpointRef(repo: RepoRef, ref: string): Promise<void> {
  await runGit({ cwd: repo.path, args: ["update-ref", "-d", ref], timeoutMs: 8000 }).catch(() => undefined);
}

export async function packCheckpointRefs(repo: RepoRef): Promise<void> {
  await runGit({
    cwd: repo.path,
    args: ["pack-refs", `--include=${CHECKPOINT_REF_NAMESPACE}/**`],
    timeoutMs: 15_000,
  }).catch(() => undefined);
}

export async function deleteSessionCheckpointRefs(repo: RepoRef, sessionPath: string): Promise<number> {
  const rows = await listSessionCheckpoints(repo, sessionPath);
  for (const row of rows) await deleteCheckpointRef(repo, row.ref);
  if (rows.length > 0) await packCheckpointRefs(repo);
  return rows.length;
}

function entryIdFromSubject(subject: string): string | undefined {
  const match = /(?:^|\s)entry=(\S+)/.exec(subject);
  return match?.[1];
}
