/**
 * Delete a session's checkpoint refs from every repository its working
 * directory belongs to. Best-effort: a missing git or a directory that is not
 * a repository is not a reason to refuse deleting the transcript.
 *
 * TODO(M18-T1): replace the repository walk with the shared workspace resolver
 */
import { CHECKPOINT_REF_NAMESPACE } from "@lasercode/protocol";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

function sessionKey(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 32);
}

function git(cwd: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolveResult) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    delete env.GIT_INDEX_FILE;
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        env,
      },
      (error, stdout) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        if (!error) {
          resolveResult({ stdout: out, exitCode: 0 });
          return;
        }
        const errno = error as NodeJS.ErrnoException & { status?: unknown };
        const status = typeof errno.status === "number" ? errno.status : 1;
        resolveResult({ stdout: out, exitCode: status });
      },
    );
  });
}

async function repoRoots(cwd: string): Promise<string[]> {
  const root = resolve(cwd);
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode === 0 && top.stdout.trim()) return [resolve(top.stdout.trim())];
  // TODO(M18-T1): replace this body with the shared workspace resolver
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.slice(0, 256)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const child = await git(join(root, name), ["rev-parse", "--show-toplevel"]);
    if (child.exitCode === 0 && child.stdout.trim()) found.push(resolve(child.stdout.trim()));
    if (found.length >= 64) break;
  }
  return found;
}

export async function deleteSessionCheckpoints(cwd: string, sessionPath: string): Promise<number> {
  const prefix = `${CHECKPOINT_REF_NAMESPACE}/${sessionKey(sessionPath)}`;
  let removed = 0;
  for (const repo of await repoRoots(cwd)) {
    const listed = await git(repo, ["for-each-ref", "--format=%(refname)", prefix]);
    if (listed.exitCode !== 0) continue;
    const refs = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const ref of refs) {
      const deleted = await git(repo, ["update-ref", "-d", ref]);
      if (deleted.exitCode === 0) removed += 1;
    }
    if (refs.length > 0) await git(repo, ["pack-refs", `--include=${CHECKPOINT_REF_NAMESPACE}/**`]);
  }
  return removed;
}
