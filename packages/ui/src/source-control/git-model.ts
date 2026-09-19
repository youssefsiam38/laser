/**
 * Pure helpers for overlay git actions. The engine owns git; this file names
 * what the toolbar must show and which call is a preview versus a write.
 */
import type {
  GitActionConfirmation,
  GitActionCopyable,
  GitActionExpect,
  GitActionOutcome,
  GitActionResult,
  GitHostStatus,
  GitPrMergeMethod,
  GitPullRequestCheck,
} from "@lasercode/protocol";

export const GIT_NOTHING_TO_COMMIT = "Nothing to commit in this repository.";
export const GIT_WRITE_MESSAGE = "Write a commit message before reviewing the commit.";
export const GIT_WRITE_PR = "Write a title before reviewing the pull request.";
export const GIT_PROSE_FAILED = "Write the message. The session could not draft one.";
export const GIT_UNCERTAIN_NEXT = "This may already have happened. Check the remote before trying again.";
export const GIT_NEEDS_COPY =
  "This machine cannot run that action. Copy the command and run it where you are signed in.";
export const GIT_COMMIT_FAILED = "Could not commit. Check the files and try again.";
export const GIT_PUSH_FAILED = "Could not push. Check the remote and try again.";
export const GIT_BRANCH_FAILED = "Could not create the branch. Check the name and try again.";
export const GIT_PR_FAILED = "Could not open the pull request. Check the title and try again.";
export const GIT_PR_READ_FAILED = "Could not read that pull request. Check the number and try again.";
export const GIT_PR_CHECKOUT_FAILED = "Could not check out that pull request. Try again.";
export const GIT_PR_MERGE_FAILED = "Could not merge that pull request. Try again.";
export const GIT_HOSTS_FAILED = "Could not read repository hosts. Try again.";
export const GIT_ON_DEFAULT_BRANCH = "You are on the default branch. Create a branch first.";
export const GIT_NO_REMOTE = "This repository has no remote to push to.";
export const GIT_BITBUCKET_REBASE = "Bitbucket cannot rebase-merge. Choose merge or squash.";
export const GIT_PR_NOT_OPEN = "This pull request is not open, so it cannot be merged.";
export const GIT_BRANCH_NAME = "Name the new branch.";

export type GitActionKind = "commit" | "push" | "branch" | "pull-request-create" | "pull-request-read";

export function repoLeafName(repo: string): string {
  const parts = repo.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repo;
}

export function targetRepo(opts: {
  repos: readonly { repo: string }[];
  repoFilter: string | null;
  activeRepo?: string;
}): string | null {
  if (opts.repoFilter) return opts.repoFilter;
  if (opts.activeRepo && opts.repos.some((repo) => repo.repo === opts.activeRepo)) return opts.activeRepo;
  return opts.repos[0]?.repo ?? opts.activeRepo ?? null;
}

export function hostFor(hosts: readonly GitHostStatus[], repo: string | null): GitHostStatus | undefined {
  if (!repo) return undefined;
  return hosts.find((host) => host.repo === repo);
}

export function hostStatusSentence(host: GitHostStatus | undefined): string | undefined {
  if (!host || host.usable) return undefined;
  return host.fix;
}

/** Display-only. Never pass this string to a shell. */
export function formatCopyableArgv(argv: readonly string[]): string {
  return argv.map(quoteArgvPart).join(" ");
}

export function formatCopyable(copyable: GitActionCopyable): string {
  return formatCopyableArgv(copyable.argv);
}

function quoteArgvPart(part: string): string {
  if (part.length === 0) return '""';
  if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) return part;
  return `"${part.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function withConfirm<T extends object>(
  preview: Pick<GitActionResult, "expect">,
  params: T,
): T & { confirm: true; expect?: GitActionExpect } {
  return {
    ...params,
    confirm: true,
    ...(preview.expect ? { expect: preview.expect } : {}),
  };
}

export function isPreviewCall(params: { confirm?: boolean }): boolean {
  return params.confirm !== true;
}

export function offersMutation(outcome: GitActionOutcome | undefined): boolean {
  return outcome === "preview";
}

/** A refused expect can be previewed again. An uncertain result must not. */
export function offersPreviewAgain(outcome: GitActionOutcome | undefined): boolean {
  return outcome === "refused";
}

/** Uncertain and needs_copy never retry. The person chooses the next step. */
export function offersAutomaticRetry(_outcome: GitActionOutcome | undefined): boolean {
  return false;
}

export function mergeMethodsFor(host: GitHostStatus | undefined): GitPrMergeMethod[] {
  if (host?.host === "bitbucket") return ["merge", "squash"];
  return ["merge", "squash", "rebase"];
}

export function mergeMethodAllowed(host: GitHostStatus | undefined, method: GitPrMergeMethod): boolean {
  return mergeMethodsFor(host).includes(method);
}

export function checkSummary(checks: readonly GitPullRequestCheck[]): { failed: number; pending: number; total: number } {
  return {
    failed: checks.filter((check) => check.status === "failure").length,
    pending: checks.filter((check) => check.status === "pending").length,
    total: checks.length,
  };
}

export function confirmationHasNames(confirmation: GitActionConfirmation): boolean {
  return Boolean(confirmation.branch && confirmation.repo && confirmation.summary);
}

export function numstatSummary(files: readonly { path: string; added: number; removed: number }[]): string | undefined {
  if (!files.length) return undefined;
  return files.map((file) => `${file.path}\t+${file.added}\t-${file.removed}`).join("\n");
}

export function selectedFiles<T extends { path: string }>(files: readonly T[], selected: ReadonlySet<string>): T[] {
  return files.filter((file) => selected.has(file.path));
}

export function parsePullRequestNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[1-9]\d{0,8}$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

export function onDefaultBranch(host: GitHostStatus | undefined): boolean {
  if (!host?.branch || !host.defaultBranch) return false;
  return host.branch === host.defaultBranch;
}

export function actionTitle(kind: GitActionKind): string {
  switch (kind) {
    case "commit":
      return "Commit";
    case "push":
      return "Push";
    case "branch":
      return "New branch";
    case "pull-request-create":
      return "Open a pull request";
    case "pull-request-read":
      return "Pull request";
  }
}

export function confirmLabel(kind: GitActionKind, confirmation: GitActionConfirmation | undefined): string {
  const branch = confirmation?.branch;
  const remote = confirmation?.remote;
  switch (kind) {
    case "commit":
      return branch ? `Commit to ${branch}` : "Commit";
    case "push":
      return branch && remote ? `Push ${branch} to ${remote}` : "Push";
    case "branch":
      return branch ? `Create ${branch}` : "Create branch";
    case "pull-request-create":
      return "Open pull request";
    case "pull-request-read":
      return "Check out branch";
  }
}
