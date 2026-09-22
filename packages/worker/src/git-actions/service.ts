/**
 * Git actions facade. One instance per worker (one project). Injected runner
 * and fetch so tests never talk to a network or the person's remotes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRun,
  GitActionResult,
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
  WorkspaceShape,
} from "@lasercode/protocol";
import { createWorkspaceResolver } from "../workspace.js";
import {
  bitbucketAuthFrom,
  checkoutBitbucketPr,
  createBitbucketPr,
  mergeBitbucketPr,
  missingTokenResult,
  readBitbucketPr,
  type BitbucketActionContext,
} from "./bitbucket.js";
import { commitPaths, createBranch, linkRefFor, pushBranch } from "./git-ops.js";
import {
  checkoutGithubPr,
  createGithubPr,
  mergeGithubPr,
  readGithubPr,
  setGithubViewed,
  type GithubActionContext,
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
  /** Fresh overlay each call (project environment). Overrides `env` when set. */
  envProvider?: () => NodeJS.ProcessEnv;
  viewedFile?: string;
  proseRuntime?: () => Promise<GitProseRuntime>;
  sessionContext?: (path: string) => Promise<GitActionsSessionContext>;
  workspace?: () => Promise<WorkspaceShape>;
  /** Overlay agent scope: resolve this run's worktree instead of the project root. */
  agentRun?: (runId: string) => Pick<AgentRun, "runId" | "worktree"> | undefined;
}

type Located =
  | { ok: true; repo: string; remote: ParsedRemote; remoteName: string; host: "github" | "bitbucket"; cliReady: boolean }
  | { ok: false; result: GitActionResult };

export class GitActionsService {
  private readonly run: ProcessRunner;
  private readonly fetch: GitActionsFetcher;
  private readonly viewedFile: string | undefined;
  private readonly envProvider: () => NodeJS.ProcessEnv;
  private readonly workspace: () => Promise<WorkspaceShape>;

  constructor(private readonly options: GitActionsServiceOptions) {
    this.envProvider = options.envProvider ?? (() => options.env ?? process.env);
    this.run = options.run ?? createProcessRunner(() => this.envProvider());
    this.fetch = options.fetch ?? createFetcher();
    this.viewedFile = options.viewedFile;
    this.workspace = options.workspace ?? (() => createWorkspaceResolver().resolve(options.projectCwd));
  }

  private env(): NodeJS.ProcessEnv {
    return this.envProvider();
  }

  async hosts(params: GitHostsParams): Promise<GitHostsResult> {
    const shape = await this.workspace().catch(() => undefined);
    const repos = [...(params.repos ?? [])];
    if (params.runId) {
      const worktree = await this.actionRepo({ runId: params.runId });
      if (!repos.includes(worktree)) repos.unshift(worktree);
    }
    return {
      hosts: await discoverHosts({
        projectCwd: this.options.projectCwd,
        run: this.run,
        env: this.env(),
        fetch: this.fetch,
        ...(shape ? { workspace: shape } : {}),
        ...(repos.length ? { repos } : {}),
      }),
    };
  }

  async commit(params: GitCommitParams): Promise<GitCommitResult> {
    const repo = await this.actionRepo(params);
    return commitPaths(this.run, repo, params.paths, params.message, params.confirm, params.expect);
  }

  async push(params: GitPushParams): Promise<GitPushResult> {
    const repo = await this.actionRepo(params);
    return pushBranch(this.run, repo, params.remote, params.branch, params.confirm, params.expect);
  }

  async branch(params: GitBranchParams): Promise<GitBranchResult> {
    const repo = await this.actionRepo(params);
    return createBranch(this.run, repo, params.name, params.base, params.checkout, params.confirm, params.expect);
  }

  async prose(params: GitProseParams): Promise<GitProseResult> {
    const runtime = this.options.proseRuntime ? await this.options.proseRuntime() : undefined;
    if (!runtime) throw new GitActionError("The session's model is not available. Pick a model, then try again.");
    const session = this.options.sessionContext ? await this.options.sessionContext(params.path) : { model: null, excerpt: "" };
    const repo = await this.actionRepo(params);
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
    const located = await this.locate(params.repo, params.runId);
    if (!located.ok) return located.result;
    const result =
      located.host === "github"
        ? await createGithubPr(this.run, this.githubCtx(located), params.title, params.body, params.base, params.head, params.confirm, params.expect)
        : await createBitbucketPr(
            this.fetch,
            bitbucketAuthFrom(this.env()),
            this.bitbucketCtx(located),
            params.title,
            params.body,
            params.base,
            params.head,
            params.confirm,
            params.expect,
          );
    return this.withLinkRef(result, located, params.head);
  }

  /**
   * An opened pull request, as something a delivery link can name (M21-T18).
   *
   * The **head commit** is read back from the local repository and is the
   * identity; the request's number and URL ride along as display context, so a
   * request that is later closed, renumbered or retargeted changes nothing
   * about what was recorded as delivered (leap, "Repository provenance").
   * Both hosts go through here, because the rule is the product's, not
   * GitHub's or Bitbucket's.
   */
  private async withLinkRef(
    result: GitPrCreateResult,
    located: Extract<Located, { ok: true }>,
    head: string,
  ): Promise<GitPrCreateResult> {
    if (result.outcome !== "done" || !result.pullRequest) return result;
    const pullRequest = result.pullRequest;
    const linkRef = await linkRefFor(
      this.run,
      located.repo,
      {
        branch: head,
        remote: located.remoteName,
        pullRequest: {
          number: pullRequest.number,
          host: pullRequest.host,
          ...(pullRequest.url ? { url: pullRequest.url } : {}),
          ...(pullRequest.title ? { title: pullRequest.title } : {}),
        },
      },
      head,
    );
    return linkRef ? { ...result, linkRef } : result;
  }

  async readPr(params: GitPrReadParams): Promise<GitPrReadResult> {
    const located = await this.locate(params.repo, params.runId);
    if (!located.ok) return located.result;
    if (located.host === "github") return readGithubPr(this.run, this.githubCtx(located), params.number);
    const result = await readBitbucketPr(this.fetch, bitbucketAuthFrom(this.env()), this.bitbucketCtx(located), params.number);
    if (result.pullRequest && this.viewedFile) {
      const viewed = listViewed(this.viewedFile, located.remote, params.number);
      const files = result.pullRequest.files ?? [];
      result.pullRequest.files = files.map((file) => {
        const mark = viewed.get(file.path);
        return mark === undefined ? file : { path: file.path, viewed: mark };
      });
    }
    return result;
  }

  async checkoutPr(params: GitPrCheckoutParams): Promise<GitPrCheckoutResult> {
    const located = await this.locate(params.repo, params.runId);
    if (!located.ok) return located.result;
    if (located.host === "github") return checkoutGithubPr(this.run, this.githubCtx(located), params.number, params.confirm, params.expect);
    return checkoutBitbucketPr(
      this.run,
      this.fetch,
      bitbucketAuthFrom(this.env()),
      this.bitbucketCtx(located),
      params.number,
      params.confirm,
      params.expect,
    );
  }

  async mergePr(params: GitPrMergeParams): Promise<GitPrMergeResult> {
    const located = await this.locate(params.repo, params.runId);
    if (!located.ok) return located.result;
    if (located.host === "github") {
      return mergeGithubPr(this.run, this.githubCtx(located), params.number, params.method, params.confirm, params.expect);
    }
    return mergeBitbucketPr(
      this.fetch,
      bitbucketAuthFrom(this.env()),
      this.bitbucketCtx(located),
      params.number,
      params.method,
      params.confirm,
      params.expect,
    );
  }

  async viewed(params: GitPrViewedParams): Promise<GitPrViewedResult> {
    assertPathspec(params.path);
    const located = await this.locate(params.repo, params.runId);
    if (!located.ok) return { ...located.result, path: params.path, viewed: params.viewed };
    if (located.host === "github") {
      return setGithubViewed(this.run, this.githubCtx(located), params.number, params.path, params.viewed);
    }
    if (!this.viewedFile) {
      return {
        outcome: "refused",
        message: "The viewed-file store is not configured.",
        confirmation: { repo: located.repo, branch: "", files: [params.path], summary: `Mark ${params.path} on pull request ${params.number}.` },
        path: params.path,
        viewed: params.viewed,
      };
    }
    return setLocalViewed(this.viewedFile, located.repo, located.remote, params.number, params.path, params.viewed);
  }

  private githubCtx(located: Extract<Located, { ok: true }>): GithubActionContext {
    return {
      repo: located.repo,
      remote: located.remote,
      remoteName: located.remoteName,
      cliReady: located.cliReady,
      ...(this.viewedFile ? { viewedFile: this.viewedFile } : {}),
    };
  }

  private bitbucketCtx(located: Extract<Located, { ok: true }>): BitbucketActionContext {
    return { repo: located.repo, remote: located.remote, remoteName: located.remoteName };
  }

  private async actionRepo(params: { repo?: string; runId?: string }): Promise<string> {
    if (params.runId) {
      const run = this.options.agentRun?.(params.runId);
      if (!run) throw new GitActionError("That agent run is not known.");
      if (run.worktree) {
        if (run.worktree.removedAt) {
          throw new GitActionError("That agent's worktree is gone, so this action cannot run there.");
        }
        try {
          const repo = await resolveRepoRoot(this.options.projectCwd, run.worktree.path);
          const inside = await this.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, timeoutMs: 5_000 });
          if (inside.code === 0 && inside.stdout.trim() === "true") return repo;
        } catch (error) {
          if (error instanceof GitActionError) throw error;
        }
        throw new GitActionError("That agent's worktree is gone, so this action cannot run there.");
      }
    }
    return resolveRepoRoot(this.options.projectCwd, params.repo);
  }

  private async locate(repoParam: string | undefined, runId?: string): Promise<Located> {
    const repo = await this.actionRepo({
      ...(repoParam ? { repo: repoParam } : {}),
      ...(runId ? { runId } : {}),
    });
    const shape = await this.workspace().catch(() => undefined);
    const hosts = await discoverHosts({
      projectCwd: this.options.projectCwd,
      run: this.run,
      env: this.env(),
      fetch: this.fetch,
      repos: [repo],
      ...(shape ? { workspace: shape } : {}),
    });
    const row = hosts[0];
    if (!row?.usable || (row.host !== "github" && row.host !== "bitbucket")) {
      const credential = row?.reason === "missing_cli" || row?.reason === "signed_out" || row?.reason === "missing_token";
      if (credential && row.host === "bitbucket") return { ok: false, result: missingTokenResult(repo) };
      const message = row?.fix ?? "This repository's host cannot be used.";
      const copyable =
        row?.reason === "missing_cli" || row?.reason === "signed_out"
          ? { argv: ["gh", "auth", "login"], cwd: repo }
          : undefined;
      return {
        ok: false,
        result: {
          outcome: credential ? "needs_copy" : "refused",
          message,
          confirmation: { repo, branch: row?.branch ?? "", summary: message },
          ...(copyable ? { copyable } : {}),
        },
      };
    }
    const parsed = parseRemoteUrl(row.remoteUrl ?? "");
    if (!parsed || parsed.host !== row.host) {
      return {
        ok: false,
        result: {
          outcome: "refused",
          message: "This repository's host cannot be used.",
          confirmation: { repo, branch: "", summary: "This repository's host cannot be used." },
        },
      };
    }
    return {
      ok: true,
      repo,
      remote: parsed,
      remoteName: row.remote ?? "origin",
      host: row.host,
      cliReady: row.host === "github" && row.usable === true,
    };
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
