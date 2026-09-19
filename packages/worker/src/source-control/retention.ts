import { checkpointRetentionKeep, type CheckpointRetention } from "@lasercode/protocol";
import { deleteCheckpointRef, listSessionCheckpoints, packCheckpointRefs } from "./refs.js";
import type { RepoRef } from "./repositories.js";

export async function pruneSessionCheckpoints(
  repo: RepoRef,
  sessionPath: string,
  retention: CheckpointRetention,
): Promise<number> {
  const keep = checkpointRetentionKeep(retention);
  const rows = await listSessionCheckpoints(repo, sessionPath);
  if (keep === null) return 0;
  const extra = keep === 0 ? rows : rows.slice(0, Math.max(0, rows.length - keep));
  for (const row of extra) await deleteCheckpointRef(repo, row.ref);
  if (extra.length > 0) await packCheckpointRefs(repo);
  return extra.length;
}
