/**
 * Per-repository host discovery. One failed repository never blocks another.
 */
import type { GitHostStatus } from "@lasercode/protocol";
import { GitActionError, resolveRepoRoot } from "./paths.js";
import { parseRemoteUrl } from "./remotes.js";
import type { ProcessRunner } from "./runner.js";

const GH_LOGIN = "gh auth login";
const BB_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export interface HostDiscoveryOptions {
  projectCwd: string;
  run: ProcessRunner;
  env: NodeJS.ProcessEnv;
  repos?: string[];
}

export async function discoverHosts(options: HostDiscoveryOptions): Promise<GitHostStatus[]> {
  const names = options.repos && options.repos.length > 0 ? options.repos : [options.projectCwd];
  const rows: GitHostStatus[] = [];
  for (const name of names) {
    try {
      const repo = await resolveRepoRoot(options.projectCwd, name === options.projectCwd ? undefined : name);
      rows.push(await discoverOne(repo, options.run, options.env));
    } catch (error) {
      const message = error instanceof GitActionError ? error.message : "That repository could not be read.";
      rows.push({ repo: name, host: "unsupported", usable: false, fix: message });
    }
  }
  return rows;
}

async function discoverOne(repo: string, run: ProcessRunner, env: NodeJS.ProcessEnv): Promise<GitHostStatus> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, timeoutMs: 5_000 });
  if (!inside.spawned) {
    return { repo, host: "unsupported", usable: false, fix: "Install git, then open this project again." };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { repo, host: "unsupported", usable: false, fix: "This folder is not a git repository." };
  }
  const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, timeoutMs: 5_000 })).stdout.trim();
  const remotes = await listRemotes(run, repo);
  const chosen = pickRemote(remotes);
  const defaultBranch = await readDefaultBranch(run, repo, chosen?.name);
  if (!chosen) {
    return {
      repo,
      host: "unsupported",
      ...(branch ? { branch } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      usable: false,
      fix: "Add a GitHub or Bitbucket remote, then try again.",
    };
  }
  const parsed = parseRemoteUrl(chosen.url);
  const base: GitHostStatus = {
    repo,
    host: parsed?.host ?? "unsupported",
    remote: chosen.name,
    remoteUrl: chosen.url,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(branch ? { branch } : {}),
    usable: false,
  };
  if (!parsed || parsed.host === "unsupported") {
    return { ...base, host: "unsupported", fix: `This remote is hosted on ${parsed?.hostname ?? "an unknown host"}, which is not supported. GitHub and Bitbucket work.` };
  }
  if (parsed.host === "github") {
    return { ...base, host: "github", cli: "gh", ...(await githubCli(run, repo, env)) };
  }
  return { ...base, host: "bitbucket", ...(await bitbucketAuth(env)) };
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

async function readDefaultBranch(run: ProcessRunner, repo: string, remote: string | undefined): Promise<string | undefined> {
  if (remote) {
    const symbolic = await run("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { cwd: repo, timeoutMs: 5_000 });
    const name = symbolic.stdout.trim().split("/").slice(1).join("/");
    if (name) return name;
  }
  for (const candidate of ["main", "master"]) {
    const check = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], { cwd: repo, timeoutMs: 5_000 });
    if (check.code === 0) return candidate;
  }
  return undefined;
}

async function githubCli(run: ProcessRunner, repo: string, env: NodeJS.ProcessEnv): Promise<Pick<GitHostStatus, "cliPresent" | "signedIn" | "usable"> & { fix?: string }> {
  const status = await run("gh", ["auth", "status"], { cwd: repo, timeoutMs: 8_000, env });
  if (!status.spawned) {
    return { cliPresent: false, signedIn: false, usable: false, fix: `Install the GitHub CLI, then run ${GH_LOGIN}.` };
  }
  if (status.code !== 0) {
    return { cliPresent: true, signedIn: false, usable: false, fix: `Run ${GH_LOGIN}.` };
  }
  return { cliPresent: true, signedIn: true, usable: true };
}

function bitbucketAuth(env: NodeJS.ProcessEnv): Pick<GitHostStatus, "cliPresent" | "signedIn" | "usable"> & { fix?: string } {
  const token = (env.BITBUCKET_API_TOKEN ?? "").trim();
  if (!token) {
    return {
      cliPresent: true,
      signedIn: false,
      usable: false,
      fix: `Set BITBUCKET_API_TOKEN to an Atlassian API token with Bitbucket scopes (${BB_TOKEN_URL}).`,
    };
  }
  return { cliPresent: true, signedIn: true, usable: true };
}
