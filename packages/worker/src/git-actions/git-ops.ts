/**
 * Local git mutations: commit an explicit path set, push without force, create
 * a branch from an explicit base. Every user value is an argv element.
 */
import type { GitActionConfirmation, GitActionCopyable, GitActionResult } from "@lasercode/protocol";
import { GitActionError, assertBranchName, assertCommitish, assertPathspec, assertRemoteName } from "./paths.js";
import { hiddenRefPrefix, isHiddenProductRef } from "./remotes.js";
import { combinedOutput, looksUncertain, type ProcessRunner } from "./runner.js";

export async function currentBranch(run: ProcessRunner, repo: string): Promise<string> {
  const named = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  if (named) return named;
  throw new GitActionError("Check out a branch first. Detached HEAD cannot be pushed or committed as a branch.");
}

export async function fullRef(run: ProcessRunner, repo: string, name: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--symbolic-full-name", name], { cwd: repo, timeoutMs: 5_000 });
  return result.stdout.trim() || name;
}

export async function refuseHiddenRef(run: ProcessRunner, repo: string, name: string): Promise<void> {
  if (isHiddenProductRef(name)) {
    throw new GitActionError(`That ref sits under ${hiddenRefPrefix()} and cannot be pushed.`);
  }
  const resolved = await fullRef(run, repo, name);
  if (isHiddenProductRef(resolved)) {
    throw new GitActionError(`That ref sits under ${hiddenRefPrefix()} and cannot be pushed.`);
  }
}

export function copyable(argv: string[], cwd: string, url?: string): GitActionCopyable {
  return url ? { argv, cwd, url } : { argv, cwd };
}

export function previewResult(confirmation: GitActionConfirmation, copy: GitActionCopyable, extra?: Partial<GitActionResult>): GitActionResult {
  return { outcome: "preview", confirmation, copyable: copy, ...extra };
}

export async function commitPaths(
  run: ProcessRunner,
  repo: string,
  paths: readonly string[],
  message: string,
  confirm: boolean | undefined,
): Promise<GitActionResult & { commit?: { hash: string; subject: string } }> {
  const files = paths.map(assertPathspec);
  const branch = await currentBranch(run, repo);
  const confirmation: GitActionConfirmation = {
    repo,
    branch,
    files,
    summary: `Commit ${files.length === 1 ? files[0] : `${files.length} files`} on ${branch}.`,
  };
  const argv = ["git", "commit", "-m", message, "--", ...files];
  const copy = copyable(argv, repo);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("git", ["commit", "-m", message, "--", ...files], { cwd: repo, timeoutMs: 20_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The commit may or may not have been written. Check git log before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personMessage(combinedOutput(result), "Nothing was committed."), confirmation, copyable: copy };
  }
  const hash = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  const subject = (await run("git", ["log", "-1", "--format=%s"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  return { outcome: "done", confirmation, copyable: copy, commit: { hash, subject } };
}

export async function pushBranch(
  run: ProcessRunner,
  repo: string,
  remote: string,
  branch: string,
  confirm: boolean | undefined,
): Promise<GitActionResult & { pushed?: { remote: string; branch: string } }> {
  await assertRemoteName(run, repo, remote);
  await assertBranchName(run, repo, branch);
  await refuseHiddenRef(run, repo, branch);
  const confirmation: GitActionConfirmation = {
    repo,
    branch,
    remote,
    summary: `Push ${branch} to ${remote}.`,
  };
  const argv = ["git", "push", remote, branch];
  const copy = copyable(argv, repo);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("git", ["push", remote, branch], { cwd: repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The push may or may not have reached the remote. Check the remote before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personMessage(combinedOutput(result), "Nothing was pushed."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, pushed: { remote, branch } };
}

export async function createBranch(
  run: ProcessRunner,
  repo: string,
  name: string,
  base: string,
  checkout: boolean | undefined,
  confirm: boolean | undefined,
): Promise<GitActionResult & { created?: { name: string; base: string; checkedOut: boolean } }> {
  await assertBranchName(run, repo, name);
  await assertCommitish(run, repo, base);
  if (isHiddenProductRef(name) || isHiddenProductRef(base)) {
    throw new GitActionError(`That ref sits under ${hiddenRefPrefix()} and cannot be used.`);
  }
  const confirmation: GitActionConfirmation = {
    repo,
    branch: name,
    summary: checkout
      ? `Create ${name} from ${base} and check it out.`
      : `Create ${name} from ${base}.`,
  };
  const argv = checkout ? ["git", "switch", "-c", name, base] : ["git", "branch", name, base];
  const copy = copyable(argv, repo);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = checkout
    ? await run("git", ["switch", "-c", name, base], { cwd: repo, timeoutMs: 15_000 })
    : await run("git", ["branch", name, base], { cwd: repo, timeoutMs: 15_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The branch may or may not have been created. Check git branch before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personMessage(combinedOutput(result), "The branch was not created."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, created: { name, base, checkedOut: checkout === true } };
}

function personMessage(output: string, fallback: string): string {
  const line = output.split("\n").map((row) => row.trim()).find((row) => row && !row.startsWith("hint:"));
  if (!line) return fallback;
  if (line.length > 240) return fallback;
  return line;
}
