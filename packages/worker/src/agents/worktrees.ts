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
import { execFile, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PROJECT_DIR_NAME, WORKTREES_DIR_NAME, type WorktreeEnvironment, type WorktreeSetup } from "@lasercode/protocol";
import { HarnessError } from "./errors.js";

export interface CreateWorktreeInput {
  /** The project the parent session belongs to (the git toplevel is resolved from it). */
  projectCwd: string;
  /** Host-resolved project trust; explicit false forbids automatic project code. */
  projectTrusted?: boolean;
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
  environment?: WorktreeEnvironment;
  setup?: WorktreeSetup;
}

/**
 * What a worktree still holds. `null` means git could not answer — never
 * "nothing": removing on an unknown is exactly the loss this guards against.
 */
export interface WorktreeFacts {
  exists: boolean;
  unmergedCommits: number | null;
  uncommittedFiles: number | null;
  detail?: string;
}

function readCount(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
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

/** git without throwing, for the questions whose answer may legitimately be "cannot tell". */
function gitQuiet(cwd: string, args: string[], timeout?: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 4 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      done({ ok: !error, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
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
      throw new HarnessError(
        "This project is not a git repository, so agents cannot get an isolated worktree. Either initialise git in the project, or start this agent with worktree false so it works in this checkout.",
      );
    }
    let baseCommit: string;
    try {
      baseCommit = (await git(input.baseCwd, ["rev-parse", "--verify", "HEAD"])).trim();
    } catch {
      throw new HarnessError(
        "This project has no commits yet, so agents cannot get an isolated worktree. Either make a first commit, or start this agent with worktree false so it works in this checkout.",
      );
    }
    const slug = worktreeSlug(input.subagentName, input.runId);
    const path = join(root, WORKTREES_DIR_NAME, slug);
    const branch = `agents/${slug}`;
    assertSafeWorktreePath(root, path);
    if (existsSync(path)) throw new HarnessError(`A worktree already exists at ${path}; another agent owns it. Choose another subagent_name for a new git worktree, or start this agent with worktree false so it works in this checkout.`);
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
    const projectRel = relative(root, resolve(input.projectCwd));
    const cwd = projectRel && !projectRel.startsWith("..") ? join(path, projectRel) : path;
    const worktree: Worktree = { path, branch, baseCommit, cwd: existsSync(cwd) ? cwd : path, root };
    worktree.environment = await observeEnvironment(input.baseCwd, worktree);
    worktree.setup = initialWorktreeSetup(input.projectCwd, path, input.projectTrusted);
    this.owned.set(input.runId, worktree);
    return worktree;
  }

  runSetup(projectCwd: string, tree: Worktree, signal: AbortSignal, projectTrusted?: boolean): Promise<WorktreeSetup> {
    return runWorktreeSetup(projectCwd, tree, signal, projectTrusted);
  }

  /** The worktree a run owns, when this process created it. */
  ownedBy(runId: string): Worktree | undefined {
    return this.owned.get(runId);
  }

  /** The git toplevel a project belongs to; `undefined` when it is not a repository. */
  async rootOf(projectCwd: string): Promise<string | undefined> {
    const found = await gitQuiet(projectCwd, ["rev-parse", "--show-toplevel"]);
    return found.ok ? found.stdout.trim() || undefined : undefined;
  }

  /**
   * What the worktree still holds, measured against the checkout the parent is
   * working in. Nothing here throws: "cannot tell" is `null`, and a caller that
   * cannot tell must refuse rather than promise the work is safe (M13-T42).
   */
  async facts(input: { path: string; branch: string; compareCwd: string }): Promise<WorktreeFacts> {
    if (!existsSync(input.path)) return { exists: false, unmergedCommits: 0, uncommittedFiles: 0 };
    const ahead = await gitQuiet(input.compareCwd, ["rev-list", "--count", `HEAD..${input.branch}`]);
    const changed = await gitQuiet(input.path, ["status", "--porcelain", "--untracked-files=all"]);
    const unmergedCommits = ahead.ok ? readCount(ahead.stdout) : null;
    const uncommittedFiles = changed.ok ? changed.stdout.split("\n").filter((line) => line.trim() !== "").length : null;
    const detail =
      unmergedCommits === null
        ? ahead.stderr.trim() || "git could not compare that branch with this checkout."
        : uncommittedFiles === null
          ? changed.stderr.trim() || "git could not read that worktree's changes."
          : undefined;
    return { exists: true, unmergedCommits, uncommittedFiles, ...(detail ? { detail } : {}) };
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
    const lines = [`/${WORKTREES_DIR_NAME}/`, `/${WORKTREE_SETUP_LOG}`];
    let current = "";
    try {
      current = readFileSync(excludePath, "utf8");
    } catch {
      current = "";
    }
    const missing = lines.filter((line) => !current.split(/\r?\n/).includes(line));
    if (!missing.length) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    writeFileSync(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
  }
}

const WORKTREE_SETUP_LOG = `${PROJECT_DIR_NAME}-worktree-setup.log`;

/** No stack inference: only directory names git reports, relative to the parent checkout. */
async function observeEnvironment(baseCwd: string, tree: Worktree): Promise<WorktreeEnvironment> {
  const environment: WorktreeEnvironment = { path: tree.path, branch: tree.branch, baseCommit: tree.baseCommit, parentCheckout: baseCwd, absentDirectories: [] };
  const root = await gitQuiet(baseCwd, ["rev-parse", "--show-toplevel"], 1_000);
  if (!root.ok) return environment;
  environment.parentCheckout = root.stdout.trim();
  const status = await gitQuiet(environment.parentCheckout, ["status", "--porcelain", "--ignored=matching", "--untracked-files=normal", "-z"], 4_000);
  if (!status.ok) return environment;
  const names = new Set<string>();
  const entries = status.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startsWith("R") || entry.startsWith("C") || entry[1] === "R" || entry[1] === "C") { i++; continue; }
    if (!entry.startsWith("?? ") && !entry.startsWith("!! ")) continue;
    const name = entry.slice(3).split("/")[0];
    if (!name || name === "." || name === "..") continue;
    try {
      if (statSync(join(environment.parentCheckout, name)).isDirectory() && !existsSync(join(tree.path, name))) names.add(`${name}/`);
    } catch { /* A directory can disappear while git runs. */ }
    if (names.size === 20) break;
  }
  environment.absentDirectories = [...names];
  return environment;
}

export function initialWorktreeSetup(projectCwd: string, path: string, projectTrusted = true): WorktreeSetup {
  if (!projectTrusted) return { status: "skipped-untrusted" };
  try {
    const hook = join(projectCwd, PROJECT_DIR_NAME, "worktree-setup");
    if (!statSync(hook).isFile()) return { status: "not-present" };
    accessSync(hook, constants.X_OK);
    return { status: "pending", logPath: join(path, WORKTREE_SETUP_LOG) };
  } catch { return { status: "not-present" }; }
}

/** Execute the project's program, never a guessed command. No environment values are logged. */
async function runWorktreeSetup(projectCwd: string, tree: Worktree, signal: AbortSignal, projectTrusted = true): Promise<WorktreeSetup> {
  if (!projectTrusted) return { status: "skipped-untrusted" };
  const initial = tree.setup ?? initialWorktreeSetup(projectCwd, tree.path, projectTrusted);
  if (initial.status !== "pending") return initial;
  const { logPath } = initial;
  if (signal.aborted) return { status: "cancelled", logPath };
  let fd: number;
  try { fd = openSync(logPath, "wx", 0o600); }
  catch { return { status: "failed", logPath, exitCode: null }; }
  return new Promise((done) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(join(projectCwd, PROJECT_DIR_NAME, "worktree-setup"), [], {
      cwd: tree.cwd, env: process.env,
      stdio: ["ignore", fd, fd], detached: process.platform !== "win32",
    });
    closeSync(fd);
    const finish = (outcome: WorktreeSetup) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      done(outcome);
    };
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    const cancel = () => { kill(); finish({ status: "cancelled", logPath }); };
    child.once("error", () => finish({ status: "failed", logPath, exitCode: null }));
    child.once("exit", (code) => {
      finish(code === 0 ? { status: "ok", logPath } : { status: "failed", logPath, exitCode: code });
    });
    timer = setTimeout(() => { kill(); finish({ status: "timed-out", logPath }); }, 600_000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
