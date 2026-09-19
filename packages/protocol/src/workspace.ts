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
}

export interface WorkspaceShape {
  cwd: string;
  kind: WorkspaceShapeKind;
  repositories: WorkspaceRepository[];
}

/**
 * Child-repository discovery depth. A workspace of repos is typically one
 * level down; 3 covers org/team/repo layouts without walking a home directory.
 */
export const WORKSPACE_SCAN_MAX_DEPTH = 3;
/**
 * A workspace of many repositories is real (one fixture on the author's
 * machine has 41). Unbounded discovery is not: stop after this many.
 */
export const WORKSPACE_SCAN_MAX_REPOS = 64;
/**
 * Parent-directory walk when detecting a repository nested inside another.
 * Eight steps is enough to leave a typical working tree and not enough to
 * crawl from a deep path to `/`.
 */
export const WORKSPACE_PARENT_WALK_MAX = 8;

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

function repoOf(io: WorkspaceIO, root: string, cwd: string): WorkspaceRepository {
  return { root, name: io.basename(root) || root, projectRoot: samePath(io, root, cwd) };
}

function skipDir(name: string): boolean {
  return name.startsWith(".") || WORKSPACE_SCAN_SKIP_NAMES.has(name);
}

/**
 * Bounded walk for nested `.git` directories. `rev-parse` runs only where a
 * `.git` entry exists, so a subdirectory of a monorepo is not a git spawn.
 */
async function findGitDirs(io: WorkspaceIO, root: string, maxDepth: number, maxRepos: number): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0 && found.length < maxRepos) {
    const next = queue.shift();
    if (!next) break;
    const { path, depth } = next;
    if (depth > 0 && (await io.exists(io.join(path, ".git")))) {
      const top = await gitToplevel(io, path);
      if (top && !found.some((existing) => samePath(io, existing, top))) found.push(top);
      if (found.length >= maxRepos) break;
    }
    if (depth >= maxDepth) continue;
    const entries = await io.list(path);
    for (const entry of entries) {
      if (!entry.isDirectory || skipDir(entry.name)) continue;
      queue.push({ path: entry.path, depth: depth + 1 });
    }
  }
  return found;
}

async function parentIsOtherRepo(io: WorkspaceIO, toplevel: string): Promise<boolean> {
  let dir = io.dirname(toplevel);
  for (let i = 0; i < WORKSPACE_PARENT_WALK_MAX; i++) {
    const parent = io.dirname(dir);
    const top = await gitToplevel(io, dir);
    if (top && !samePath(io, top, toplevel)) return true;
    if (samePath(io, dir, parent)) break;
    dir = parent;
  }
  return false;
}

async function isBare(io: WorkspaceIO, cwd: string): Promise<boolean> {
  const value = await gitText(io, cwd, ["rev-parse", "--is-bare-repository"]);
  return value === "true";
}

async function isSubmodule(io: WorkspaceIO, cwd: string): Promise<boolean> {
  return (await gitText(io, cwd, ["rev-parse", "--show-superproject-working-tree"])) !== undefined;
}

/**
 * Resolve the workspace shape of `cwd`. Discovery is depth-limited, skips
 * `node_modules`, `.git`, other dot-directories and obvious build output, and
 * stops after {@link WORKSPACE_SCAN_MAX_REPOS} repositories.
 */
export async function resolveWorkspaceShape(cwd: string, io: WorkspaceIO): Promise<WorkspaceShape> {
  const resolved = io.resolve(cwd);
  const toplevel = await gitToplevel(io, resolved);
  if (toplevel) {
    const nestedChildren = (await findGitDirs(io, resolved, WORKSPACE_SCAN_MAX_DEPTH, WORKSPACE_SCAN_MAX_REPOS)).filter(
      (root) => !samePath(io, root, toplevel),
    );
    const nestedParent = await parentIsOtherRepo(io, toplevel);
    const gitmodules = await io.exists(io.join(toplevel, ".gitmodules"));
    const submodule = await isSubmodule(io, resolved);
    const bare = await isBare(io, resolved);
    const repositories = [repoOf(io, toplevel, resolved)];
    for (const root of nestedChildren) {
      if (!repositories.some((row) => samePath(io, row.root, root))) repositories.push(repoOf(io, root, resolved));
    }
    let kind: WorkspaceShapeKind = "repo";
    if (bare || submodule || gitmodules) kind = "bare-or-submodule";
    else if (nestedChildren.length > 0 || nestedParent) kind = "nested-repo";
    return { cwd: resolved, kind, repositories };
  }

  if (await isBare(io, resolved)) {
    const common = await gitText(io, resolved, ["rev-parse", "--git-common-dir"]);
    const root = common ? io.resolve(resolved, common) : resolved;
    // No working tree, so this directory is not a project root we can isolate.
    return {
      cwd: resolved,
      kind: "bare-or-submodule",
      repositories: [{ root, name: io.basename(root) || root, projectRoot: false }],
    };
  }

  const children = await findGitDirs(io, resolved, WORKSPACE_SCAN_MAX_DEPTH, WORKSPACE_SCAN_MAX_REPOS);
  if (children.length > 0) {
    return {
      cwd: resolved,
      kind: "workspace-of-repos",
      repositories: children.map((root) => repoOf(io, root, resolved)),
    };
  }
  return { cwd: resolved, kind: "no-git", repositories: [] };
}

/**
 * Results are cached per resolved cwd and dropped only on an explicit rescan.
 * There is no filesystem watcher (not in this leap).
 */
export class WorkspaceResolver {
  private readonly cache = new Map<string, WorkspaceShape>();

  constructor(private readonly io: WorkspaceIO) {}

  async resolve(cwd: string, options?: { rescan?: boolean }): Promise<WorkspaceShape> {
    const key = this.io.resolve(cwd);
    if (options?.rescan) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const shape = await resolveWorkspaceShape(key, this.io);
    this.cache.set(key, shape);
    return shape;
  }
}

/**
 * True when this workspace can give a child its own git worktree. A working
 * tree we can attach one to counts, including a nested repository and a
 * repository that happens to list submodules. A workspace of many repositories,
 * a directory with no git, and a bare repository cannot.
 */
export function workspaceCanIsolate(shape: WorkspaceShape): boolean {
  if (shape.kind === "no-git" || shape.kind === "workspace-of-repos") return false;
  if (shape.kind === "bare-or-submodule") {
    return shape.repositories.some((row) => row.projectRoot);
  }
  return true;
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
export function isolationDemandsWorktree(
  worktree: WorktreeArg,
  projectDefault: AgentIsolationDefault,
): boolean {
  if (worktree === false) return false;
  if (worktree === "strict") return true;
  return projectDefault === "isolate";
}

export function isolationPrefersShare(
  worktree: WorktreeArg,
  projectDefault: AgentIsolationDefault,
): boolean {
  return worktree === true && projectDefault === "share";
}

export function decideIsolation(input: {
  worktree: WorktreeArg;
  projectDefault: AgentIsolationDefault;
  shape: WorkspaceShape;
}): { isolate: boolean; demand: boolean } {
  if (input.worktree === false) return { isolate: false, demand: false };
  if (isolationPrefersShare(input.worktree, input.projectDefault)) return { isolate: false, demand: false };
  const demand = isolationDemandsWorktree(input.worktree, input.projectDefault);
  if (demand) return { isolate: true, demand: true };
  return { isolate: workspaceCanIsolate(input.shape), demand: false };
}

export function sharedCheckoutReason(input: {
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
      const n = input.shape.repositories.length;
      return `This workspace holds ${n} ${n === 1 ? "repository" : "repositories"}, so an agent cannot be isolated from all of them; sharing your checkout.`;
    }
    case "bare-or-submodule":
      return "This repository is a bare repository or a submodule, so this agent shares your checkout.";
    default:
      return "This agent shares your checkout.";
  }
}

export function isolatedWorktreeReason(shape: WorkspaceShape): string {
  if (shape.kind === "nested-repo") return "This nested repository is isolated on its own.";
  return "This agent works in its own worktree, isolated from your checkout.";
}

/**
 * D-156 refusal: isolation was demanded and this workspace cannot give it.
 * Always names both ways forward (git, or `worktree: false`).
 */
export function strictIsolationRefusal(shape: WorkspaceShape): string {
  switch (shape.kind) {
    case "no-git":
      return "This project is not a git repository, so agents cannot get an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
    case "workspace-of-repos": {
      const n = shape.repositories.length;
      return `This workspace holds ${n} ${n === 1 ? "repository" : "repositories"}, so agents cannot get an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.`;
    }
    case "bare-or-submodule":
      return "This project cannot give an isolated worktree (it is a bare repository or a submodule). Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
    default:
      return "This project cannot give an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.";
  }
}

export function describeIsolation(input: {
  isolate: boolean;
  worktree: WorktreeArg;
  projectDefault: AgentIsolationDefault;
  shape: WorkspaceShape;
}): AgentIsolation {
  return {
    mode: input.isolate ? "worktree" : "shared",
    shape: input.shape.kind,
    reason: input.isolate
      ? isolatedWorktreeReason(input.shape)
      : sharedCheckoutReason(input),
  };
}
