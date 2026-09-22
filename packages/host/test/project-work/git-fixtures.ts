/**
 * Real git, for tests that are about real git (M21-T18, M21-T19).
 *
 * Every helper here runs the same commands the product does, in a temp
 * directory, with no shell and no mocks: the rules under test — that a
 * checkpoint ref resolves to a commit object id, that a diff is what git says
 * it is, and that a pruned object stays gone — are exactly the ones a mock
 * would assume away.
 *
 * Not a test file.
 */
import { PRODUCT_NAME, checkpointRef } from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Is there a git to run at all? Every suite here is skipped without one. */
export const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

/** Write files, making the directories they need. Bytes when given bytes. */
export function write(dir: string, contents: Record<string, string | Buffer>): void {
  for (const [name, body] of Object.entries(contents)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

export function initRepo(dir: string, contents: Record<string, string | Buffer>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, contents);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

/** An ordinary commit of the work tree: a **parented** commit, unlike a checkpoint. */
export function commit(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return head(dir);
}

/**
 * One checkpoint, exactly as the worker writes one: a commit object built
 * through an isolated index and published under
 * `refs/<product>/checkpoints/<session>/<turn>`, touching nothing a person
 * can see (`docs/source-control-leap.md` §E.1).
 */
export function checkpoint(repo: string, sessionPath: string, turn: number): string {
  // Asked of git rather than assumed: in a linked worktree `.git` is a file,
  // and the private directory an isolated index has to live in is elsewhere.
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]).trim();
  const indexFile = join(gitDir, `${PRODUCT_NAME}-test-index-${String(turn)}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  const tree = execFileSync("git", ["write-tree"], { cwd: repo, env }).toString().trim();
  const made = execFileSync("git", ["commit-tree", tree, "-m", `checkpoint turn=${String(turn)}`], { cwd: repo, env })
    .toString()
    .trim();
  rmSync(indexFile, { force: true });
  git(repo, ["update-ref", checkpointRef(checkpointSessionKey(sessionPath), turn), made]);
  return made;
}

export function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/** Make an object unreachable for real: drop every ref to it, then prune. */
export function prune(repo: string, refs: string[]): void {
  for (const ref of refs) git(repo, ["update-ref", "-d", ref]);
  git(repo, ["reflog", "expire", "--expire=now", "--all"]);
  git(repo, ["gc", "--prune=now", "--quiet"]);
}
