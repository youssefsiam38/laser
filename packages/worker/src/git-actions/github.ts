/**
 * GitHub actions through `gh`, always as argument arrays.
 *
 * Viewed marks use GitHub's GraphQL `markFileAsViewed` / `unmarkFileAsViewed`
 * so they stay in sync with github.com. Raw API bodies never leave this file.
 */
import type {
  GitActionConfirmation,
  GitActionExpect,
  GitActionResult,
  GitPrMergeMethod,
  GitPullRequest,
  GitPullRequestCheck,
  GitPullRequestComment,
  GitPullRequestFile,
} from "@lasercode/protocol";
import { copyable, previewResult, verifyExpect } from "./git-ops.js";
import { GitActionError } from "./paths.js";
import type { ParsedRemote } from "./remotes.js";
import { githubRepo } from "./remotes.js";
import { combinedOutput, looksUncertain, personFacingMessage, type ProcessRunner } from "./runner.js";
import { setLocalViewed } from "./viewed.js";

const GH_LOGIN = "gh auth login";

export interface GithubActionContext {
  repo: string;
  remote: ParsedRemote;
  remoteName: string;
  /** Locate already proved `gh` is present and signed in. */
  cliReady?: boolean;
  viewedFile?: string;
}

function needsGhCopy(repo: string, message: string): GitActionResult {
  return {
    outcome: "needs_copy",
    message,
    confirmation: { repo, branch: "", summary: message },
    copyable: { argv: ["gh", "auth", "login"], cwd: repo },
  };
}

export async function ensureGh(run: ProcessRunner, repo: string): Promise<GitActionResult | undefined> {
  const version = await run("gh", ["--version"], { cwd: repo, timeoutMs: 5_000 });
  if (!version.spawned) return needsGhCopy(repo, `Install the GitHub CLI, then run ${GH_LOGIN}.`);
  const status = await run("gh", ["auth", "status"], { cwd: repo, timeoutMs: 8_000 });
  if (status.code !== 0) return needsGhCopy(repo, `Run ${GH_LOGIN}.`);
  return undefined;
}

async function ready(run: ProcessRunner, ctx: GithubActionContext): Promise<GitActionResult | undefined> {
  if (ctx.cliReady) return undefined;
  return ensureGh(run, ctx.repo);
}

export async function createGithubPr(
  run: ProcessRunner,
  ctx: GithubActionContext,
  title: string,
  body: string,
  base: string,
  head: string,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { pullRequest?: Pick<GitPullRequest, "number" | "url" | "title" | "host"> }> {
  const missing = await ready(run, ctx);
  if (missing) return missing;
  const ownerRepo = githubRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: head,
    remote: ctx.remoteName,
    summary: `Open a pull request from ${head} into ${base} on ${ownerRepo}.`,
  };
  const argv = ["gh", "pr", "create", "--repo", ownerRepo, "--title", title, "--body", body, "--base", base, "--head", head];
  const copy = copyable(argv, ctx.repo, `https://github.com/${ownerRepo}/compare/${base}...${head}?expand=1`);
  const mismatch = confirm === true ? verifyExpect(expect, { branch: head }, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: { branch: head } });
  const result = await run("gh", ["pr", "create", "--repo", ownerRepo, "--title", title, "--body", body, "--base", base, "--head", head], {
    cwd: ctx.repo,
    timeoutMs: 60_000,
  });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The pull request may or may not have been opened. Check the host before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "The pull request was not opened."), confirmation, copyable: copy };
  }
  const url = result.stdout.trim().split("\n").find((line) => line.startsWith("https://")) ?? "";
  const number = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? "", 10);
  return {
    outcome: "done",
    confirmation,
    copyable: copy,
    pullRequest: { host: "github", number: Number.isFinite(number) ? number : 0, url, title },
  };
}

export async function readGithubPr(
  run: ProcessRunner,
  ctx: GithubActionContext,
  number: number,
): Promise<GitActionResult & { pullRequest?: GitPullRequest }> {
  const missing = await ready(run, ctx);
  if (missing) return missing;
  const ownerRepo = githubRepo(ctx.remote);
  const confirmation: GitActionConfirmation = { repo: ctx.repo, branch: "", summary: `Read pull request ${number} on ${ownerRepo}.` };
  const copy = copyable(["gh", "pr", "view", String(number), "--repo", ownerRepo], ctx.repo, `https://github.com/${ownerRepo}/pull/${number}`);
  const fields = "id,number,title,body,url,state,baseRefName,headRefName,comments,reviews,statusCheckRollup,files";
  const result = await run("gh", ["pr", "view", String(number), "--repo", ownerRepo, "--json", fields], { cwd: ctx.repo, timeoutMs: 30_000 });
  if (!result.spawned) return needsGhCopy(ctx.repo, `Install the GitHub CLI, then run ${GH_LOGIN}.`);
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "That pull request could not be read."), confirmation, copyable: copy };
  }
  const parsed = parseGhJson(result.stdout);
  if (!parsed) {
    return { outcome: "refused", message: "GitHub returned a response that could not be read.", confirmation, copyable: copy };
  }
  const pullRequest = mapGhPr(parsed, number);
  const viewed = await viewedFiles(run, ctx.repo, typeof parsed.id === "string" ? parsed.id : undefined);
  if (viewed && pullRequest.files) {
    pullRequest.files = pullRequest.files.map((file: GitPullRequestFile) => {
      const mark = viewed.marks.get(file.path) ?? file.viewed;
      return mark === undefined ? { path: file.path } : { path: file.path, viewed: mark };
    });
  }
  const truncated = viewed?.truncated
    ? " Only the first page of files includes GitHub viewed marks."
    : "";
  return {
    outcome: "done",
    confirmation: { ...confirmation, branch: pullRequest.head },
    copyable: copy,
    pullRequest,
    ...(truncated ? { message: `Pull request ${number}.${truncated}` } : {}),
  };
}

export async function checkoutGithubPr(
  run: ProcessRunner,
  ctx: GithubActionContext,
  number: number,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { checkedOut?: { branch: string } }> {
  const missing = await ready(run, ctx);
  if (missing) return missing;
  const ownerRepo = githubRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: `pr/${number}`,
    remote: ctx.remoteName,
    summary: `Check out pull request ${number} from ${ownerRepo}.`,
  };
  const argv = ["gh", "pr", "checkout", String(number), "--repo", ownerRepo];
  const copy = copyable(argv, ctx.repo);
  const mismatch = confirm === true ? verifyExpect(expect, { branch: confirmation.branch }, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("gh", ["pr", "checkout", String(number), "--repo", ownerRepo], { cwd: ctx.repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The checkout may or may not have switched branches. Check git status before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "The pull request was not checked out."), confirmation, copyable: copy };
  }
  const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ctx.repo, timeoutMs: 5_000 })).stdout.trim();
  return { outcome: "done", confirmation: { ...confirmation, branch }, copyable: copy, checkedOut: { branch } };
}

export async function mergeGithubPr(
  run: ProcessRunner,
  ctx: GithubActionContext,
  number: number,
  method: GitPrMergeMethod,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { merged?: { number: number; method: GitPrMergeMethod } }> {
  const missing = await ready(run, ctx);
  if (missing) return missing;
  const ownerRepo = githubRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: "",
    remote: ctx.remoteName,
    summary: `Merge pull request ${number} on ${ownerRepo} with ${method}.`,
  };
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  const argv = ["gh", "pr", "merge", String(number), "--repo", ownerRepo, flag];
  const copy = copyable(argv, ctx.repo, `https://github.com/${ownerRepo}/pull/${number}`);
  const mismatch = confirm === true ? verifyExpect(expect, {}, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("gh", ["pr", "merge", String(number), "--repo", ownerRepo, flag], { cwd: ctx.repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The merge may or may not have completed. Check the pull request before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personFacingMessage(combinedOutput(result), "The pull request was not merged."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, merged: { number, method } };
}

export async function setGithubViewed(
  run: ProcessRunner,
  ctx: GithubActionContext,
  number: number,
  path: string,
  viewed: boolean,
): Promise<GitActionResult & { path: string; viewed: boolean }> {
  const missing = await ready(run, ctx);
  if (missing) return { ...missing, path, viewed };
  const ownerRepo = githubRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: "",
    files: [path],
    summary: viewed ? `Mark ${path} viewed on pull request ${number}.` : `Mark ${path} unviewed on pull request ${number}.`,
  };
  const copy = copyable(["gh", "pr", "view", String(number), "--repo", ownerRepo], ctx.repo);
  const idResult = await run("gh", ["pr", "view", String(number), "--repo", ownerRepo, "--json", "id"], { cwd: ctx.repo, timeoutMs: 20_000 });
  const id = parseGhJson(idResult.stdout)?.id;
  if (typeof id !== "string" || !id) {
    return localViewedFallback(ctx, number, path, viewed, confirmation, copy, "That pull request could not be read.");
  }
  const mutation = viewed
    ? "mutation($id:ID!,$path:String!){markFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}"
    : "mutation($id:ID!,$path:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}";
  const result = await run("gh", ["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${id}`, "-f", `path=${path}`], {
    cwd: ctx.repo,
    timeoutMs: 20_000,
  });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The viewed mark may or may not have been saved. Check the pull request before trying again.", confirmation, copyable: copy, path, viewed };
  }
  if (result.code !== 0) {
    return localViewedFallback(
      ctx,
      number,
      path,
      viewed,
      confirmation,
      copy,
      personFacingMessage(combinedOutput(result), "The viewed mark was not saved."),
    );
  }
  return { outcome: "done", confirmation, copyable: copy, path, viewed };
}

function localViewedFallback(
  ctx: GithubActionContext,
  number: number,
  path: string,
  viewed: boolean,
  confirmation: GitActionConfirmation,
  copy: GitActionResult["copyable"],
  failed: string,
): GitActionResult & { path: string; viewed: boolean } {
  if (!ctx.viewedFile) {
    return { outcome: "refused", message: failed, confirmation, ...(copy ? { copyable: copy } : {}), path, viewed };
  }
  try {
    const local = setLocalViewed(
      ctx.viewedFile,
      ctx.repo,
      ctx.remote,
      number,
      path,
      viewed,
      "The mark is local-only until it syncs with GitHub.",
    );
    return copy ? { ...local, copyable: copy } : local;
  } catch (error) {
    const message = error instanceof GitActionError ? error.message : failed;
    return { outcome: "refused", message, confirmation, ...(copy ? { copyable: copy } : {}), path, viewed };
  }
}

async function viewedFiles(
  run: ProcessRunner,
  repo: string,
  id: string | undefined,
): Promise<{ marks: Map<string, boolean>; truncated: boolean } | undefined> {
  if (!id) return undefined;
  const map = new Map<string, boolean>();
  let after: string | undefined;
  let pages = 0;
  const pageLimit = 20;
  while (pages < pageLimit) {
    pages += 1;
    const query =
      "query($id:ID!,$after:String){node(id:$id){...on PullRequest{files(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{path viewerViewedState}}}}}";
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`];
    if (after) args.push("-f", `after=${after}`);
    const result = await run("gh", args, { cwd: repo, timeoutMs: 20_000 });
    if (result.code !== 0) return pages === 1 ? undefined : { marks: map, truncated: true };
    const parsed = parseGhJson(result.stdout);
    const files = asRecord(asRecord(asRecord(parsed?.data)?.node)?.files);
    const nodes = files?.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        const row = asRecord(node);
        if (typeof row?.path === "string") map.set(row.path, row.viewerViewedState === "VIEWED");
      }
    }
    const pageInfo = asRecord(files?.pageInfo);
    if (pageInfo?.hasNextPage !== true) return { marks: map, truncated: false };
    after = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : undefined;
    if (!after) return { marks: map, truncated: true };
  }
  return { marks: map, truncated: true };
}

interface GhJson {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
  state?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  comments?: unknown;
  reviews?: unknown;
  statusCheckRollup?: unknown;
  files?: unknown;
  data?: unknown;
}

function parseGhJson(text: string): GhJson | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return asRecord(value) as GhJson | undefined;
  } catch {
    return undefined;
  }
}

function mapGhPr(parsed: GhJson, fallbackNumber: number): GitPullRequest {
  const comments: GitPullRequestComment[] = [];
  for (const item of arrayOf(parsed.comments)) {
    const row = asRecord(item);
    if (!row) continue;
    comments.push({
      id: String(row.id ?? comments.length),
      author: loginOf(row.author),
      body: typeof row.body === "string" ? row.body : "",
    });
  }
  for (const item of arrayOf(parsed.reviews)) {
    const row = asRecord(item);
    if (!row || typeof row.body !== "string" || row.body.length === 0) continue;
    comments.push({
      id: String(row.id ?? `review-${comments.length}`),
      author: loginOf(row.author),
      body: row.body,
    });
  }
  const checks: GitPullRequestCheck[] = [];
  for (const item of arrayOf(parsed.statusCheckRollup)) {
    const row = asRecord(item);
    if (!row) continue;
    checks.push({
      name: typeof row.name === "string" ? row.name : "check",
      status: checkStatus(row),
      ...(typeof row.detailsUrl === "string" ? { url: row.detailsUrl } : {}),
    });
  }
  const files: GitPullRequestFile[] = [];
  for (const item of arrayOf(parsed.files)) {
    const row = asRecord(item);
    if (typeof row?.path === "string") files.push({ path: row.path });
  }
  const stateRaw = typeof parsed.state === "string" ? parsed.state.toUpperCase() : "";
  return {
    host: "github",
    number: typeof parsed.number === "number" ? parsed.number : fallbackNumber,
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    url: typeof parsed.url === "string" ? parsed.url : "",
    state: stateRaw === "MERGED" ? "merged" : stateRaw === "CLOSED" ? "closed" : "open",
    base: typeof parsed.baseRefName === "string" ? parsed.baseRefName : "",
    head: typeof parsed.headRefName === "string" ? parsed.headRefName : "",
    comments,
    checks,
    files,
  };
}

function checkStatus(row: Record<string, unknown>): GitPullRequestCheck["status"] {
  const conclusion = typeof row.conclusion === "string" ? row.conclusion.toUpperCase() : "";
  const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") return conclusion === "SUCCESS" ? "success" : "neutral";
  if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED" || conclusion === "ERROR") return "failure";
  if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING") return "pending";
  return "neutral";
}

function loginOf(author: unknown): string {
  const row = asRecord(author);
  return typeof row?.login === "string" ? row.login : "";
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
