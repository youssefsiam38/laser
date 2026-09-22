/**
 * The `repository` adapter: a public repository, pinned at an exact commit.
 *
 * | | |
 * | --- | --- |
 * | Reach | network, git only |
 * | Auth | none. A private host fails the way git fails, and says the credentials you already have are how it would be read |
 * | Rate | 10 requests a minute, two seconds apart |
 * | Search result | the repository itself and its tags, each at a resolved commit |
 * | Read result | readme, licence, manifest and named files at one commit, with a `RepositoryStateRef` |
 *
 * Everything happens through **git**, run by git-actions' own `ProcessRunner`
 * (argv, scrubbed environment, no shell, no terminal prompt) — `ls-remote` to
 * resolve, a shallow blobless `fetch` into a mirror under this project's
 * research cache, `ls-tree` and `cat-file` to read (D-351.e). No host API is
 * called: an issue or a pull request belongs to the `tracker` adapter, which
 * this version does not ship.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_DIR_NAME, researchAdapter, type RepositoryStateRef, type SourceRef } from "@lasercode/protocol";
import type { ProcessResult, ProcessRunner } from "../../git-actions/index.js";
import { digestOf } from "../cache.js";
import { ResearchRefused } from "../errors.js";
import { isPrivateResearchHost, refusePrivateHost } from "./fetch.js";
import { serveSource } from "./serve.js";
import { licenceClass, type ResearchAdapter, type ResearchAdapterContext, type ResearchHit, type ResearchReadInput, type ResearchReadResult, type ResearchSearchInput, type ResearchSearchResult } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 8;

/** Files a repository read always looks for, in the order it reports them. */
export const REPOSITORY_STAPLES = [
  /^readme(\.(md|rst|txt|adoc))?$/i,
  /^licen[cs]e(\.(md|txt))?$/i,
  /^copying(\.(md|txt))?$/i,
  /^(package\.json|pyproject\.toml|setup\.cfg|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json|gemspec|mix\.exs)$/i,
];

export interface ResolvedRepository {
  /** The https URL git is given. */
  url: string;
  host: string;
  /** `owner/name`, as a person says it. */
  slug: string;
}

/**
 * `owner/name`, an https URL or an ssh URL to the one form git is given.
 * A bare `owner/name` means github.com, which is the documented default.
 */
export function resolveRepositoryInput(value: string): ResolvedRepository {
  const trimmed = value.trim().replace(/^git\+/, "");
  const bare = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed);
  if (bare) {
    return { url: `https://github.com/${bare[1]!}/${bare[2]!}.git`, host: "github.com", slug: `${bare[1]!}/${bare[2]!}` };
  }
  const ssh = /^(?:ssh:\/\/)?git@([\w.-]+)[:/](.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) {
    return publicRepository({ url: `https://${ssh[1]!}/${ssh[2]!}.git`, host: ssh[1]!, slug: ssh[2]! });
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ResearchRefused(
      "bad_repository",
      `"${value.slice(0, 120)}" is not a repository. Name one as owner/name, or give its https address.`,
      "call search_sources on the repository adapter with owner/name, for example facebook/react",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ResearchRefused("bad_repository", "Repositories are read over https.", "give the https address of the repository");
  }
  const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (path === "") {
    throw new ResearchRefused("bad_repository", `${url.host} on its own is a host, not a repository.`, "give the full address, including the owner and the repository name");
  }
  return publicRepository({ url: `https://${url.host}/${path}.git`, host: url.host, slug: path });
}

/**
 * The same private-network floor the fetch guard applies (M21-T22).
 *
 * This adapter does not fetch: it hands a remote to **git**, which is egress
 * the fetch guard never sees. Without this, `read_source` on a loopback or
 * RFC1918 address would make git connect to this machine's own network on a
 * model's say-so.
 */
function publicRepository(repository: ResolvedRepository): ResolvedRepository {
  const hostname = repository.host.replace(/:\d+$/, "");
  if (isPrivateResearchHost(hostname)) throw refusePrivateHost(hostname);
  return repository;
}

function repositoryRef(repository: ResolvedRepository, commit?: string, title?: string): SourceRef {
  return {
    kind: "repository",
    id: commit ? `git:${repository.url}@${commit}` : `git:${repository.url}`,
    title: (title ?? repository.slug).slice(0, 500),
    fetchedVia: "repository",
    // A repository is the software itself: primary for what the code does,
    // never "official" for a claim about anything else.
    trust: "primary",
  };
}

/** `git:<url>[@<commit>]` back to its parts. */
export function parseRepositoryRef(id: string): { repository: ResolvedRepository; commit?: string } {
  const body = id.startsWith("git:") ? id.slice(4) : id;
  const at = body.lastIndexOf("@");
  const commit = at > 8 && /^[0-9a-f]{7,64}$/.test(body.slice(at + 1)) ? body.slice(at + 1) : undefined;
  const url = commit ? body.slice(0, at) : body;
  return { repository: resolveRepositoryInput(url), ...(commit !== undefined ? { commit } : {}) };
}

function gitRunner(context: ResearchAdapterContext): ProcessRunner {
  const run = context.run;
  if (!run) {
    throw new ResearchRefused(
      "git_unavailable",
      "Repositories are read with git, and git is not available to this session.",
      "read the project's own files instead, or ask the person to install git",
    );
  }
  return run;
}

function mirrorDirectory(context: ResearchAdapterContext, repository: ResolvedRepository): string {
  const base = context.stateDir ?? join(context.projectCwd, PROJECT_DIR_NAME, "state");
  const directory = join(base, "research", context.projectKey ?? "project", "repositories", digestOf(repository.url).slice(0, 32));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function refuseGit(repository: ResolvedRepository, result: ProcessResult): never {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (!result.spawned) {
    throw new ResearchRefused("git_unavailable", "git is not installed on this machine, so repositories cannot be read.", "read the package registry entry instead, or ask the person to install git");
  }
  if (result.timedOut) {
    throw new ResearchRefused("repository_slow", `${repository.slug} did not answer in time.`, "try again later, or read the package registry entry for the same project");
  }
  if (/authentication|could not read username|permission denied|access denied|403/.test(output)) {
    throw new ResearchRefused(
      "repository_private",
      `${repository.slug} is private, or it does not exist. Research reads public repositories only; a private one is read with the credentials you already use for ${repository.host} in source control.`,
      "name a public repository, or ask the person to open that repository in a project so it can be read from there",
    );
  }
  if (/not found|repository does not exist|does not appear to be a git repository/.test(output)) {
    throw new ResearchRefused("repository_not_found", `${repository.host} has no repository called ${repository.slug}.`, "check the owner and name, or search the web for the project's repository");
  }
  throw new ResearchRefused(
    "repository_unreadable",
    `${repository.slug} could not be read from ${repository.host}.`,
    "read the package registry entry for the same project, or try another source",
  );
}

async function resolveCommit(context: ResearchAdapterContext, repository: ResolvedRepository, ref: string): Promise<string> {
  const run = gitRunner(context);
  const directory = mirrorDirectory(context, repository);
  const result = await run("git", ["ls-remote", "--quiet", repository.url, ref], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
  if (!result.spawned || result.code !== 0) refuseGit(repository, result);
  const line = result.stdout.split("\n").find((row) => row.trim() !== "");
  const commit = line?.split(/\s+/)[0];
  if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new ResearchRefused(
      "repository_not_found",
      `${repository.slug} has nothing at ${ref}.`,
      "read the repository at its default branch, or name a tag the repository really has",
    );
  }
  return commit;
}

async function fetchCommit(context: ResearchAdapterContext, repository: ResolvedRepository, commit: string): Promise<string> {
  const run = gitRunner(context);
  const directory = mirrorDirectory(context, repository);
  const init = await run("git", ["init", "--bare", "--quiet"], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
  if (!init.spawned) refuseGit(repository, init);
  const fetched = await run("git", ["fetch", "--quiet", "--depth", "1", "--filter=blob:none", repository.url, commit], {
    cwd: directory,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!fetched.spawned || fetched.code !== 0) {
    // A server that will not serve one commit still serves its branches.
    const head = await run("git", ["fetch", "--quiet", "--depth", "1", "--filter=blob:none", repository.url, "HEAD"], {
      cwd: directory,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (!head.spawned || head.code !== 0) refuseGit(repository, head);
  }
  return directory;
}

async function readTree(run: ProcessRunner, directory: string, commit: string): Promise<string[]> {
  const result = await run("git", ["ls-tree", "--name-only", commit], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
  if (!result.spawned || result.code !== 0) return [];
  return result.stdout.split("\n").map((row) => row.trim()).filter((row) => row !== "");
}

async function readBlob(run: ProcessRunner, directory: string, commit: string, path: string): Promise<string | undefined> {
  const result = await run("git", ["cat-file", "-p", `${commit}:${path}`], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
  if (!result.spawned || result.code !== 0) return undefined;
  return result.stdout.slice(0, MAX_FILE_BYTES);
}

export const repositoryResearchAdapter: ResearchAdapter = {
  id: "repository",
  descriptor: researchAdapter("repository"),

  /**
   * Resolve one repository and list what can be read from it: the commit its
   * default branch is at, and its tags. It does **not** search for
   * repositories by keyword — no documented keyword API is called here — and
   * says so, with the adapter that does find them.
   */
  async search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult> {
    context.ledger.chargeSearch("repository", input.query);
    const repository = resolveRepositoryInput(input.query);
    const run = gitRunner(context);
    const directory = mirrorDirectory(context, repository);
    const head = await resolveCommit(context, repository, "HEAD");
    const hits: ResearchHit[] = [
      {
        sourceRef: repositoryRef(repository, head, repository.slug),
        title: repository.slug,
        snippet: `${repository.slug} at ${head.slice(0, 12)} on ${repository.host}. Read it for its readme, licence, manifest and any file you name.`,
      },
    ];
    const tags = await run("git", ["ls-remote", "--tags", "--refs", "--quiet", repository.url], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
    if (tags.spawned && tags.code === 0) {
      const rows = tags.stdout
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== "")
        .map((row) => {
          const [commit, ref] = row.split(/\s+/);
          return { commit: commit ?? "", name: (ref ?? "").replace("refs/tags/", "") };
        })
        .filter((row) => /^[0-9a-f]{7,64}$/.test(row.commit) && row.name !== "");
      for (const tag of rows.slice(-Math.max(0, input.limit - 1)).reverse()) {
        hits.push({
          sourceRef: repositoryRef(repository, tag.commit, `${repository.slug}@${tag.name}`),
          title: `${repository.slug}@${tag.name}`,
          snippet: `Release ${tag.name} at ${tag.commit.slice(0, 12)}.`,
        });
      }
    }
    return {
      hits: hits.slice(0, input.limit),
      notes: ["This source reads a repository you name; it does not search for repositories. Use the web or a package registry to find one."],
    };
  },

  async read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult> {
    const { repository, commit: pinned } = parseRepositoryRef(input.ref.id);
    const run = gitRunner(context);
    const commit = pinned ?? (await resolveCommit(context, repository, "HEAD"));
    const source: SourceRef = repositoryRef(repository, commit, input.ref.title !== "" ? input.ref.title : repository.slug);
    const objectFormat: RepositoryStateRef["objectFormat"] = commit.length > 40 ? "sha256" : "sha1";
    const state: RepositoryStateRef = { vcs: "git", objectFormat, commitObjectId: commit };

    const named = (input.paths ?? []).filter((path) => path !== "" && !path.startsWith("/") && !path.includes("..")).slice(0, MAX_FILES);
    return serveSource({
      context,
      source,
      repositoryState: state,
      // Reading three named files and reading the readme are two bodies of one
      // source: same commit to cite, different text to quote.
      ...(named.length > 0 ? { cacheKey: `${source.id}#${[...named].sort().join(",")}` } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      load: async () => {
        const directory = await fetchCommit(context, repository, commit);
        const tree = await readTree(run, directory, commit);
        const staples = tree.filter((path) => REPOSITORY_STAPLES.some((pattern) => pattern.test(path)));
        const wanted = [...new Set([...named, ...staples])].slice(0, MAX_FILES);
        const parts: string[] = [`# ${repository.slug} at ${commit}`, `Host: ${repository.host}`, ""];
        const missing: string[] = [];
        let licence = "unknown";
        for (const path of wanted) {
          const blob = await readBlob(run, directory, commit, path);
          if (blob === undefined) {
            missing.push(path);
            continue;
          }
          parts.push(`## ${path}`, blob.trimEnd(), "");
          if (/^licen[cs]e|^copying/i.test(path)) licence = blob.slice(0, 4000);
          if (path.toLowerCase() === "package.json") {
            try {
              const manifest = JSON.parse(blob) as { license?: unknown };
              if (typeof manifest.license === "string") licence = manifest.license;
            } catch {
              // A manifest that does not parse is reported as a file, not as a failure.
            }
          }
        }
        if (wanted.length === 0) {
          parts.push("This repository has no readme, licence or manifest at its root.", "", `Files at the root: ${tree.slice(0, 50).join(", ")}`);
        }
        const text = parts.join("\n");
        return {
          text,
          digest: digestOf(text),
          bytes: Buffer.byteLength(text, "utf8"),
          canonical: `${repository.url.replace(/\.git$/, "")}/tree/${commit}`,
          title: `${repository.slug} @ ${commit.slice(0, 12)}`,
          licence: licenceClass(licence),
          notices: [
            `Read at commit ${commit}; cite that state, not the branch.`,
            ...(missing.length > 0 ? [`Not in this commit: ${missing.join(", ")}.`] : []),
          ],
        };
      },
    });
  },
};
