/**
 * The host process the CLI supervises.
 *
 * `piorbit up` re-executes this file's entry (`piorbit __daemon`) detached, so
 * the long-lived process is a plain Node process the CLI can find by pid and
 * kill by pid — no shell wrapper, no orphaned npm script in between. Running it
 * in the foreground (`piorbit up --foreground`) is the same code path without
 * the detach, which is what you want when you are debugging the host.
 *
 * It writes `<state-dir>/host.json` after the port is bound and removes it on
 * the way out, so the file is only ever present while a host is up. The record
 * carries an identity for this process (see `processIdentity`) so a file left
 * behind by a crash or a power cut cannot be mistaken for a live host.
 */
import { HostServer } from "@piorbit/host";
import type { PiorbitPaths } from "./config.js";
import { clearHostFile, processIdentity, writeHostFile } from "./hostfile.js";
import { CLI_VERSION } from "./version.js";

export interface DaemonOptions {
  paths: PiorbitPaths;
  /** Where the host writes its own log lines. `process.stderr` when foreground. */
  log?: (line: string) => void;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { paths } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const server = new HostServer({
    host: paths.host,
    port: paths.port,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    subagentsTempRoot: paths.subagentsTempRoot,
    log,
  });

  const { url, port } = await server.listen();
  // Recorded so `piorbit down` can prove this pid is still us before signalling.
  const identity = processIdentity(process.pid);
  writeHostFile(paths.hostFile, {
    pid: process.pid,
    host: paths.host,
    port,
    url,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    subagentsTempRoot: paths.subagentsTempRoot,
    startedAt: new Date().toISOString(),
    cliVersion: CLI_VERSION,
    ...(identity !== undefined ? { identity } : {}),
  });
  log(`piorbit host ready at ${url} (pid ${process.pid})`);
  process.stdout.write(`${url}\n`);

  let closing = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`piorbit host shutting down (${reason})`);
    try {
      await server.close();
    } catch (error) {
      log(`piorbit host close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    clearHostFile(paths.hostFile);
    process.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal, 0));
  }
  process.on("uncaughtException", (error) => {
    log(`piorbit host crashed: ${error.stack ?? error.message}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`piorbit host unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
}
