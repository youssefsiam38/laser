/**
 * Path and ref fences for git actions. A repository must sit inside the
 * project; a pathspec must not look like a flag; a branch name is checked
 * with `git check-ref-format` rather than a homemade regex.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProcessRunner } from "./runner.js";

export class GitActionError extends Error {
  override readonly name = "GitActionError";
  constructor(
    message: string,
    readonly outcome: "refused" | "uncertain" | "needs_copy" = "refused",
  ) {
    super(message);
  }
}

export async function resolveRepoRoot(projectCwd: string, repo: string | undefined): Promise<string> {
  const root = await realpath(projectCwd).catch(() => resolve(projectCwd));
  const targetPath = resolve(root, repo ?? ".");
  const target = await realpath(targetPath).catch(() => targetPath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new GitActionError("That repository is not part of this project.");
  }
  return target;
}

/** Relative pathspecs only, never flags, never NUL, never a climb out of the repo. */
export function assertPathspec(path: string): string {
  if (!path || path.includes("\0")) throw new GitActionError("That path cannot be committed.");
  if (path.startsWith("-")) throw new GitActionError("A path cannot start with a dash.");
  const normalised = path.replaceAll("\\", "/");
  if (isAbsolute(normalised) || normalised.split("/").includes("..")) {
    throw new GitActionError("A path must stay inside the repository.");
  }
  return path;
}

export async function assertBranchName(run: ProcessRunner, cwd: string, name: string): Promise<string> {
  if (!name || name.startsWith("-") || name.includes("\0")) {
    throw new GitActionError("That is not a branch name.");
  }
  const result = await run("git", ["check-ref-format", "--branch", name], { cwd, timeoutMs: 5_000 });
  if (result.code !== 0) throw new GitActionError("That is not a branch name.");
  return name;
}

/** A start-point: branch, tag or commit. Rejects option-shaped values. */
export async function assertCommitish(run: ProcessRunner, cwd: string, name: string): Promise<string> {
  if (!name || name.startsWith("-") || name.includes("\0")) {
    throw new GitActionError("That is not a commit, branch or tag.");
  }
  const result = await run("git", ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { cwd, timeoutMs: 5_000 });
  if (result.code !== 0) throw new GitActionError(`There is no commit named ${name}.`);
  return name;
}

export async function assertRemoteName(run: ProcessRunner, cwd: string, name: string): Promise<string> {
  if (!name || name.startsWith("-") || name.includes("\0") || name.includes("/")) {
    throw new GitActionError("That is not a remote name.");
  }
  const result = await run("git", ["remote"], { cwd, timeoutMs: 5_000 });
  const remotes = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!remotes.includes(name)) throw new GitActionError(`There is no remote named ${name}.`);
  return name;
}
