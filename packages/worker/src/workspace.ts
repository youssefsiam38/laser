/**
 * Node-backed workspace IO for the worker. The resolver itself lives in
 * `@lasercode/protocol` and stays process-free; this is the `execFile` runner
 * the worker injects, with `GIT_OPTIONAL_LOCKS=0` and never `GIT_INDEX_FILE`.
 */
import { execFile } from "node:child_process";
import { readdir, access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { WorkspaceResolver, type WorkspaceIO } from "@lasercode/protocol";

export function nodeWorkspaceIO(): WorkspaceIO {
  return {
    run(args, cwd) {
      return new Promise((done) => {
        execFile(
          "git",
          [...args],
          {
            cwd,
            timeout: 8000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          },
          (error, stdout, stderr) => {
            done({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      return entries.map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        isDirectory: entry.isDirectory(),
      }));
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    join,
    resolve,
    dirname,
    basename,
  };
}

export function createWorkspaceResolver(): WorkspaceResolver {
  return new WorkspaceResolver(nodeWorkspaceIO());
}
