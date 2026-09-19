/**
 * Git actions (source-control leap L6): commit, push, branch and pull-request
 * operations for GitHub and Bitbucket, plus per-repository host discovery.
 *
 * Types only. The worker runs the commands; the overlay's toolbar is the only
 * caller this leap. Nothing here names an executable or a credential.
 */

/** Hosts this leap can drive. Anything else is `unsupported` on the status row. */
export const GIT_ACTION_HOSTS = ["github", "bitbucket"] as const;
export type GitActionHost = (typeof GIT_ACTION_HOSTS)[number];

export const GIT_ACTION_OUTCOMES = ["preview", "done", "refused", "uncertain", "needs_copy"] as const;
export type GitActionOutcome = (typeof GIT_ACTION_OUTCOMES)[number];

export const GIT_PROSE_KINDS = ["commit", "pr_title", "pr_description"] as const;
export type GitProseKind = (typeof GIT_PROSE_KINDS)[number];

export const GIT_PR_MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type GitPrMergeMethod = (typeof GIT_PR_MERGE_METHODS)[number];

export const GIT_PR_STATES = ["open", "merged", "closed"] as const;
export type GitPrState = (typeof GIT_PR_STATES)[number];

export const GIT_CHECK_STATUSES = ["pending", "success", "failure", "neutral"] as const;
export type GitCheckStatus = (typeof GIT_CHECK_STATUSES)[number];

/** Why a host row is not usable. Callers switch on this; they do not sniff `fix`. */
export const GIT_HOST_UNUSABLE_REASONS = [
  "missing_cli",
  "signed_out",
  "missing_token",
  "unsupported_host",
  "not_git",
  "no_remote",
] as const;
export type GitHostUnusableReason = (typeof GIT_HOST_UNUSABLE_REASONS)[number];

/**
 * Snapshot a mutating call must still match. The overlay round-trips this from
 * the preview so a blind `confirm: true` cannot write a different tree.
 */
export interface GitActionExpect {
  branch?: string;
  files?: string[];
  /** `git rev-parse HEAD` at preview time. */
  head?: string;
}

/**
 * A command the person can copy when this machine cannot run the action
 * (CLI missing, signed out, or the credential lives on another machine).
 * `argv` is the executable and its arguments, never a shell string.
 */
export interface GitActionCopyable {
  argv: string[];
  cwd: string;
  /** A host page the person can open instead of running a command. */
  url?: string;
}

/** What a confirmation dialog must name before a mutating call runs. */
export interface GitActionConfirmation {
  repo: string;
  branch: string;
  remote?: string;
  files?: string[];
  /** One sentence of the exact effect. */
  summary: string;
}

/** Shared result envelope for every git action. */
export interface GitActionResult {
  outcome: GitActionOutcome;
  /**
   * Why it refused, the uncertain warning, or the one command that fixes a
   * missing/signed-out CLI. Never a credential, never a raw API body.
   */
  message?: string;
  confirmation: GitActionConfirmation;
  copyable?: GitActionCopyable;
  /** Present on a preview so the next call can send it back as `expect`. */
  expect?: GitActionExpect;
}

/** One repository's discovered host, from its remotes and the login on this machine. */
export interface GitHostStatus {
  repo: string;
  host: GitActionHost | "unsupported";
  remote?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  branch?: string;
  /** `gh` for GitHub; Bitbucket uses the Atlassian API token, not a CLI. */
  cli?: string;
  cliPresent?: boolean;
  signedIn?: boolean;
  usable: boolean;
  /** Sentence with the one command (or URL) that fixes it, when `usable` is false. */
  fix?: string;
  /** Present when `usable` is false. Switch on this; do not sniff `fix`. */
  reason?: GitHostUnusableReason;
}

export interface GitPullRequestComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface GitPullRequestCheck {
  name: string;
  status: GitCheckStatus;
  url?: string;
}

export interface GitPullRequestFile {
  path: string;
  viewed?: boolean;
}

export interface GitPullRequest {
  host: GitActionHost;
  number: number;
  title: string;
  body: string;
  url: string;
  state: GitPrState;
  base: string;
  head: string;
  comments: GitPullRequestComment[];
  checks: GitPullRequestCheck[];
  files?: GitPullRequestFile[];
}

export interface GitHostsParams {
  cwd: string;
  /**
   * Optional filter of the workspace's repositories. Omitted: every repository
   * the workspace resolver found. Paths still have to sit inside the project.
   */
  repos?: string[];
}
export interface GitHostsResult {
  hosts: GitHostStatus[];
}

export interface GitCommitParams {
  cwd: string;
  repo?: string;
  paths: string[];
  message: string;
  /** Must be set `true` to write the commit. Omitted is a preview. */
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitCommitResult extends GitActionResult {
  commit?: { hash: string; subject: string };
}

export interface GitPushParams {
  cwd: string;
  repo?: string;
  remote: string;
  branch: string;
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitPushResult extends GitActionResult {
  pushed?: { remote: string; branch: string };
}

export interface GitBranchParams {
  cwd: string;
  repo?: string;
  name: string;
  base: string;
  /** Switch to the new branch after creating it. Still requires `confirm`. */
  checkout?: boolean;
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitBranchResult extends GitActionResult {
  created?: { name: string; base: string; checkedOut: boolean };
}

export interface GitProseParams {
  cwd: string;
  /** The open session whose current model writes the text. */
  path: string;
  repo?: string;
  kind: GitProseKind;
  files: string[];
  /** Optional numstat-style summary the overlay already has. */
  summary?: string;
}
export interface GitProseResult {
  kind: GitProseKind;
  text: string;
  model?: { provider: string; id: string };
  message?: string;
}

export interface GitPrCreateParams {
  cwd: string;
  repo?: string;
  title: string;
  body: string;
  base: string;
  head: string;
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitPrCreateResult extends GitActionResult {
  pullRequest?: Pick<GitPullRequest, "number" | "url" | "title" | "host">;
}

export interface GitPrReadParams {
  cwd: string;
  repo?: string;
  number: number;
}
export interface GitPrReadResult extends GitActionResult {
  pullRequest?: GitPullRequest;
}

export interface GitPrCheckoutParams {
  cwd: string;
  repo?: string;
  number: number;
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitPrCheckoutResult extends GitActionResult {
  checkedOut?: { branch: string };
}

export interface GitPrMergeParams {
  cwd: string;
  repo?: string;
  number: number;
  method: GitPrMergeMethod;
  confirm?: boolean;
  expect?: GitActionExpect;
}
export interface GitPrMergeResult extends GitActionResult {
  merged?: { number: number; method: GitPrMergeMethod };
}

export interface GitPrViewedParams {
  cwd: string;
  repo?: string;
  number: number;
  path: string;
  viewed: boolean;
}
export interface GitPrViewedResult extends GitActionResult {
  path: string;
  viewed: boolean;
}
