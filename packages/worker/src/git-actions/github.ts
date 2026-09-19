/**
 * GitHub actions through `gh`, always as argument arrays.
 *
 * Viewed marks use GitHub's GraphQL `markFileAsViewed` / `unmarkFileAsViewed`
 * so they stay in sync with github.com. Raw API bodies never leave this file.
 */
import type {
  GitActionConfirmation,
  GitActionResult,
  GitPrMergeMethod,
  GitPullRequest,
  GitPullRequestCheck,
  GitPullRequestComment,
  GitPullRequestFile,
} from "@lasercode/protocol";
import { copyable, previewResult } from "./git-ops.js";
import { GitActionError } from "./paths.js";
import type { ParsedRemote } from "./remotes.js";
import { githubRepo } from "./remotes.js";
import { combinedOutput, looksUncertain, redactSecrets, type ProcessRunner } from "./runner.js";

const GH_LOGIN = "gh auth login";

export async function ensureGh(run: ProcessRunner, repo: string): Promise<void> {
  const version = await run("gh", ["--version"], { cwd: repo, timeoutMs: 5_000 });
  if (!version.spawned) throw new GitActionError(`Install the GitHub CLI, then run ${GH_LOGIN}.`, "needs_copy");
  const status = await run("gh", ["auth", "status"], { cwd: repo, timeoutMs: 8_000 });
  if (status.code !== 0) throw new GitActionError(`Run ${GH_LOGIN}.`, "needs_copy");
}

export async function createGithubPr(
  run: ProcessRunner,
  repo: string,
  remote: ParsedRemote,
  title: string,
  body: string,
  base: string,
  head: string,
  confirm: boolean | undefined,
): Promise<GitActionResult & { pullRequest?: Pick<GitPullRequest, "number" | "url" | "title" | "host"> }> {
  await ensureGh(run, repo);
  const ownerRepo = githubRepo(remote);
  const confirmation: GitActionConfirmation = {
    repo,
    branch: head,
    remote: "origin",
    summary: `Open a pull request from ${head} into ${base} on ${ownerRepo}.`,
  };
  const argv = ["gh", "pr", "create", "--repo", ownerRepo, "--title", title, "--body", body, "--base", base, "--head", head];
  const copy = copyable(argv, repo, `https://github.com/${ownerRepo}/compare/${base}...${head}?expand=1`);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("gh", ["pr", "create", "--repo", ownerRepo, "--title", title, "--body", body, "--base", base, "--head", head], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The pull request may or may not have been opened. Check the host before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personGh(combinedOutput(result), "The pull request was not opened."), confirmation, copyable: copy };
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

export async function readGithubPr(run: ProcessRunner, repo: string, remote: ParsedRemote, number: number): Promise<GitActionResult & { pullRequest?: GitPullRequest }> {
  await ensureGh(run, repo);
  const ownerRepo = githubRepo(remote);
  const confirmation: GitActionConfirmation = { repo, branch: "", summary: `Read pull request ${number} on ${ownerRepo}.` };
  const copy = copyable(["gh", "pr", "view", String(number), "--repo", ownerRepo], repo, `https://github.com/${ownerRepo}/pull/${number}`);
  const fields = "id,number,title,body,url,state,baseRefName,headRefName,comments,reviews,statusCheckRollup,files";
  const result = await run("gh", ["pr", "view", String(number), "--repo", ownerRepo, "--json", fields], { cwd: repo, timeoutMs: 30_000 });
  if (!result.spawned) throw new GitActionError(`Install the GitHub CLI, then run ${GH_LOGIN}.`, "needs_copy");
  if (result.code !== 0) {
    return { outcome: "refused", message: personGh(combinedOutput(result), "That pull request could not be read."), confirmation, copyable: copy };
  }
  const parsed = parseGhJson(result.stdout);
  if (!parsed) {
    return { outcome: "refused", message: "GitHub returned a response that could not be read.", confirmation, copyable: copy };
  }
  const pullRequest = mapGhPr(parsed, number);
  const viewed = await viewedFiles(run, repo, typeof parsed.id === "string" ? parsed.id : undefined);
  if (viewed && pullRequest.files) {
    pullRequest.files = pullRequest.files.map((file: GitPullRequestFile) => {
      const mark = viewed.get(file.path) ?? file.viewed;
      return mark === undefined ? { path: file.path } : { path: file.path, viewed: mark };
    });
  }
  return { outcome: "done", confirmation: { ...confirmation, branch: pullRequest.head }, copyable: copy, pullRequest };
}

export async function checkoutGithubPr(
  run: ProcessRunner,
  repo: string,
  remote: ParsedRemote,
  number: number,
  confirm: boolean | undefined,
): Promise<GitActionResult & { checkedOut?: { branch: string } }> {
  await ensureGh(run, repo);
  const ownerRepo = githubRepo(remote);
  const confirmation: GitActionConfirmation = {
    repo,
    branch: `pr/${number}`,
    summary: `Check out pull request ${number} from ${ownerRepo}.`,
  };
  const argv = ["gh", "pr", "checkout", String(number), "--repo", ownerRepo];
  const copy = copyable(argv, repo);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("gh", ["pr", "checkout", String(number), "--repo", ownerRepo], { cwd: repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The checkout may or may not have switched branches. Check git status before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personGh(combinedOutput(result), "The pull request was not checked out."), confirmation, copyable: copy };
  }
  const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  return { outcome: "done", confirmation: { ...confirmation, branch }, copyable: copy, checkedOut: { branch } };
}

export async function mergeGithubPr(
  run: ProcessRunner,
  repo: string,
  remote: ParsedRemote,
  number: number,
  method: GitPrMergeMethod,
  confirm: boolean | undefined,
): Promise<GitActionResult & { merged?: { number: number; method: GitPrMergeMethod } }> {
  await ensureGh(run, repo);
  const ownerRepo = githubRepo(remote);
  const confirmation: GitActionConfirmation = {
    repo,
    branch: "",
    summary: `Merge pull request ${number} on ${ownerRepo} with ${method}.`,
  };
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  const argv = ["gh", "pr", "merge", String(number), "--repo", ownerRepo, flag];
  const copy = copyable(argv, repo, `https://github.com/${ownerRepo}/pull/${number}`);
  if (confirm !== true) return previewResult(confirmation, copy);
  const result = await run("gh", ["pr", "merge", String(number), "--repo", ownerRepo, flag], { cwd: repo, timeoutMs: 60_000 });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The merge may or may not have completed. Check the pull request before trying again.", confirmation, copyable: copy };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personGh(combinedOutput(result), "The pull request was not merged."), confirmation, copyable: copy };
  }
  return { outcome: "done", confirmation, copyable: copy, merged: { number, method } };
}

export async function setGithubViewed(
  run: ProcessRunner,
  repo: string,
  remote: ParsedRemote,
  number: number,
  path: string,
  viewed: boolean,
): Promise<GitActionResult & { path: string; viewed: boolean }> {
  await ensureGh(run, repo);
  const ownerRepo = githubRepo(remote);
  const confirmation: GitActionConfirmation = {
    repo,
    branch: "",
    files: [path],
    summary: viewed ? `Mark ${path} viewed on pull request ${number}.` : `Mark ${path} unviewed on pull request ${number}.`,
  };
  const copy = copyable(["gh", "pr", "view", String(number), "--repo", ownerRepo], repo);
  const idResult = await run("gh", ["pr", "view", String(number), "--repo", ownerRepo, "--json", "id"], { cwd: repo, timeoutMs: 20_000 });
  const id = parseGhJson(idResult.stdout)?.id;
  if (typeof id !== "string" || !id) {
    return { outcome: "refused", message: "That pull request could not be read.", confirmation, copyable: copy, path, viewed };
  }
  const mutation = viewed
    ? "mutation($id:ID!,$path:String!){markFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}"
    : "mutation($id:ID!,$path:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}";
  const result = await run("gh", ["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${id}`, "-f", `path=${path}`], {
    cwd: repo,
    timeoutMs: 20_000,
  });
  if (looksUncertain(result)) {
    return { outcome: "uncertain", message: "The viewed mark may or may not have been saved. Check the pull request before trying again.", confirmation, copyable: copy, path, viewed };
  }
  if (result.code !== 0) {
    return { outcome: "refused", message: personGh(combinedOutput(result), "The viewed mark was not saved."), confirmation, copyable: copy, path, viewed };
  }
  return { outcome: "done", confirmation, copyable: copy, path, viewed };
}

async function viewedFiles(run: ProcessRunner, repo: string, id: string | undefined): Promise<Map<string, boolean> | undefined> {
  if (!id) return undefined;
  const query = "query($id:ID!){node(id:$id){...on PullRequest{files(first:100){nodes{path viewerViewedState}}}}}";
  const result = await run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`], { cwd: repo, timeoutMs: 20_000 });
  if (result.code !== 0) return undefined;
  const parsed = parseGhJson(result.stdout);
  const files = asRecord(asRecord(asRecord(parsed?.data)?.node)?.files);
  const nodes = files?.nodes;
  const map = new Map<string, boolean>();
  if (!Array.isArray(nodes)) return map;
  for (const node of nodes) {
    const row = asRecord(node);
    if (typeof row?.path === "string") map.set(row.path, row.viewerViewedState === "VIEWED");
  }
  return map;
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

function personGh(output: string, fallback: string): string {
  const line = redactSecrets(output).split("\n").map((row) => row.trim()).find((row) => row);
  if (!line || line.length > 240) return fallback;
  return line;
}
