/**
 * Child worktrees (D-140: "worktrees are not optional for subagents").
 *
 * Every child agent works in `<git toplevel>/.worktrees/<slug>` on branch
 * `agents/<slug>`, checked out at the commit its parent is on, so two agents
 * never write into one checkout. The directory is excluded through
 * `<gitdir>/info/exclude` — never the person's `.gitignore`, which is theirs.
 *
 * Ownership is enforced here, not by prompt: a path is refused when it
 * exists, must be a strict child of `.worktrees/`, and is remembered per run.
 * Git is always spawned with an argument array; no shell string, ever.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { WORKTREES_DIR_NAME } from "@lasercode/protocol";
import { HarnessError } from "./errors.js";

export interface CreateWorktreeInput {
  /** The project the parent session belongs to (the git toplevel is resolved from it). */
  projectCwd: string;
  /** The parent's working directory: the child branches from the commit checked out there. */
  baseCwd: string;
  subagentName: string;
  runId: string;
}

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
  /** Where the child session runs: the project's cwd relative to the toplevel, inside the worktree. */
  cwd: string;
  root: string;
}

const SLUG_MAX = 60;

/** `<sanitized subagentName>-<runId without run_>`: lower case, `[a-z0-9-]`, ≤ 60. */
export function worktreeSlug(subagentName: string, runId: string): string {
  const suffix = runId.replace(/^run_/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const budget = Math.max(1, SLUG_MAX - suffix.length - 1);
  const name = subagentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, budget)
    .replace(/-+$/g, "");
  return `${name || "agent"}-${suffix}`;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.toString().trim() || error.message));
          return;
        }
        resolvePromise(stdout.toString());
      },
    );
  });
}

/** The worktree must be a strict child of `<root>/.worktrees`, never the root or outside it. */
export function assertSafeWorktreePath(root: string, path: string): void {
  const base = resolve(root, WORKTREES_DIR_NAME);
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || rel.includes(sep) || resolve(base, rel) !== target) {
    throw new HarnessError(`Refusing to touch ${target}: agents only work inside ${base}.`);
  }
}

export class WorktreeManager {
  /** runId → worktree path, so a run can only remove what it created. */
  private readonly owned = new Map<string, Worktree>();

  async create(input: CreateWorktreeInput): Promise<Worktree> {
    let root: string;
    try {
      root = (await git(input.projectCwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      throw new HarnessError("This project is not a git repository, so agents cannot get an isolated worktree. Initialise git in the project first.");
    }
    let baseCommit: string;
    try {
      baseCommit = (await git(input.baseCwd, ["rev-parse", "--verify", "HEAD"])).trim();
    } catch {
      throw new HarnessError("This project has no commits yet, so agents cannot get an isolated worktree. Make a first commit, then start the agent again.");
    }
    const slug = worktreeSlug(input.subagentName, input.runId);
    const path = join(root, WORKTREES_DIR_NAME, slug);
    const branch = `agents/${slug}`;
    assertSafeWorktreePath(root, path);
    if (existsSync(path)) throw new HarnessError(`A worktree already exists at ${path}; another agent owns it.`);
    if (this.owned.has(input.runId)) throw new HarnessError(`Run ${input.runId} already owns a worktree.`);

    await this.ensureExcluded(root);
    mkdirSync(join(root, WORKTREES_DIR_NAME), { recursive: true });
    try {
      await git(root, ["worktree", "add", path, "-b", branch, baseCommit]);
    } catch (error) {
      throw new HarnessError(`Could not create the agent's worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    if (head !== baseCommit) {
      await this.removeAt(root, path, branch);
      throw new HarnessError("The new worktree is not at the parent's commit; refusing to hand it to an agent.");
    }
    linkNodeModules(input.baseCwd, path, root);
    const projectRel = relative(root, resolve(input.projectCwd));
    const cwd = projectRel && !projectRel.startsWith("..") ? join(path, projectRel) : path;
    const worktree: Worktree = { path, branch, baseCommit, cwd: existsSync(cwd) ? cwd : path, root };
    this.owned.set(input.runId, worktree);
    return worktree;
  }

  /** The worktree a run owns, when this process created it. */
  ownedBy(runId: string): Worktree | undefined {
    return this.owned.get(runId);
  }

  /** Best effort: `worktree remove --force`, delete the branch, prune. Only for paths this process owns or that pass the safety check. */
  async remove(root: string, path: string, branch?: string): Promise<void> {
    assertSafeWorktreePath(root, path);
    await this.removeAt(root, path, branch);
    for (const [runId, worktree] of this.owned) if (worktree.path === path) this.owned.delete(runId);
  }

  private async removeAt(root: string, path: string, branch: string | undefined): Promise<void> {
    await git(root, ["worktree", "remove", "--force", path]).catch(() => undefined);
    if (branch) await git(root, ["branch", "-D", branch]).catch(() => undefined);
    await git(root, ["worktree", "prune"]).catch(() => undefined);
  }

  /** List `.worktrees/` in `<gitdir>/info/exclude` once; never in the person's `.gitignore`. */
  private async ensureExcluded(root: string): Promise<void> {
    let gitDir: string;
    try {
      gitDir = resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim());
    } catch {
      return;
    }
    const excludePath = join(gitDir, "info", "exclude");
    const line = `/${WORKTREES_DIR_NAME}/`;
    let current = "";
    try {
      current = readFileSync(excludePath, "utf8");
    } catch {
      current = "";
    }
    if (current.split(/\r?\n/).some((entry) => entry.trim() === line || entry.trim() === `${WORKTREES_DIR_NAME}/` || entry.trim() === WORKTREES_DIR_NAME)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    writeFileSync(excludePath, `${prefix}${line}\n`, "utf8");
  }
}

/** Symlink the base checkout's `node_modules` into the worktree when present and absent there. Best effort. */
function linkNodeModules(baseCwd: string, worktreePath: string, root: string): void {
  try {
    const source = join(baseCwd, "node_modules");
    if (!existsSync(source)) return;
    const rel = relative(root, resolve(baseCwd));
    const targetDir = rel && !rel.startsWith("..") && !rel.startsWith(WORKTREES_DIR_NAME) ? join(worktreePath, rel) : worktreePath;
    const target = join(targetDir, "node_modules");
    if (!existsSync(targetDir)) return;
    try {
      lstatSync(target);
      return; // already there (checked in, or a previous link)
    } catch {
      // absent: link it
    }
    symlinkSync(source, target, "dir");
  } catch {
    // Best effort only: a missing link costs an install, never a run.
  }
}
