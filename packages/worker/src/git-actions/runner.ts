/**
 * Process and HTTP seams for git actions.
 *
 * Every executable is spawned with an argument array. User text never becomes
 * part of a shell string. `GIT_INDEX_FILE` is stripped so a capture from
 * another leap cannot leak into these commands.
 */
import { execFile } from "node:child_process";

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

/** Strip credential-shaped tokens from text that might reach a result or log. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_SHAPE, "[redacted]");
}

export function looksUncertain(result: ProcessResult): boolean {
  if (result.timedOut) return true;
  if (!result.spawned || result.code === 0) return false;
  return NETWORK.test(result.stderr) || NETWORK.test(result.stdout);
}

export function combinedOutput(result: ProcessResult): string {
  return redactSecrets(`${result.stderr}\n${result.stdout}`.trim());
}

/**
 * Default runner. `execFile` with an argument array; never `exec`, never a
 * shell. Callers that inject a runner in tests must keep that contract.
 */
export function createProcessRunner(baseEnv: NodeJS.ProcessEnv = process.env): ProcessRunner {
  return (command, args, options) =>
    new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...(options.env ?? {}),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      };
      delete env.GIT_INDEX_FILE;
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
}

export function createFetcher(fetchImpl: typeof fetch = fetch): GitActionsFetcher {
  return async (request) => {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await fetchImpl(request.url, init);
    return { status: response.status, text: await response.text() };
  };
}
