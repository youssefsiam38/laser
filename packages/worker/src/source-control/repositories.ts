/**
 * Repositories this working directory belongs to, via the shared workspace resolver (M18-T1).
 */
import { isAbsolute, resolve } from "node:path";
import { runGit } from "./git-run.js";
import { createWorkspaceResolver } from "../workspace.js";

export interface RepoRef {
  /** Work-tree root (`rev-parse --show-toplevel`). */
  path: string;
  /** Absolute git common dir (`rev-parse --git-common-dir`). */
  gitDir: string;
}

const resolver = createWorkspaceResolver();

export async function sessionRepositories(cwd: string): Promise<RepoRef[]> {
  const shape = await resolver.resolve(cwd, { rescan: true });
  const found: RepoRef[] = [];
  for (const row of shape.repositories) {
    const repo = await repoAt(row.root);
    if (repo) found.push(repo);
  }
  return found;
}

async function repoAt(cwd: string): Promise<RepoRef | undefined> {
  const inside = await runGit({
    cwd,
    args: ["rev-parse", "--is-inside-work-tree"],
    timeoutMs: 4000,
  }).catch(() => undefined);
  if (!inside || inside.exitCode !== 0 || inside.stdout.trim() !== "true") return undefined;
  const top = await runGit({ cwd, args: ["rev-parse", "--show-toplevel"], timeoutMs: 4000 }).catch(() => undefined);
  const path = top?.stdout.trim();
  if (!path) return undefined;
  const resolved = resolve(path);
  const common = await runGit({
    cwd: resolved,
    args: ["rev-parse", "--git-common-dir"],
    timeoutMs: 4000,
  }).catch(() => undefined);
  const raw = common?.stdout.trim() || ".git";
  return { path: resolved, gitDir: isAbsolute(raw) ? raw : resolve(resolved, raw) };
}
