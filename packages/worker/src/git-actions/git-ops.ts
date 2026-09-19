/**
 * Local git mutations: commit an explicit path set, push without force, create
 * a branch from an explicit base. Every user value is an argv element.
 */
import type { GitActionConfirmation, GitActionCopyable, GitActionExpect, GitActionResult } from "@lasercode/protocol";
import {
  GitActionError,
  assertCommitish,
  assertLocalBranch,
  assertPathspec,
  assertRefName,
  assertRemoteName,
  literalPathspec,
  pushRefspec,
} from "./paths.js";
import { hiddenRefPrefix, isHiddenProductRef } from "./remotes.js";
import { combinedOutput, looksUncertain, personFacingMessage, type ProcessRunner } from "./runner.js";

export async function readHead(run: ProcessRunner, repo: string): Promise<string> {
  return (await run("git", ["rev-parse", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
}

export async function currentBranch(run: ProcessRunner, repo: string): Promise<{ branch: string; detached: boolean }> {
  const named = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  if (named) return { branch: named, detached: false };
  return { branch: "HEAD", detached: true };
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

export function mismatchResult(confirmation: GitActionConfirmation, copy: GitActionCopyable | undefined, detail: string): GitActionResult {
  return {
    outcome: "refused",
    message: detail,
    confirmation,
    ...(copy ? { copyable: copy } : {}),
  };
}

export function verifyExpect(
  expect: GitActionExpect | undefined,
  actual: { branch?: string; files?: readonly string[]; head?: string },
  confirmation: GitActionConfirmation,
  copy?: GitActionCopyable,
): GitActionResult | undefined {
  if (!expect) return undefined;
  if (expect.branch !== undefined && expect.branch !== actual.branch) {
    return mismatchResult(confirmation, copy, "The branch has changed since this was previewed. Preview it again.");
  }
  if (expect.files) {
    const wanted = [...expect.files].sort();
    const got = [...(actual.files ?? [])].sort();
    if (wanted.length !== got.length || wanted.some((path, index) => path !== got[index])) {
      return mismatchResult(confirmation, copy, "The file list has changed since this was previewed. Preview it again.");
    }
  }
  if (expect.head !== undefined && expect.head !== actual.head) {
    return mismatchResult(confirmation, copy, "HEAD has moved since this was previewed. Preview it again.");
  }
  return undefined;
}

export async function commitPaths(
  run: ProcessRunner,
  repo: string,
  paths: readonly string[],
  message: string,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { commit?: { hash: string; subject: string } }> {
  const files = paths.map(assertPathspec);
  const gitPaths = files.map(literalPathspec);
  const { branch } = await currentBranch(run, repo);
  const head = await readHead(run, repo).catch(() => "");
  const confirmation: GitActionConfirmation = {
    repo,
    branch,
    files,
    summary: `Stage and commit ${files.length === 1 ? files[0] : `${files.length} files`} on ${branch}.`,
  };
  const argv = ["git", "commit", "-m", message, "--", ...gitPaths];
  const copy = copyable(argv, repo);
  const snapshot: GitActionExpect = { branch, files, ...(head ? { head } : {}) };
  const mismatch = confirm === true ? verifyExpect(expect, snapshot, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: snapshot });
  const added = await run("git", ["add", "--", ...gitPaths], { cwd: repo, timeoutMs: 20_000 });
  if (looksUncertain(added)) {
    return { outcome: "uncertain", message: "The files may or may not have been staged. Check git status before trying again.", confirmation, copyable: copy };
  }
  if (added.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(added), "Nothing was staged."), confirmation, copyable: copy };
  }
  const result = await run("git", ["commit", "-m", message, "--", ...gitPaths], { cwd: repo, timeoutMs: 20_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The commit may or may not have been written. Check git log before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "Nothing was committed."), confirmation, copyable: copy };
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
  expect?: GitActionExpect,
): Promise<GitActionResult & { pushed?: { remote: string; branch: string } }> {
  await assertRemoteName(run, repo, remote);
  const local = await assertLocalBranch(run, repo, branch);
  await refuseHiddenRef(run, repo, local);
  const { detached } = await currentBranch(run, repo);
  if (detached && local === "HEAD") {
    throw new GitActionError("Check out a branch first. Detached HEAD cannot be pushed as a branch.");
  }
  const head = await readHead(run, repo).catch(() => "");
  const confirmation: GitActionConfirmation = {
    repo,
    branch: local,
    remote,
    summary: `Push ${local} to ${remote}.`,
  };
  const spec = pushRefspec(local);
  const argv = ["git", "push", remote, spec];
  const copy = copyable(argv, repo);
  const snapshot: GitActionExpect = { branch: local, ...(head ? { head } : {}) };
  const mismatch = confirm === true ? verifyExpect(expect, snapshot, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: snapshot });
  const result = await run("git", ["push", remote, spec], { cwd: repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The push may or may not have reached the remote. Check the remote before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "Nothing was pushed."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, pushed: { remote, branch: local } };
}

export async function createBranch(
  run: ProcessRunner,
  repo: string,
  name: string,
  base: string,
  checkout: boolean | undefined,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { created?: { name: string; base: string; checkedOut: boolean } }> {
  await assertRefName(run, repo, name);
  await assertCommitish(run, repo, base);
  if (isHiddenProductRef(name) || isHiddenProductRef(base)) {
    throw new GitActionError(`That ref sits under ${hiddenRefPrefix()} and cannot be used.`);
  }
  const { branch: current } = await currentBranch(run, repo);
  const head = await readHead(run, repo).catch(() => "");
  const confirmation: GitActionConfirmation = {
    repo,
    branch: name,
    summary: checkout
      ? `Create ${name} from ${base} and check it out.`
      : `Create ${name} from ${base}.`,
  };
  const argv = checkout ? ["git", "switch", "-c", name, "--", base] : ["git", "branch", "--", name, base];
  const copy = copyable(argv, repo);
  const snapshot: GitActionExpect = { branch: current, ...(head ? { head } : {}) };
  const mismatch = confirm === true ? verifyExpect(expect, snapshot, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: snapshot });
  const result = checkout
    ? await run("git", ["switch", "-c", name, "--", base], { cwd: repo, timeoutMs: 15_000 })
    : await run("git", ["branch", "--", name, base], { cwd: repo, timeoutMs: 15_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The branch may or may not have been created. Check git branch before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "The branch was not created."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, created: { name, base, checkedOut: checkout === true } };
}
