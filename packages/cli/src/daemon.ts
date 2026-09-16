/**
 * The host process the CLI supervises.
 *
 * `laser up` re-executes this file's entry (`laser __daemon`) detached, so
 * the long-lived process is a plain Node process the CLI can find by pid and
 * kill by pid — no shell wrapper, no orphaned npm script in between. Running it
 * in the foreground (`laser up --foreground`) is the same code path without
 * the detach, which is what you want when you are debugging the host.
 *
 * It refuses an existing record or busy port, then writes `<state-dir>/host.json`
 * immediately before binding and removes only its own record on the way out. The record
 * carries an identity for this process (see `processIdentity`) so a file left
 * behind by a crash or a power cut cannot be mistaken for a live host.
 */
import { ENV, PRODUCT_NAME, launchIdSchema } from "@lasercode/protocol";
import { fromBase64Url, isAuthorized } from "@lasercode/crypto";
import { join } from "node:path";
import {
  HostServer,
  RuntimeGenerationGuard,
  migrateFormerIdentities,
  readMigrationState,
  readRuntimeGenerationPointer,
  runtimeReferenceFromEnvironment,
  type HostRelayOptions,
  type RuntimeGenerationReference,
} from "@lasercode/host";
import { hostUrl, type LaserPaths } from "./config.js";
import { clearHostFile, inspectHost, portInUse, processIdentity, writeHostFile } from "./hostfile.js";
import { deviceListOf, loadIdentity, loadStaticKey, readRelayConfig } from "./relay-config.js";
import { CLI_VERSION } from "./version.js";
import { completeMigrationLaunch } from "./migration-activation.js";

export interface DaemonOptions {
  paths: LaserPaths;
  /** Where the host writes its own log lines. `process.stderr` when foreground. */
  log?: (line: string) => void;
  /** Test seam; production receives this exact reference through its launcher environment. */
  runtimeGeneration?: RuntimeGenerationReference;
}

/**
 * Outbound relay channels for the phones `laser relay pair` has linked
 * (M9-T7). Absent unless `relay.json` exists **and** names at least one
 * device: with no relay configured the host makes no outbound connection at
 * all, which is what makes laser a local app by default.
 *
 * `isAuthorized` re-reads nothing — it closes over the list this process
 * started with, and `laser relay revoke` tells the person to restart. That
 * is deliberate: a host that re-read a file on every reconnect would be a
 * second reader of state the CLI owns, and the failure mode (a revoked phone
 * reconnecting until the next restart) is stated where it happens instead of
 * being hidden behind a watcher.
 */
async function relayOptions(paths: LaserPaths, log: (line: string) => void): Promise<HostRelayOptions | undefined> {
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
  const launch = launchIdSchema.safeParse(process.env[ENV.hostLaunchId]);
  if (!launch.success) throw new Error("the host launcher did not provide a valid launch identity");
  const launchId = launch.data;
  const runtimeGeneration = options.runtimeGeneration ?? runtimeReferenceFromEnvironment(process.env);
  if (!runtimeGeneration) throw new Error("the host launcher did not bind a runtime generation");
  const migration = readMigrationState(paths.stateDir);
  if (migration && !(migration.phase === "migrated"
    && migration.targetGenerationId === runtimeGeneration.generationId
    && migration.launchAttemptId === launchId)) {
    throw new Error("data preparation is incomplete; restart through the launcher before starting the host");
  }
  const selected = readRuntimeGenerationPointer(paths.stateDir)?.active;
  const persisted = selected?.generationId === runtimeGeneration.generationId
    && selected.installRoot === runtimeGeneration.installRoot
    ? selected.verification
    : undefined;
  const runtimeManifest = new RuntimeGenerationGuard(runtimeGeneration, persisted).verify();
  // Refuse a competing launch before it can replace the record that makes the
  // live host adoptable and stoppable. The port guard closes the no-record race.
  const existing = await inspectHost(paths);
  if (existing.state !== "stopped") throw new Error(`${PRODUCT_NAME} host process ${existing.record.pid} is already running`);
  if (await portInUse(paths.host, paths.port)) throw new Error(`listen EADDRINUSE: address already in use ${paths.host}:${paths.port}`);

  const identity = processIdentity(process.pid);
  const startedAt = new Date().toISOString();
  const recordBase = {
    pid: process.pid,
    launchId,
    host: paths.host,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    startedAt,
    cliVersion: CLI_VERSION,
    generationId: runtimeGeneration.generationId,
    ...(identity !== undefined ? { identity } : {}),
  };

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
    launchId,
    runtimeGeneration,
    workerMain: join(runtimeGeneration.installRoot, runtimeManifest.entries.worker),
    ...(runtimeManifest.entries.node ? { nodeBinary: join(runtimeGeneration.installRoot, runtimeManifest.entries.node) } : {}),
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

  writeHostFile(paths.hostFile, {
    ...recordBase,
    state: "starting",
    port: paths.port,
    url: hostUrl(paths),
  });
  let listening: { url: string; port: number };
  try {
    listening = await server.listen();
  } catch (error) {
    // A failed launch may remove only the record it published. A competitor
    // that won the race keeps its own record intact.
    clearHostFile(paths.hostFile, launchId);
    throw error;
  }
  const { url, port } = listening;
  // The ready transition is one atomic replacement of this launch's record.
  writeHostFile(paths.hostFile, {
    ...recordBase,
    state: "ready",
    port,
    url,
  });
  try {
    completeMigrationLaunch(paths, {
      launchId,
      generationId: runtimeGeneration.generationId,
      version: CLI_VERSION,
    });
  } catch (error) {
    log(`migration verified-launch commit failed: ${error instanceof Error ? error.message : String(error)}`);
    await server.close({ initiator: "harness" });
    clearHostFile(paths.hostFile, launchId);
    throw error;
  }
  log(`${PRODUCT_NAME} host ready at ${url} (pid ${process.pid})`);
  process.stdout.write(`${url}\n`);

  let closing = false;
  const shutdown = async (reason: string, code: number, initiator: "user" | "harness"): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`${PRODUCT_NAME} host shutting down (${reason})`);
    try {
      await server.close({ initiator });
    } catch (error) {
      log(`${PRODUCT_NAME} host close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    clearHostFile(paths.hostFile, launchId);
    process.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal, 0, "user"));
  }
  process.on("uncaughtException", (error) => {
    log(`${PRODUCT_NAME} host crashed: ${error.stack ?? error.message}`);
    void shutdown("uncaughtException", 1, "harness");
  });
  process.on("unhandledRejection", (reason) => {
    log(`${PRODUCT_NAME} host unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
}
