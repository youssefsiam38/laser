/**
 * Workspace shapes (source-control leap L1).
 *
 * A project directory is not always one git repository. The harness and the
 * host both need to know which of five shapes they are looking at, so an
 * agent can be isolated when that is possible and share the checkout — with
 * a sentence saying why — when it is not.
 *
 * This module is pure: it never spawns a process. Callers inject a git runner
 * and a directory listing, the same seam `GitRunner` uses in the worker.
 */

/** The five shapes a project directory can have. */
export const WORKSPACE_SHAPE_KINDS = [
  "repo",
  "workspace-of-repos",
  "no-git",
  "nested-repo",
  "bare-or-submodule",
] as const;
export type WorkspaceShapeKind = (typeof WORKSPACE_SHAPE_KINDS)[number];

/**
 * Per-project default for how `start_agent` treats `worktree: true` / absent.
 * `decide` is today's behaviour (the argument is authoritative).
 */
export const AGENT_ISOLATION_DEFAULTS = ["decide", "isolate", "share"] as const;
export type AgentIsolationDefault = (typeof AGENT_ISOLATION_DEFAULTS)[number];
export const AGENT_ISOLATION_DEFAULT: AgentIsolationDefault = "decide";

/** How a child actually works: its own worktree, or the parent's checkout. */
export const AGENT_ISOLATION_MODES = ["worktree", "shared"] as const;
export type AgentIsolationMode = (typeof AGENT_ISOLATION_MODES)[number];

/**
 * The isolation choice, stored on the run so every surface can say where the
 * child is writing and why. Optional on persisted runs written before L1.
 */
export interface AgentIsolation {
  mode: AgentIsolationMode;
  shape: WorkspaceShapeKind;
  /** A sentence a person would write. */
  reason: string;
}

/** `start_agent`'s `worktree` argument after parsing. Absent becomes `true`. */
export type WorktreeArg = boolean | "strict";

export interface WorkspaceRepository {
  root: string;
  name: string;
  /** True when this repository's working tree is the directory we resolved. */
  projectRoot: boolean;
  /** Absolute git common dir (`rev-parse --git-common-dir`). */
  gitDir: string;
  /**
   * `rev-parse --is-inside-work-tree`. False for a bare repository, which the
   * checkpoint engine must never write refs into.
   */
  insideWorkTree: boolean;
}

export interface WorkspaceShape {
  cwd: string;
  kind: WorkspaceShapeKind;
  repositories: WorkspaceRepository[];
  /** Whether `cwd` has a commit (`rev-parse --verify HEAD`). */
  hasCommit: boolean;
  /**
   * True when discovery stopped at {@link WORKSPACE_SCAN_MAX_REPOS} with
   * unvisited directories remaining, so the repository count is a floor.
   */
  truncated: boolean;
}

/**
 * A work tree the checkpoint engine may write refs into.
 *
 * `path` is the work-tree root (`rev-parse --show-toplevel`). `gitDir` is the
 * absolute common dir (`rev-parse --git-common-dir`).
 */
export interface WorkspaceWorkTree {
  path: string;
  gitDir: string;
}

/**
 * Child-repository discovery depth. A workspace of repos is typically one
 * level down; 3 covers org/team/repo layouts without walking a home directory.
 *
 * The harness (isolation) and the checkpoint engine (which repositories a
 * session belongs to) share this bound: disagreeing depths would checkpoint a
 * different set than `start_agent` described.
 */
export const WORKSPACE_SCAN_MAX_DEPTH = 3;
/**
 * A workspace of many repositories is real (one fixture on the author's
 * machine has 41). Unbounded discovery is not: stop after this many.
 *
 * Shared with the checkpoint engine, same reason as {@link WORKSPACE_SCAN_MAX_DEPTH}.
 */
export const WORKSPACE_SCAN_MAX_REPOS = 64;

/** Directory names that are never repositories and never worth opening. */
export const WORKSPACE_SCAN_SKIP_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
  "out",
  "__pycache__",
]);

export interface WorkspaceDirent {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * Injected IO. Git is always an argument array; the implementation must set
 * `GIT_OPTIONAL_LOCKS=0` and must never export `GIT_INDEX_FILE`.
 */
export interface WorkspaceIO {
  run(args: readonly string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  list(path: string): Promise<WorkspaceDirent[]>;
  exists(path: string): Promise<boolean>;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
}

function samePath(io: WorkspaceIO, a: string, b: string): boolean {
  return io.resolve(a) === io.resolve(b);
}

async function gitText(io: WorkspaceIO, cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await io.run(args, cwd);
  if (!result.ok) return undefined;
  const text = result.stdout.trim();
  return text || undefined;
}

async function gitToplevel(io: WorkspaceIO, cwd: string): Promise<string | undefined> {
  const top = await gitText(io, cwd, ["rev-parse", "--show-toplevel"]);
  return top ? io.resolve(top) : undefined;
}

async function gitCommonDir(io: WorkspaceIO, cwd: string): Promise<string | undefined> {
  const common = await gitText(io, cwd, ["rev-parse", "--git-common-dir"]);
  return common ? io.resolve(cwd, common) : undefined;
}

async function isInsideWorkTree(io: WorkspaceIO, cwd: string): Promise<boolean> {
  return (await gitText(io, cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

async function hasHead(io: WorkspaceIO, cwd: string): Promise<boolean> {
  return (await gitText(io, cwd, ["rev-parse", "--verify", "HEAD"])) !== undefined;
}

async function describeRepo(io: WorkspaceIO, root: string, cwd: string): Promise<WorkspaceRepository> {
  const gitDir = (await gitCommonDir(io, root)) ?? io.resolve(root, ".git");
  return {
    root,
    name: io.basename(root) || root,
    projectRoot: samePath(io, root, cwd),
    gitDir,
    insideWorkTree: await isInsideWorkTree(io, root),
  };
}

function skipDir(name: string): boolean {
  return name.startsWith(".") || WORKSPACE_SCAN_SKIP_NAMES.has(name);
}

/**
 * Bounded walk for nested `.git` directories. `rev-parse` runs only where a
 * `.git` entry exists, so a subdirectory of a monorepo is not a git spawn.
 * A directory already identified as a repository is not descended into:
 * vendored copies inside it must not inflate the count or burn the cap.
 */
async function findGitDirs(
  io: WorkspaceIO,
  root: string,
  maxDepth: number,
  maxRepos: number,
): Promise<{ roots: string[]; truncated: boolean }> {
  const found: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    if (found.length >= maxRepos) return { roots: found, truncated: true };
    const next = queue.shift();
    if (!next) break;
    const { path, depth } = next;
    if (depth > 0 && (await io.exists(io.join(path, ".git")))) {
      const top = await gitToplevel(io, path);
      if (top && !found.some((existing) => samePath(io, existing, top))) found.push(top);
      continue;
    }
    if (depth >= maxDepth) continue;
    const entries = await io.list(path);
    for (const entry of entries) {
      if (!entry.isDirectory || skipDir(entry.name)) continue;
      queue.push({ path: entry.path, depth: depth + 1 });
    }
  }
  return { roots: found, truncated: false };
}

async function isBare(io: WorkspaceIO, cwd: string): Promise<boolean> {
  const value = await gitText(io, cwd, ["rev-parse", "--is-bare-repository"]);
  return value === "true";
}

async function isSubmodule(io: WorkspaceIO, cwd: string): Promise<boolean> {
  return (await gitText(io, cwd, ["rev-parse", "--show-superproject-working-tree"])) !== undefined;
}

function emptyShape(cwd: string, kind: WorkspaceShapeKind, repositories: WorkspaceRepository[], extra?: { hasCommit?: boolean; truncated?: boolean }): WorkspaceShape {
  return {
    cwd,
    kind,
    repositories,
    hasCommit: extra?.hasCommit ?? false,
    truncated: extra?.truncated ?? false,
  };
}

/**
 * Resolve the workspace shape of `cwd`. Discovery is depth-limited, skips
 * `node_modules`, `.git`, other dot-directories and obvious build output, and
 * stops after {@link WORKSPACE_SCAN_MAX_REPOS} repositories. Parent directories
 * are not walked: an ancestor repository (a dotfiles-style `$HOME`, a linked
 * worktree's main checkout) must not relabel an ordinary project.
 */
export async function resolveWorkspaceShape(cwd: string, io: WorkspaceIO): Promise<WorkspaceShape> {
  const resolved = io.resolve(cwd);
  const toplevel = await gitToplevel(io, resolved);
  if (toplevel) {
    const nested = await findGitDirs(io, resolved, WORKSPACE_SCAN_MAX_DEPTH, WORKSPACE_SCAN_MAX_REPOS);
    const nestedChildren = nested.roots.filter((root) => !samePath(io, root, toplevel));
    const submodule = await isSubmodule(io, resolved);
    const bare = await isBare(io, resolved);
    const repositories = [await describeRepo(io, toplevel, resolved)];
    for (const root of nestedChildren) {
      if (!repositories.some((row) => samePath(io, row.root, root))) {
        repositories.push(await describeRepo(io, root, resolved));
      }
    }
    let kind: WorkspaceShapeKind = "repo";
    if (bare || submodule) kind = "bare-or-submodule";
    else if (nestedChildren.length > 0) kind = "nested-repo";
    return {
      cwd: resolved,
      kind,
      repositories,
      hasCommit: await hasHead(io, resolved),
      truncated: nested.truncated,
    };
  }

  if (await isBare(io, resolved)) {
    const common = await gitCommonDir(io, resolved);
    const root = common ?? resolved;
    return emptyShape(resolved, "bare-or-submodule", [
      {
        root,
        name: io.basename(root) || root,
        projectRoot: false,
        gitDir: root,
        insideWorkTree: false,
      },
    ], { hasCommit: await hasHead(io, resolved) });
  }

  const children = await findGitDirs(io, resolved, WORKSPACE_SCAN_MAX_DEPTH, WORKSPACE_SCAN_MAX_REPOS);
  if (children.roots.length > 0) {
    return {
      cwd: resolved,
      kind: "workspace-of-repos",
      repositories: await Promise.all(children.roots.map((root) => describeRepo(io, root, resolved))),
      hasCommit: false,
      truncated: children.truncated,
    };
  }
  return emptyShape(resolved, "no-git", []);
}

/**
 * Results are cached per resolved cwd and dropped only on an explicit rescan.
 * In-flight resolves share one promise so a parent starting several children
 * does not walk the tree once per child. There is no filesystem watcher
 * (not in this leap).
 */
export class WorkspaceResolver {
  private readonly cache = new Map<string, Promise<WorkspaceShape>>();

  constructor(private readonly io: WorkspaceIO) {}

  async resolve(cwd: string, options?: { rescan?: boolean }): Promise<WorkspaceShape> {
    const key = this.io.resolve(cwd);
    if (options?.rescan) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = resolveWorkspaceShape(key, this.io);
    this.cache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      throw error;
    }
  }
}

/**
 * True when this workspace can give a child its own git worktree. A working
 * tree with a commit counts, including a nested repository. A workspace of
 * many repositories, a directory with no git, a repository with no commits,
 * and a bare repository cannot. A submodule with a working tree and a commit
 * still can — the harness isolates from its own common dir.
 *
 * Listing `.gitmodules` does not change this: a superproject is an ordinary
 * repository as far as isolation is concerned.
 */
export function workspaceCanIsolate(shape: WorkspaceShape): boolean {
  if (shape.kind === "no-git" || shape.kind === "workspace-of-repos") return false;
  if (!shape.hasCommit) return false;
  if (shape.kind === "bare-or-submodule") {
    return shape.repositories.some((row) => row.projectRoot && row.insideWorkTree);
  }
  return true;
}

/**
 * The checkout `.worktrees/` belongs in: the parent of `--git-common-dir`
 * when that dir is named `.git`, otherwise the git toplevel. A linked
 * worktree's children land beside siblings under the main checkout, never
 * nested inside the linked worktree.
 */
export function worktreesHome(
  gitCommonDir: string,
  toplevel: string,
  pathIo: Pick<WorkspaceIO, "basename" | "dirname">,
): string {
  return pathIo.basename(gitCommonDir) === ".git" ? pathIo.dirname(gitCommonDir) : toplevel;
}

/**
 * Repositories the checkpoint engine may write refs into.
 *
 * Same discovery bounds as the harness ({@link WORKSPACE_SCAN_MAX_DEPTH},
 * {@link WORKSPACE_SCAN_MAX_REPOS}). Bare repositories are excluded: they
 * have no work tree (`insideWorkTree` is false).
 *
 * The worker's `sessionRepositories` and the host's checkpoint cleanup should
 * become `return listCheckpointRepositories(await resolver.resolve(cwd))`.
 */
export function listCheckpointRepositories(shape: WorkspaceShape): WorkspaceWorkTree[] {
  return shape.repositories
    .filter((row) => row.insideWorkTree)
    .map((row) => ({ path: row.root, gitDir: row.gitDir }));
}

function repositoryCountLabel(shape: WorkspaceShape): string {
  if (shape.truncated) return `more than ${WORKSPACE_SCAN_MAX_REPOS}`;
  return String(shape.repositories.length);
}

export type IsolationResolution =
  | { kind: "worktree"; isolation: AgentIsolation }
  | { kind: "shared"; isolation: AgentIsolation }
  | { kind: "refused"; message: string };

function isolatedWorktreeReason(shape: WorkspaceShape): string {
  if (shape.kind === "nested-repo") return "This nested repository is isolated on its own.";
  return "This agent works in its own worktree, isolated from your checkout.";
}

function sharedCheckoutReason(input: {
  worktree: WorktreeArg;
  projectDefault: AgentIsolationDefault;
  shape: WorkspaceShape;
}): string {
  if (input.worktree === false) {
    return "This agent shares your checkout because it was started with worktree false.";
  }
  if (input.projectDefault === "share") {
    return "This project is set to share your checkout, so this agent is not isolated.";
  }
  switch (input.shape.kind) {
    case "no-git":
      return "No repository here, so this agent shares your checkout.";
    case "workspace-of-repos": {
      const n = repositoryCountLabel(input.shape);
      const noun = n === "1" ? "repository" : "repositories";
      return `This workspace holds ${n} ${noun}, so an agent cannot be isolated from all of them; sharing your checkout.`;
    }
    case "bare-or-submodule":
      return "This repository is a bare repository or a submodule, so this agent shares your checkout.";
    default:
      if (!input.shape.hasCommit) {
        return "This repository has no commits yet, so this agent shares your checkout.";
      }
      return "This agent shares your checkout.";
  }
}

/**
 * D-156 refusal: isolation was demanded and this workspace cannot give it.
 * Always names both ways forward (git, or `worktree: false`). Fires only for
 * `"strict"` or a project default of `"isolate"` — never for default `true`.
 */
function strictIsolationRefusal(shape: WorkspaceShape): string {
  switch (shape.kind) {
    case "no-git":
      return "This project is not a git repository, so agents cannot get an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
    case "workspace-of-repos": {
      const n = repositoryCountLabel(shape);
      const noun = n === "1" ? "repository" : "repositories";
      return `This workspace holds ${n} ${noun}, so agents cannot get an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.`;
    }
    case "bare-or-submodule":
      return "This project cannot give an isolated worktree (it is a bare repository or a submodule). Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
    default:
      if (!shape.hasCommit) {
        return "This project has no commits yet, so agents cannot get an isolated worktree. Either make a first commit, or start this agent with worktree false so it works in this checkout.";
      }
      return "This project cannot give an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
  }
}

/**
 * Isolation precedence (L1):
 *
 * 1. `worktree: false` always shares. The project default cannot override an
 *    explicit share (D-156).
 * 2. `worktree: "strict"` always demands isolation and refuses without it.
 *    The project default cannot override that.
 * 3. `worktree: true` / absent follows the project default:
 *    - `"isolate"` → same as `"strict"` (demand isolation; refuse without it)
 *    - `"share"` → share the checkout
 *    - `"decide"` (default) → isolate if {@link workspaceCanIsolate}, else share
 */
export function resolveIsolation(input: {
  worktree: WorktreeArg;
  projectDefault: AgentIsolationDefault;
  shape: WorkspaceShape;
}): IsolationResolution {
  const isolationOf = (isolate: boolean): AgentIsolation => ({
    mode: isolate ? "worktree" : "shared",
    shape: input.shape.kind,
    reason: isolate
      ? isolatedWorktreeReason(input.shape)
      : sharedCheckoutReason(input),
  });

  if (input.worktree === false) return { kind: "shared", isolation: isolationOf(false) };
  if (input.worktree === true && input.projectDefault === "share") {
    return { kind: "shared", isolation: isolationOf(false) };
  }

  const demand = input.worktree === "strict" || input.projectDefault === "isolate";
  const can = workspaceCanIsolate(input.shape);
  if (demand && !can) return { kind: "refused", message: strictIsolationRefusal(input.shape) };
  if (can) return { kind: "worktree", isolation: isolationOf(true) };
  return { kind: "shared", isolation: isolationOf(false) };
}
