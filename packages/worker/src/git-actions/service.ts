/**
 * Git actions facade. One instance per worker (one project). Injected runner
 * and fetch so tests never talk to a network or the person's remotes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  GitBranchParams,
  GitBranchResult,
  GitCommitParams,
  GitCommitResult,
  GitHostsParams,
  GitHostsResult,
  GitPrCheckoutParams,
  GitPrCheckoutResult,
  GitPrCreateParams,
  GitPrCreateResult,
  GitPrMergeParams,
  GitPrMergeResult,
  GitProseParams,
  GitProseResult,
  GitPrReadParams,
  GitPrReadResult,
  GitPrViewedParams,
  GitPrViewedResult,
  GitPushParams,
  GitPushResult,
} from "@lasercode/protocol";
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import {
  bitbucketAuthFrom,
  checkoutBitbucketPr,
  createBitbucketPr,
  mergeBitbucketPr,
  readBitbucketPr,
} from "./bitbucket.js";
import { commitPaths, createBranch, pushBranch } from "./git-ops.js";
import {
  checkoutGithubPr,
  createGithubPr,
  mergeGithubPr,
  readGithubPr,
  setGithubViewed,
} from "./github.js";
import { discoverHosts } from "./hosts.js";
import { GitActionError, assertPathspec, resolveRepoRoot } from "./paths.js";
import { generateProse, type GitProseRuntime } from "./prose.js";
import { parseRemoteUrl, type ParsedRemote } from "./remotes.js";
import { createFetcher, createProcessRunner, type GitActionsFetcher, type ProcessRunner } from "./runner.js";
import { listViewed, setLocalViewed } from "./viewed.js";

export interface GitActionsSessionContext {
  model: { provider: string; id: string } | null;
  excerpt: string;
}

export interface GitActionsServiceOptions {
  projectCwd: string;
  run?: ProcessRunner;
  fetch?: GitActionsFetcher;
  env?: NodeJS.ProcessEnv;
  viewedFile?: string;
  proseRuntime?: () => Promise<GitProseRuntime>;
  sessionContext?: (path: string) => Promise<GitActionsSessionContext>;
}

export class GitActionsService {
  private readonly run: ProcessRunner;
  private readonly fetch: GitActionsFetcher;
  private readonly env: NodeJS.ProcessEnv;
  private readonly viewedFile: string;

  constructor(private readonly options: GitActionsServiceOptions) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? createProcessRunner(this.env);
    this.fetch = options.fetch ?? createFetcher();
    this.viewedFile = options.viewedFile ?? join(options.projectCwd, PROJECT_DIR_NAME, "git-viewed.json");
  }

  async hosts(params: GitHostsParams): Promise<GitHostsResult> {
    return {
      hosts: await discoverHosts({
        projectCwd: this.options.projectCwd,
        run: this.run,
        env: this.env,
        ...(params.repos ? { repos: params.repos } : {}),
      }),
    };
  }

  async commit(params: GitCommitParams): Promise<GitCommitResult> {
    const repo = await resolveRepoRoot(this.options.projectCwd, params.repo);
    return commitPaths(this.run, repo, params.paths, params.message, params.confirm);
  }

  async push(params: GitPushParams): Promise<GitPushResult> {
    const repo = await resolveRepoRoot(this.options.projectCwd, params.repo);
    return pushBranch(this.run, repo, params.remote, params.branch, params.confirm);
  }

  async branch(params: GitBranchParams): Promise<GitBranchResult> {
    const repo = await resolveRepoRoot(this.options.projectCwd, params.repo);
    return createBranch(this.run, repo, params.name, params.base, params.checkout, params.confirm);
  }

  async prose(params: GitProseParams): Promise<GitProseResult> {
    const runtime = this.options.proseRuntime ? await this.options.proseRuntime() : undefined;
    if (!runtime) throw new GitActionError("The session's model is not available. Pick a model, then try again.");
    const session = this.options.sessionContext ? await this.options.sessionContext(params.path) : { model: null, excerpt: "" };
    const repo = await resolveRepoRoot(this.options.projectCwd, params.repo);
    return generateProse({
      run: this.run,
      repo,
      kind: params.kind,
      files: params.files.map(assertPathspec),
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
      model: session.model,
      excerpt: session.excerpt,
      instructions: readProjectInstructions(repo),
      runtime,
    });
  }

  async createPr(params: GitPrCreateParams): Promise<GitPrCreateResult> {
    const { repo, remote, host } = await this.locate(params.repo);
    if (host === "github") {
      return createGithubPr(this.run, repo, remote, params.title, params.body, params.base, params.head, params.confirm);
    }
    return createBitbucketPr(this.fetch, bitbucketAuthFrom(this.env), repo, remote, params.title, params.body, params.base, params.head, params.confirm);
  }

  async readPr(params: GitPrReadParams): Promise<GitPrReadResult> {
    const { repo, remote, host } = await this.locate(params.repo);
    if (host === "github") return readGithubPr(this.run, repo, remote, params.number);
    const result = await readBitbucketPr(this.fetch, bitbucketAuthFrom(this.env), repo, remote, params.number);
    if (result.pullRequest) {
      const viewed = listViewed(this.viewedFile, remote, params.number);
      result.pullRequest.files = [...viewed.entries()].map(([path, mark]) => ({ path, viewed: mark }));
    }
    return result;
  }

  async checkoutPr(params: GitPrCheckoutParams): Promise<GitPrCheckoutResult> {
    const { repo, remote, host } = await this.locate(params.repo);
    if (host === "github") return checkoutGithubPr(this.run, repo, remote, params.number, params.confirm);
    return checkoutBitbucketPr(this.run, this.fetch, bitbucketAuthFrom(this.env), repo, remote, params.number, params.confirm);
  }

  async mergePr(params: GitPrMergeParams): Promise<GitPrMergeResult> {
    const { repo, remote, host } = await this.locate(params.repo);
    if (host === "github") return mergeGithubPr(this.run, repo, remote, params.number, params.method, params.confirm);
    return mergeBitbucketPr(this.fetch, bitbucketAuthFrom(this.env), repo, remote, params.number, params.method, params.confirm);
  }

  async viewed(params: GitPrViewedParams): Promise<GitPrViewedResult> {
    assertPathspec(params.path);
    const { repo, remote, host } = await this.locate(params.repo);
    if (host === "github") return setGithubViewed(this.run, repo, remote, params.number, params.path, params.viewed);
    return setLocalViewed(this.viewedFile, repo, remote, params.number, params.path, params.viewed);
  }

  private async locate(repoParam: string | undefined): Promise<{ repo: string; remote: ParsedRemote; host: "github" | "bitbucket" }> {
    const repo = await resolveRepoRoot(this.options.projectCwd, repoParam);
    const hosts = await discoverHosts({ projectCwd: this.options.projectCwd, run: this.run, env: this.env, repos: [repo] });
    const row = hosts[0];
    if (!row?.usable || (row.host !== "github" && row.host !== "bitbucket")) {
      const copy = row?.fix?.includes("gh auth") || row?.fix?.startsWith("Set BITBUCKET") || row?.fix?.startsWith("Install the GitHub");
      throw new GitActionError(row?.fix ?? "This repository's host cannot be used.", copy ? "needs_copy" : "refused");
    }
    const parsed = parseRemoteUrl(row.remoteUrl ?? "");
    if (!parsed || parsed.host !== row.host) throw new GitActionError("This repository's host cannot be used.");
    return { repo, remote: parsed, host: row.host };
  }
}

function readProjectInstructions(repo: string): string {
  for (const name of ["AGENTS.md", "CONTRIBUTING.md"]) {
    try {
      const text = readFileSync(join(repo, name), "utf8").trim();
      if (text) return text.slice(0, 4000);
    } catch {
      // The file is optional.
    }
  }
  return "";
}
