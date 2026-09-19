/**
 * Repositories this working directory belongs to, via the shared workspace
 * resolver (M18-T1).
 *
 * The resolver already knows every repository in the workspace, whether each
 * one has a work tree, and where its common dir is, under the bounds the
 * harness uses — so this is a projection, not a second walk. A bare repository
 * is excluded: there is no work tree to checkpoint.
 */
import { listCheckpointRepositories } from "@lasercode/protocol";
import { createWorkspaceResolver } from "../workspace.js";

export interface RepoRef {
  /** Work-tree root (`rev-parse --show-toplevel`). */
  path: string;
  /** Absolute git common dir (`rev-parse --git-common-dir`). */
  gitDir: string;
}

const resolver = createWorkspaceResolver();

export async function sessionRepositories(cwd: string): Promise<RepoRef[]> {
  return listCheckpointRepositories(await resolver.resolve(cwd));
}
