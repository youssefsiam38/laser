/**
 * Per-repository host discovery. One failed repository never blocks another.
 * Rows run concurrently. `gh auth status` is probed once per call.
 */
import type { GitHostStatus, GitHostUnusableReason, WorkspaceShape } from "@lasercode/protocol";
import { GitActionError, resolveRepoRoot } from "./paths.js";
import { parseRemoteUrl } from "./remotes.js";
import type { GitActionsFetcher, ProcessRunner } from "./runner.js";

const GH_LOGIN = "gh auth login";
const BB_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const API = "https://api.bitbucket.org/2.0";

export interface HostDiscoveryOptions {
  projectCwd: string;
  run: ProcessRunner;
  env: NodeJS.ProcessEnv;
  repos?: string[];
  workspace?: WorkspaceShape;
  fetch?: GitActionsFetcher;
}

type GhAuth = Pick<GitHostStatus, "cliPresent" | "signedIn" | "usable"> & { fix?: string; reason?: GitHostUnusableReason };

export async function discoverHosts(options: HostDiscoveryOptions): Promise<GitHostStatus[]> {
  const names = await repositoryNames(options);
  const ghAuth = probeGithubAuth(options.run, options.projectCwd, options.env);
  const rows = await Promise.all(
    names.map(async (name) => {
      try {
        const repo = await resolveRepoRoot(options.projectCwd, name === options.projectCwd ? undefined : name);
        return await discoverOne(repo, options, ghAuth);
      } catch (error) {
        const message = error instanceof GitActionError ? error.message : "That repository could not be read.";
        return { repo: name, host: "unsupported" as const, usable: false, fix: message, reason: "not_git" as const };
      }
    }),
  );
  return rows;
}

async function repositoryNames(options: HostDiscoveryOptions): Promise<string[]> {
  const roots = options.workspace?.repositories.map((row) => row.root) ?? [];
  if (!options.repos || options.repos.length === 0) {
    return roots.length > 0 ? roots : [options.projectCwd];
  }
  if (roots.length === 0) return options.repos;
  const allowed = new Set(
    await Promise.all(roots.map((root) => resolveRepoRoot(options.projectCwd, root).catch(() => root))),
  );
  const names: string[] = [];
  for (const name of options.repos) {
    const resolved = await resolveRepoRoot(options.projectCwd, name).catch(() => "");
    if (resolved && allowed.has(resolved)) names.push(resolved);
  }
  return names;
}

async function discoverOne(repo: string, options: HostDiscoveryOptions, ghAuth: Promise<GhAuth>): Promise<GitHostStatus> {
  const run = options.run;
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, timeoutMs: 5_000 });
  if (!inside.spawned) {
    return { repo, host: "unsupported", usable: false, fix: "Install git, then open this project again.", reason: "not_git" };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { repo, host: "unsupported", usable: false, fix: "This folder is not a git repository.", reason: "not_git" };
  }
  const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  const remotes = await listRemotes(run, repo);
  const chosen = pickRemote(remotes);
  if (!chosen) {
    return {
      repo,
      host: "unsupported",
      ...(branch ? { branch } : {}),
      usable: false,
      fix: "Add a GitHub or Bitbucket remote, then try again.",
      reason: "no_remote",
    };
  }
  const parsed = parseRemoteUrl(chosen.url);
  const base: GitHostStatus = {
    repo,
    host: parsed?.host ?? "unsupported",
    remote: chosen.name,
    remoteUrl: chosen.url,
    ...(branch ? { branch } : {}),
    usable: false,
  };
  if (!parsed || parsed.host === "unsupported") {
    return {
      ...base,
      host: "unsupported",
      fix: `This remote is hosted on ${parsed?.hostname ?? "an unknown host"}, which is not supported. GitHub and Bitbucket work.`,
      reason: "unsupported_host",
    };
  }
  if (parsed.host === "github") {
    const cli = await ghAuth;
    const defaultBranch = await readDefaultBranch(run, repo, chosen.name, {
      host: "github",
      usable: cli.usable === true,
    });
    return {
      ...base,
      host: "github",
      cli: "gh",
      ...(defaultBranch ? { defaultBranch } : {}),
      ...cli,
    };
  }
  const auth = bitbucketAuth(options.env);
  const defaultBranch = await readDefaultBranch(run, repo, chosen.name, {
    host: "bitbucket",
    usable: auth.usable === true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    env: options.env,
    owner: parsed.owner,
    name: parsed.name,
  });
  return { ...base, host: "bitbucket", ...(defaultBranch ? { defaultBranch } : {}), ...auth };
}

interface Remote {
  name: string;
  url: string;
}

async function listRemotes(run: ProcessRunner, repo: string): Promise<Remote[]> {
  const result = await run("git", ["remote", "-v"], { cwd: repo, timeoutMs: 5_000 });
  const seen = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (match) seen.set(match[1]!, match[2]!);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

function pickRemote(remotes: Remote[]): Remote | undefined {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin) return origin;
  return remotes.find((remote) => {
    const parsed = parseRemoteUrl(remote.url);
    return parsed?.host === "github" || parsed?.host === "bitbucket";
  }) ?? remotes[0];
}

async function readDefaultBranch(
  run: ProcessRunner,
  repo: string,
  remote: string | undefined,
  live: {
    host: "github" | "bitbucket";
    usable: boolean;
    fetch?: GitActionsFetcher;
    env?: NodeJS.ProcessEnv;
    owner?: string;
    name?: string;
  },
): Promise<string | undefined> {
  if (live.host === "github" && live.usable) {
    const view = await run("gh", ["repo", "view", "--json", "defaultBranchRef"], { cwd: repo, timeoutMs: 15_000 });
    const name = ghDefaultBranch(view.stdout);
    if (name) return name;
  }
  if (live.host === "bitbucket" && live.usable && live.fetch && live.owner && live.name) {
    const name = await bitbucketDefaultBranch(live.fetch, live.env ?? {}, live.owner, live.name);
    if (name) return name;
  }
  if (remote) {
    const symbolic = await run("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { cwd: repo, timeoutMs: 5_000 });
    const name = symbolic.stdout.trim().split("/").slice(1).join("/");
    if (name) return name;
  }
  return undefined;
}

function ghDefaultBranch(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const ref = (parsed as { defaultBranchRef?: unknown }).defaultBranchRef;
    if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return undefined;
    const name = (ref as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function bitbucketDefaultBranch(
  fetchImpl: GitActionsFetcher,
  env: NodeJS.ProcessEnv,
  workspace: string,
  slug: string,
): Promise<string | undefined> {
  const token = (env.BITBUCKET_API_TOKEN ?? "").trim();
  if (!token) return undefined;
  try {
    const response = await fetchImpl({
      url: `${API}/repositories/${workspace}/${slug}?fields=mainbranch.name`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status !== 200) return undefined;
    const parsed: unknown = JSON.parse(response.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const main = (parsed as { mainbranch?: unknown }).mainbranch;
    if (main === null || typeof main !== "object" || Array.isArray(main)) return undefined;
    const name = (main as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function probeGithubAuth(run: ProcessRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<GhAuth> {
  const status = await run("gh", ["auth", "status"], { cwd, timeoutMs: 8_000, env });
  if (!status.spawned) {
    return { cliPresent: false, signedIn: false, usable: false, fix: `Install the GitHub CLI, then run ${GH_LOGIN}.`, reason: "missing_cli" };
  }
  if (status.code !== 0) {
    return { cliPresent: true, signedIn: false, usable: false, fix: `Run ${GH_LOGIN}.`, reason: "signed_out" };
  }
  return { cliPresent: true, signedIn: true, usable: true };
}

function bitbucketAuth(env: NodeJS.ProcessEnv): Pick<GitHostStatus, "cliPresent" | "signedIn" | "usable"> & { fix?: string; reason?: GitHostUnusableReason } {
  const token = (env.BITBUCKET_API_TOKEN ?? "").trim();
  if (!token) {
    return {
      cliPresent: true,
      signedIn: false,
      usable: false,
      fix: `Set BITBUCKET_API_TOKEN to an Atlassian API token with Bitbucket scopes (${BB_TOKEN_URL}).`,
      reason: "missing_token",
    };
  }
  return { cliPresent: true, signedIn: true, usable: true };
}
