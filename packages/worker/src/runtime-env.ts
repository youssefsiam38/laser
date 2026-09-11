/**
 * What a worker settles before anything else loads (M14-T2, docs/mcp.md).
 *
 * Its own module so importing it costs nothing and proves nothing about the
 * worker process: `main.ts` runs a worker the moment it is imported.
 */
import { delimiter, dirname, resolve } from "node:path";
import { ENV } from "@lasercode/protocol";

/**
 * The engine locates its own data directory from the environment, not from
 * the SDK's `agentDir` option — the MCP engine's caches and its OAuth state
 * are found that way (docs/mcp.md). Every product path already spawns the
 * worker with it set (`piEnv()` in `packages/cli/src/config.ts`); this makes
 * a worker started any other way agree with the directory it was given,
 * before anything in the process can read it.
 */
export function alignEngineAgentDir(agentDir: string | undefined): void {
  if (!agentDir) return;
  const resolved = resolve(agentDir);
  // The engine's own variable name, deliberately literal: the worker must not
  // import the CLI package, which is where it is otherwise spelled.
  if (process.env["PI_CODING_AGENT_DIR"] !== resolved) process.env["PI_CODING_AGENT_DIR"] = resolved;
}

/**
 * MCP servers are ordinary programs: `npx …`, `node …`, `npm exec …`. A
 * packaged app runs on its own bundled runtime with an empty `PATH`, so the
 * first `npx` resolution of a stdio server would fail on a clean machine.
 * Prepend the runtime's own bin directory and the bundled package manager's,
 * once, at worker start — and never remove anything the person's environment
 * already had.
 */
export function runtimePathAdditions(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string[] {
  const additions: string[] = [dirname(execPath)];
  const npmCli = env[ENV.npmCli];
  if (npmCli) additions.push(dirname(npmCli));
  try {
    const command: unknown = JSON.parse(env[ENV.npmCommand] ?? "null");
    if (Array.isArray(command)) {
      for (const part of command) if (typeof part === "string" && part.includes("/")) additions.push(dirname(part));
    }
  } catch {
    // A malformed value adds nothing; the runtime's own directory still does.
  }
  const existing = new Set((env["PATH"] ?? "").split(delimiter).filter(Boolean));
  return [...new Set(additions)].filter((entry) => entry && !existing.has(entry));
}

export function extendRuntimePath(): void {
  const additions = runtimePathAdditions();
  if (additions.length === 0) return;
  const current = process.env["PATH"] ?? "";
  process.env["PATH"] = current ? `${additions.join(delimiter)}${delimiter}${current}` : additions.join(delimiter);
}

