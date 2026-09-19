/**
 * Spawn git with an argument array. Env is per command: inherited `GIT_INDEX_FILE`
 * is scrubbed unless this call sets it, and nothing is exported onto `process.env`.
 */
import { execFile } from "node:child_process";

const SCRUB = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

export function gitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const key of SCRUB) delete env[key];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

export interface GitRunOptions {
  cwd: string;
  args: readonly string[];
  /** Extra env for this process only. `GIT_INDEX_FILE` belongs here, never on `process.env`. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runGit(options: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...options.args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        env: gitEnv(options.env),
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (!error) {
          resolve({ stdout: out, stderr: err, exitCode: 0 });
          return;
        }
        const errno = error as NodeJS.ErrnoException & { status?: unknown };
        if (errno.code === "ENOENT") {
          reject(new Error("git is not installed"));
          return;
        }
        const exit = typeof errno.status === "number" ? errno.status : typeof errno.code === "number" ? errno.code : 1;
        resolve({ stdout: out, stderr: err, exitCode: exit });
      },
    );
  });
}
