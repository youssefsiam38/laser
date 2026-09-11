/**
 * What a worker settles before anything else loads (M14-T2, docs/mcp.md).
 *
 * Its own module so importing it costs nothing and proves nothing about the
 * worker process: `main.ts` runs a worker the moment it is imported.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { ENV } from "@lasercode/protocol";

/**
 * The engine locates its own data directory from the environment, not from
 * the SDK's `agentDir` option — the MCP engine's caches and its OAuth state
 * are found that way (docs/mcp.md). Every product path already spawns the
 * worker with it set (`piEnv()` in `packages/cli/src/config.ts`); this makes
 * a worker started any other way agree with the directory it was given,
 * before anything in the process can read it.
 */
export function alignEngineAgentDir(agentDir: string | undefined, sessionDir?: string): void {
  if (!agentDir) return;
  const resolved = resolve(agentDir);
  // The engine's own variable names, deliberately literal: the worker must not
  // import the CLI package, which is where they are otherwise spelled
  // (`PI_AGENT_DIR_ENV` / `PI_SESSION_DIR_ENV` in `packages/cli/src/config.ts`).
  if (process.env["PI_CODING_AGENT_DIR"] !== resolved) process.env["PI_CODING_AGENT_DIR"] = resolved;
  // The session directory follows the same rule. An inherited one — a shell
  // started from inside the app carries both — would otherwise point a worker
  // at another installation's sessions while its host watches these.
  if (sessionDir) {
    const resolvedSessions = resolve(sessionDir);
    if (process.env["PI_CODING_AGENT_SESSION_DIR"] !== resolvedSessions) process.env["PI_CODING_AGENT_SESSION_DIR"] = resolvedSessions;
  } else {
    delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  }
}

/**
 * MCP servers are ordinary programs: `npx …`, `node …`, `npm exec …`. A
 * packaged app runs on its own bundled runtime with an empty `PATH`, so the
 * first `npx` resolution of a stdio server would fail on a clean machine.
 * Keep the runtime first, followed by our launchers when the bundle has no
 * npx executable. Never expose npm's internal bin directory: its shell shims
 * assume a stock Node layout, which a packaged runtime does not have.
 */
export function runtimePathAdditions(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string[] {
  const runtime = dirname(execPath);
  const additions = [runtime];
  let npmCli = env[ENV.npmCli];
  if (!npmCli) {
    try {
      const command: unknown = JSON.parse(env[ENV.npmCommand] ?? "null");
      if (Array.isArray(command)) npmCli = command.find((part): part is string => typeof part === "string" && /[/\\\\]npm-cli\.js$/.test(part));
    } catch { /* A malformed command adds nothing. */ }
  }
  const agentDir = env["PI_CODING_AGENT_DIR"];
  const suffix = process.platform === "win32" ? ".cmd" : "";
  if (agentDir && npmCli && existsSync(npmCli) && !existsSync(join(runtime, `npx${suffix}`))) {
    const bin = join(agentDir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["npm", "npx"]) {
      const path = join(bin, `${name}${suffix}`);
      const content = runtimeLauncher(execPath, join(dirname(npmCli), `${name}-cli.js`));
      let previous: string | undefined;
      try { previous = readFileSync(path, "utf8"); } catch { /* First startup. */ }
      if (previous !== content) {
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, content, { mode: 0o755 });
        renameSync(temp, path);
      }
      chmodSync(path, 0o755);
    }
    additions.push(bin);
  }
  // An already-present directory later in PATH still needs to move in front
  // of competing commands. Retain the original PATH verbatim, even duplicates.
  const current = (env["PATH"] ?? "").split(delimiter);
  return additions.every((entry, index) => current[index] === entry) ? [] : additions;
}

/** Literal paths, not shell interpolation; arguments pass through unchanged. */
export function runtimeLauncher(execPath: string, cli: string, platform = process.platform): string {
  if (platform === "win32") {
    const quote = (path: string) => `"${path.replace(/%/g, "%%")}"`;
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(execPath)} ${quote(cli)} %*\r\n`;
  }
  const quote = (path: string) => `'${path.replace(/'/g, `'"'"'`)}'`;
  return `#!/bin/sh\nexec ${quote(execPath)} ${quote(cli)} "$@"\n`;
}

export function extendRuntimePath(): void {
  const additions = runtimePathAdditions();
  if (additions.length === 0) return;
  const current = process.env["PATH"] ?? "";
  process.env["PATH"] = current ? `${additions.join(delimiter)}${delimiter}${current}` : additions.join(delimiter);
}

