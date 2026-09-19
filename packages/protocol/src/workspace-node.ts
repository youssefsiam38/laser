/**
 * Node-backed workspace IO, kept off the package barrel.
 *
 * The UI bundles `@lasercode/protocol` into the browser, so `node:child_process`
 * must never be reachable from `index.ts`. Host and worker import this
 * subpath (`@lasercode/protocol/workspace-node`) and share one runner:
 * `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and never `GIT_INDEX_FILE`.
 */
import { execFile } from "node:child_process";
import { readdir, access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { WorkspaceResolver, type WorkspaceIO } from "./workspace.js";

export function nodeWorkspaceIO(): WorkspaceIO {
  return {
    run(args, cwd) {
      return new Promise((done) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        };
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
