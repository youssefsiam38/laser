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
import { ENV, PRODUCT_NAME } from "@piorbit/protocol";
import { fromBase64Url, isAuthorized } from "@piorbit/crypto";
import { HostServer, migrateFormerIdentities, type HostRelayOptions } from "@piorbit/host";
import type { PiorbitPaths } from "./config.js";
import { clearHostFile, processIdentity, writeHostFile } from "./hostfile.js";
import { deviceListOf, loadIdentity, loadStaticKey, readRelayConfig } from "./relay-config.js";
import { CLI_VERSION } from "./version.js";

export interface DaemonOptions {
  paths: PiorbitPaths;
  /** Where the host writes its own log lines. `process.stderr` when foreground. */
  log?: (line: string) => void;
}

/**
 * Outbound relay channels for the phones `piorbit relay pair` has linked
 * (M9-T7). Absent unless `relay.json` exists **and** names at least one
 * device: with no relay configured the host makes no outbound connection at
 * all, which is what makes piorbit a local app by default.
 *
 * `isAuthorized` re-reads nothing — it closes over the list this process
 * started with, and `piorbit relay revoke` tells the person to restart. That
 * is deliberate: a host that re-read a file on every reconnect would be a
 * second reader of state the CLI owns, and the failure mode (a revoked phone
 * reconnecting until the next restart) is stated where it happens instead of
 * being hidden behind a watcher.
 */
async function relayOptions(paths: PiorbitPaths, log: (line: string) => void): Promise<HostRelayOptions | undefined> {
  let config;
  try {
    config = readRelayConfig(paths);
  } catch (error) {
    log(`relay: ignoring the relay configuration — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!config?.deviceList) return undefined;

  try {
    const { identity } = await loadIdentity(paths);
    const list = deviceListOf(config, identity);
    if (list.devices.length === 0) return undefined;
    const { keyPair } = await loadStaticKey(paths);
    log(`relay: ${list.devices.length} linked device(s) on ${config.relayUrl}`);
    return {
      url: config.relayUrl,
      staticKeyPair: keyPair,
      devices: list.devices.map((device) => ({
        id: device.id,
        name: device.name,
        publicKey: fromBase64Url(device.publicKey),
      })),
      isAuthorized: (publicKey) => isAuthorized(list, publicKey),
      ...(config.publicOrigin !== undefined ? { publicOrigin: config.publicOrigin } : {}),
    };
  } catch (error) {
    log(`relay: not connecting — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { paths } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  // If this product was renamed, the person's sessions, settings and paired
  // devices are still under the old directory name. Move them before anything
  // opens a file (MX-T7, D-36). With no former names this does nothing.
  for (const line of migrateFormerIdentities().lines) log(line);

  const relay = await relayOptions(paths, log);

  const server = new HostServer({
    host: paths.host,
    port: paths.port,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    subagentsTempRoot: paths.subagentsTempRoot,
    // Extra browser origins allowed to open the WebSocket, comma separated.
    // The desktop shell sets this when the UI is served by a dev server: Vite
    // proxies the browser's own Origin through, and the host has never heard
    // of it. Absent in a packaged app, where the host serves the page itself.
    ...(process.env[ENV.allowedOrigins]
      ? {
          allowedOrigins: (process.env[ENV.allowedOrigins] ?? "")
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        }
      : {}),
    ...(relay ? { relay } : {}),
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
  log(`${PRODUCT_NAME} host ready at ${url} (pid ${process.pid})`);
  process.stdout.write(`${url}\n`);

  let closing = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`${PRODUCT_NAME} host shutting down (${reason})`);
    try {
      await server.close();
    } catch (error) {
      log(`${PRODUCT_NAME} host close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    clearHostFile(paths.hostFile);
    process.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal, 0));
  }
  process.on("uncaughtException", (error) => {
    log(`${PRODUCT_NAME} host crashed: ${error.stack ?? error.message}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`${PRODUCT_NAME} host unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
}
