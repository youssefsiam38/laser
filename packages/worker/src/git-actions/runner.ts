/**
 * Process and HTTP seams for git actions.
 *
 * Git goes through the canonical `runGit` / `gitEnv` (source-control leap).
 * Other executables (`gh`) use `execFile` with the same scrubbed env. User
 * text is always one argv element.
 */
import { execFile } from "node:child_process";
import { REDACTED } from "@lasercode/protocol";
import { gitEnv, runGit } from "../source-control/git-run.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  /** False when the executable was not on PATH. */
  spawned: boolean;
  /** True when the process was killed by our timeout. */
  timedOut: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type ProcessRunner = (command: string, args: readonly string[], options: ProcessRunOptions) => Promise<ProcessResult>;

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type GitActionsFetcher = (request: HttpRequest) => Promise<HttpResponse>;

const NETWORK = /could not resolve|failed to connect|unable to access|tls handshake|ssl|timed out|timeout|network is unreachable|connection reset|temporarily unavailable|502 bad gateway|503 service|504 gateway|ENOTFOUND|ECONNRESET|EAI_AGAIN|remote hung up|early eof|http\/2/i;

const SECRET_SHAPE =
  /\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|ATATT[A-Za-z0-9=_-]{8,}|ATCTT[A-Za-z0-9=_-]{8,}|Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]{8,})\b/gi;

/** Git-actions never restore capture/index redirection, even via overlay extra. */
const SCRUB = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

export const HTTP_TIMEOUT_MS = 30_000;

function overlayEnv(base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const overlay: Record<string, string | undefined> = { ...base, ...extra };
  for (const key of SCRUB) delete overlay[key];
  return overlay;
}

export function actionGitEnv(base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = gitEnv(overlayEnv(base, extra));
  for (const key of SCRUB) delete env[key];
  return env;
}

/** Strip credential-shaped tokens from text that might reach a result or log. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_SHAPE, REDACTED);
}

export function looksUncertain(result: ProcessResult): boolean {
  if (result.timedOut) return true;
  if (!result.spawned || result.code === 0) return false;
  return NETWORK.test(result.stderr) || NETWORK.test(result.stdout);
}

export function combinedOutput(result: ProcessResult): string {
  return redactSecrets(`${result.stderr}\n${result.stdout}`.trim());
}

/** One person-facing sentence from process output. Always redacted. */
export function personFacingMessage(output: string, fallback: string): string {
  const line = redactSecrets(output)
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("hint:"));
  if (!line || line.length > 240) return fallback;
  return line;
}

async function runGitAsProcess(
  args: readonly string[],
  options: ProcessRunOptions,
  extra?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  try {
    const result = await runGit({
      cwd: options.cwd,
      args,
      timeoutMs: options.timeoutMs ?? 30_000,
      env: overlayEnv(extra, options.env),
    });
    return {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      spawned: true,
      // runGit does not currently surface killed/ETIMEDOUT; treat as not timed out.
      timedOut: false,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "git is not installed") {
      return { code: 127, stdout: "", stderr: "", spawned: false, timedOut: false };
    }
    throw error;
  }
}

/**
 * Default runner. Git uses `runGit`; everything else is `execFile` with an
 * argument array and `gitEnv`. Never `exec`, never a shell.
 */
export function createProcessRunner(baseEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env): ProcessRunner {
  return (command, args, options) => {
    const base = typeof baseEnv === "function" ? baseEnv() : baseEnv;
    if (command === "git") return runGitAsProcess(args, options, base);
    return new Promise((resolve) => {
      const env = actionGitEnv(base, options.env);
      env.GIT_OPTIONAL_LOCKS = "0";
      env.GIT_TERMINAL_PROMPT = "0";
      env.LC_ALL = "C";
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: 8 * 1024 * 1024,
          env,
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
          const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
          if (!error) {
            resolve({ code: 0, stdout: out, stderr: err, spawned: true, timedOut: false });
            return;
          }
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === "ENOENT") {
            resolve({ code: 127, stdout: out, stderr: err, spawned: false, timedOut: false });
            return;
          }
          const timedOut = Boolean(e.killed) || e.code === "ETIMEDOUT";
          const code = typeof e.code === "number" ? e.code : 1;
          resolve({ code, stdout: out, stderr: err, spawned: true, timedOut });
        },
      );
    });
  };
}

export function createFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = HTTP_TIMEOUT_MS): GitActionsFetcher {
  return async (request) => {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await fetchImpl(request.url, init);
    return { status: response.status, text: await response.text() };
  };
}
