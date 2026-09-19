/**
 * Bitbucket Cloud through the Atlassian API token already on this machine.
 *
 * Auth is a header, never argv. The token is read from BITBUCKET_API_TOKEN
 * and never copied into a result, an error or a log. App passwords are not used.
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
import { GitActionError, assertRefName, pushRefspec } from "./paths.js";
import type { ParsedRemote } from "./remotes.js";
import { bitbucketRepo } from "./remotes.js";
import {
  looksUncertain,
  personFacingMessage,
  type GitActionsFetcher,
  type HttpResponse,
  type ProcessRunner,
} from "./runner.js";

const API = "https://api.bitbucket.org/2.0";
const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export interface BitbucketAuth {
  token: string;
}

export interface BitbucketActionContext {
  repo: string;
  remote: ParsedRemote;
  remoteName: string;
}

export function bitbucketAuthFrom(env: NodeJS.ProcessEnv): BitbucketAuth | undefined {
  const token = (env.BITBUCKET_API_TOKEN ?? "").trim();
  if (!token) return undefined;
  return { token };
}

export function bitbucketHeaders(auth: BitbucketAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export function missingTokenResult(repo: string): GitActionResult {
  const message = `Set BITBUCKET_API_TOKEN to an Atlassian API token with Bitbucket scopes (${TOKEN_URL}).`;
  return {
    outcome: "needs_copy",
    message,
    confirmation: { repo, branch: "", summary: message },
    copyable: { argv: ["open", TOKEN_URL], cwd: repo, url: TOKEN_URL },
  };
}

export async function createBitbucketPr(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth | undefined,
  ctx: BitbucketActionContext,
  title: string,
  body: string,
  base: string,
  head: string,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { pullRequest?: Pick<GitPullRequest, "number" | "url" | "title" | "host"> }> {
  if (!auth) return missingTokenResult(ctx.repo);
  const { workspace, repo: slug } = bitbucketRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: head,
    remote: ctx.remoteName,
    summary: `Open a pull request from ${head} into ${base} on ${workspace}/${slug}.`,
  };
  const url = `${API}/repositories/${workspace}/${slug}/pullrequests`;
  const copy = copyable(
    ["git", "push", "-u", ctx.remoteName, pushRefspec(head)],
    ctx.repo,
    `https://bitbucket.org/${workspace}/${slug}/pull-requests/new?source=${encodeURIComponent(head)}&dest=${encodeURIComponent(base)}`,
  );
  const mismatch = confirm === true ? verifyExpect(expect, { branch: head }, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: { branch: head } });
  let response: HttpResponse;
  try {
    response = await fetchImpl({
      url,
      method: "POST",
      headers: bitbucketHeaders(auth),
      body: JSON.stringify({
        title,
        description: body,
        source: { branch: { name: head } },
        destination: { branch: { name: base } },
      }),
    });
  } catch {
    return { outcome: "uncertain", message: "The pull request may or may not have been opened. Check Bitbucket before trying again.", confirmation, copyable: copy };
  }
  if (response.status >= 500) {
    return { outcome: "uncertain", message: "The pull request may or may not have been opened. Check Bitbucket before trying again.", confirmation, copyable: copy };
  }
  const mapped = mapCreated(response, workspace, slug);
  if (!mapped) return { outcome: "refused", message: bitbucketMessage(response, "The pull request was not opened."), confirmation, copyable: copy };
  return { outcome: "done", confirmation, copyable: copy, pullRequest: mapped };
}

export async function readBitbucketPr(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth | undefined,
  ctx: BitbucketActionContext,
  number: number,
): Promise<GitActionResult & { pullRequest?: GitPullRequest }> {
  if (!auth) return missingTokenResult(ctx.repo);
  const { workspace, repo: slug } = bitbucketRepo(ctx.remote);
  const confirmation: GitActionConfirmation = { repo: ctx.repo, branch: "", summary: `Read pull request ${number} on ${workspace}/${slug}.` };
  const copy = copyable(["git", "fetch", ctx.remoteName], ctx.repo, `https://bitbucket.org/${workspace}/${slug}/pull-requests/${number}`);
  const base = `${API}/repositories/${workspace}/${slug}/pullrequests/${number}`;
  let pr: HttpResponse;
  try {
    pr = await fetchImpl({ url: `${base}?fields=id,title,description,state,source,destination,links`, method: "GET", headers: bitbucketHeaders(auth) });
  } catch {
    return { outcome: "refused", message: "Bitbucket could not be reached.", confirmation, copyable: copy };
  }
  if (pr.status === 401 || pr.status === 403 || pr.status === 429) {
    return { outcome: "refused", message: bitbucketMessage(pr, "Bitbucket refused this request."), confirmation, copyable: copy };
  }
  if (pr.status !== 200) {
    return { outcome: "refused", message: bitbucketMessage(pr, "That pull request could not be read."), confirmation, copyable: copy };
  }
  const parsed = parseJson(pr.text);
  if (!parsed) return { outcome: "refused", message: "Bitbucket returned a response that could not be read.", confirmation, copyable: copy };
  const comments = await collectComments(fetchImpl, auth, `${base}/comments`);
  const checks = await collectStatuses(fetchImpl, auth, `${base}/statuses`);
  const files = await collectDiffstat(fetchImpl, auth, `${base}/diffstat`);
  const pullRequest = mapPr(parsed, number, comments, checks, files);
  return { outcome: "done", confirmation: { ...confirmation, branch: pullRequest.head, remote: ctx.remoteName }, copyable: copy, pullRequest };
}

export async function checkoutBitbucketPr(
  run: ProcessRunner,
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth | undefined,
  ctx: BitbucketActionContext,
  number: number,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { checkedOut?: { branch: string } }> {
  const read = await readBitbucketPr(fetchImpl, auth, ctx, number);
  if (!read.pullRequest) return { ...read, outcome: read.outcome === "done" ? "refused" : read.outcome };
  const branch = await assertRefName(run, ctx.repo, read.pullRequest.head);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch,
    remote: ctx.remoteName,
    summary: `Check out ${branch} from pull request ${number}.`,
  };
  const spec = pushRefspec(branch);
  const argv = ["git", "switch", "--", branch];
  const copy = copyable(argv, ctx.repo);
  const mismatch = confirm === true ? verifyExpect(expect, { branch }, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy, { expect: { branch } });
  const fetch = await run("git", ["fetch", ctx.remoteName, spec], { cwd: ctx.repo, timeoutMs: 60_000 });
  if (looksUncertain(fetch)) {
    return { outcome: "uncertain", message: "The fetch may or may not have completed. Check git status before trying again.", confirmation, copyable: copy };
  }
  if (fetch.code !== 0) {
    return { outcome: "refused", message: "The pull request branch could not be fetched.", confirmation, copyable: copy };
  }
  const switched = await run("git", ["switch", "--", branch], { cwd: ctx.repo, timeoutMs: 15_000 });
  if (switched.code !== 0) {
    const track = await run("git", ["switch", "-c", branch, "--track", `${ctx.remoteName}/${branch}`], { cwd: ctx.repo, timeoutMs: 15_000 });
    if (track.code !== 0) {
      return { outcome: "refused", message: "The pull request branch could not be checked out.", confirmation, copyable: copy };
    }
  }
  return { outcome: "done", confirmation, copyable: copy, checkedOut: { branch } };
}

export async function mergeBitbucketPr(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth | undefined,
  ctx: BitbucketActionContext,
  number: number,
  method: GitPrMergeMethod,
  confirm: boolean | undefined,
  expect?: GitActionExpect,
): Promise<GitActionResult & { merged?: { number: number; method: GitPrMergeMethod } }> {
  if (!auth) return missingTokenResult(ctx.repo);
  const { workspace, repo: slug } = bitbucketRepo(ctx.remote);
  const confirmation: GitActionConfirmation = {
    repo: ctx.repo,
    branch: "",
    remote: ctx.remoteName,
    summary: `Merge pull request ${number} on ${workspace}/${slug} with ${method}.`,
  };
  const copy = copyable(["git", "fetch", ctx.remoteName], ctx.repo, `https://bitbucket.org/${workspace}/${slug}/pull-requests/${number}`);
  if (method === "rebase") {
    throw new GitActionError("Bitbucket cannot rebase-merge. Choose merge or squash.");
  }
  const mismatch = confirm === true ? verifyExpect(expect, {}, confirmation, copy) : undefined;
  if (mismatch) return mismatch;
  if (confirm !== true) return previewResult(confirmation, copy);
  const strategy = method === "squash" ? "squash" : "merge_commit";
  let response: HttpResponse;
  try {
    response = await fetchImpl({
      url: `${API}/repositories/${workspace}/${slug}/pullrequests/${number}/merge`,
      method: "POST",
      headers: bitbucketHeaders(auth),
      body: JSON.stringify({ type: "pullrequest", merge_strategy: strategy, close_source_branch: false }),
    });
  } catch {
    return { outcome: "uncertain", message: "The merge may or may not have completed. Check Bitbucket before trying again.", confirmation, copyable: copy };
  }
  if (response.status === 202) {
    return {
      outcome: "uncertain",
      message: "Bitbucket accepted the merge and is still running it. Check the pull request before trying again.",
      confirmation,
      copyable: copy,
    };
  }
  if (response.status >= 500) {
    return { outcome: "uncertain", message: "The merge may or may not have completed. Check Bitbucket before trying again.", confirmation, copyable: copy };
  }
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "done", confirmation, copyable: copy, merged: { number, method } };
  }
  return { outcome: "refused", message: bitbucketMessage(response, "The pull request was not merged."), confirmation, copyable: copy };
}

async function collectComments(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth,
  url: string,
): Promise<GitPullRequestComment[]> {
  const comments: GitPullRequestComment[] = [];
  let next: string | undefined = `${url}?pagelen=50&fields=values.id,values.user.display_name,values.content.raw,values.inline.path,values.inline.to,next`;
  let pages = 0;
  while (next && pages < 10) {
    pages += 1;
    const response = await fetchImpl({ url: next, method: "GET", headers: bitbucketHeaders(auth) }).catch(() => undefined);
    if (!response || response.status !== 200) break;
    const parsed = parseJson(response.text);
    for (const item of arrayOf(parsed?.values)) {
      const row = asRecord(item);
      if (!row) continue;
      const user = asRecord(row.user);
      const content = asRecord(row.content);
      const inline = asRecord(row.inline);
      comments.push({
        id: String(row.id ?? comments.length),
        author: typeof user?.display_name === "string" ? user.display_name : "",
        body: typeof content?.raw === "string" ? content.raw : "",
        ...(typeof inline?.path === "string" ? { path: inline.path } : {}),
        ...(typeof inline?.to === "number" ? { line: inline.to } : {}),
      });
    }
    next = typeof parsed?.next === "string" ? parsed.next : undefined;
  }
  return comments;
}

async function collectStatuses(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth,
  url: string,
): Promise<GitPullRequestCheck[]> {
  const checks: GitPullRequestCheck[] = [];
  const response = await fetchImpl({
    url: `${url}?pagelen=50&fields=values.name,values.state,values.url`,
    method: "GET",
    headers: bitbucketHeaders(auth),
  }).catch(() => undefined);
  if (!response || response.status !== 200) return checks;
  const parsed = parseJson(response.text);
  for (const item of arrayOf(parsed?.values)) {
    const row = asRecord(item);
    if (!row) continue;
    const state = typeof row.state === "string" ? row.state.toUpperCase() : "";
    checks.push({
      name: typeof row.name === "string" ? row.name : "check",
      status: state === "SUCCESSFUL" ? "success" : state === "FAILED" ? "failure" : state === "INPROGRESS" ? "pending" : "neutral",
      ...(typeof row.url === "string" ? { url: row.url } : {}),
    });
  }
  return checks;
}

async function collectDiffstat(
  fetchImpl: GitActionsFetcher,
  auth: BitbucketAuth,
  url: string,
): Promise<GitPullRequestFile[]> {
  const files: GitPullRequestFile[] = [];
  const seen = new Set<string>();
  let next: string | undefined = `${url}?pagelen=100&fields=values.new.path,values.old.path,next`;
  let pages = 0;
  while (next && pages < 20) {
    pages += 1;
    const response = await fetchImpl({ url: next, method: "GET", headers: bitbucketHeaders(auth) }).catch(() => undefined);
    if (!response || response.status !== 200) break;
    const parsed = parseJson(response.text);
    for (const item of arrayOf(parsed?.values)) {
      const row = asRecord(item);
      if (!row) continue;
      const newer = asRecord(row.new);
      const older = asRecord(row.old);
      const path = typeof newer?.path === "string" ? newer.path : typeof older?.path === "string" ? older.path : "";
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push({ path });
    }
    next = typeof parsed?.next === "string" ? parsed.next : undefined;
  }
  return files;
}

function mapCreated(
  response: HttpResponse,
  workspace: string,
  slug: string,
): Pick<GitPullRequest, "number" | "url" | "title" | "host"> | undefined {
  if (response.status < 200 || response.status >= 300) return undefined;
  const parsed = parseJson(response.text);
  if (!parsed) return undefined;
  const id = typeof parsed.id === "number" ? parsed.id : 0;
  const links = asRecord(parsed.links);
  const html = asRecord(links?.html);
  const url = typeof html?.href === "string" ? html.href : `https://bitbucket.org/${workspace}/${slug}/pull-requests/${id}`;
  return {
    host: "bitbucket",
    number: id,
    url,
    title: typeof parsed.title === "string" ? parsed.title : "",
  };
}

function mapPr(
  parsed: Record<string, unknown>,
  number: number,
  comments: GitPullRequestComment[],
  checks: GitPullRequestCheck[],
  files: GitPullRequestFile[],
): GitPullRequest {
  const source = asRecord(parsed.source);
  const dest = asRecord(parsed.destination);
  const sourceBranch = asRecord(source?.branch);
  const destBranch = asRecord(dest?.branch);
  const links = asRecord(parsed.links);
  const html = asRecord(links?.html);
  const stateRaw = typeof parsed.state === "string" ? parsed.state.toUpperCase() : "";
  return {
    host: "bitbucket",
    number: typeof parsed.id === "number" ? parsed.id : number,
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.description === "string" ? parsed.description : "",
    url: typeof html?.href === "string" ? html.href : "",
    state: stateRaw === "MERGED" ? "merged" : stateRaw === "DECLINED" || stateRaw === "SUPERSEDED" ? "closed" : "open",
    base: typeof destBranch?.name === "string" ? destBranch.name : "",
    head: typeof sourceBranch?.name === "string" ? sourceBranch.name : "",
    comments,
    checks,
    files,
  };
}

export function bitbucketMessage(response: HttpResponse, fallback: string): string {
  if (response.status === 401) return `Set BITBUCKET_API_TOKEN to an Atlassian API token with Bitbucket scopes (${TOKEN_URL}).`;
  if (response.status === 429) return "Bitbucket is throttling this account. Wait, then try again.";
  if (response.status === 403) return classifyForbidden(response, fallback);
  const parsed = parseJson(response.text);
  const error = asRecord(parsed?.error);
  const message = typeof error?.message === "string" ? error.message : undefined;
  if (message && message.length <= 240) return personFacingMessage(message, fallback);
  return fallback;
}

function classifyForbidden(response: HttpResponse, fallback: string): string {
  const parsed = parseJson(response.text);
  if (!parsed) {
    return "Bitbucket returned a security challenge, not an API response. Open Bitbucket in a browser, then try again.";
  }
  const error = asRecord(parsed.error);
  const detail = error?.detail;
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    const required = (detail as { required?: unknown }).required;
    const granted = (detail as { granted?: unknown }).granted;
    if (Array.isArray(required) || Array.isArray(granted)) {
      return "This Bitbucket token is missing a required scope. Create a replacement token.";
    }
  }
  const data = asRecord(error?.data) ?? asRecord(parsed.data);
  if (data?.key === "INSUFFICIENT_RIGHTS") {
    return "This Bitbucket account does not have permission to write this repository. A repository admin must grant access; a new token will not help.";
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (/do not have access to view this workspace/i.test(message)) {
    return "This Bitbucket account cannot see that workspace. A workspace admin must grant access; a new token will not help.";
  }
  if (message && message.length <= 240) return personFacingMessage(message, fallback);
  return fallback;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
