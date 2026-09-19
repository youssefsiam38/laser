/**
 * Narrow seam for "which repositories does this working directory belong to".
 *
 * TODO(M18-T1): replace this body with the shared workspace resolver
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runGit } from "./git-run.js";

export interface RepoRef {
  /** Work-tree root (`rev-parse --show-toplevel`). */
  path: string;
  /** Absolute git common dir (`rev-parse --git-common-dir`). */
  gitDir: string;
}

const SKIP_NAMES = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", ".git"]);
const MAX_CHILDREN = 64;
const MAX_DIR_ENTRIES = 256;

export async function sessionRepositories(cwd: string): Promise<RepoRef[]> {
  const root = resolve(cwd);
  const self = await repoAt(root);
  if (self) return [self];
  // TODO(M18-T1): replace this body with the shared workspace resolver
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: RepoRef[] = [];
  for (const name of names.slice(0, MAX_DIR_ENTRIES)) {
    if (SKIP_NAMES.has(name) || name.startsWith(".")) continue;
    const child = await repoAt(join(root, name));
    if (child) found.push(child);
    if (found.length >= MAX_CHILDREN) break;
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
