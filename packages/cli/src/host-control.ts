/**
 * Host lifecycle: start it, wait for it to actually answer, stop it politely,
 * and open a browser at it.
 *
 * Starting twice is not an error. `laser up` on a machine that already has a
 * host attaches to it and prints the URL, which is what a person means when
 * they type it a second time.
 */
import { ENV, PRODUCT_NAME, environmentOverlay, nodeLaunchEnvironment } from "@lasercode/protocol";
import {
  MIGRATION_REGISTRY,
  MigrationEngine,
  UpdateTransactionStore,
  hostOldSpaceMiB,
  oldSpaceSizeFlag,
  prepareRuntimeGeneration,
  readMigrationState,
  runtimeUpdateId,
  stageRuntimeGeneration,
  type RuntimeGenerationManifest,
  type RuntimeGenerationReference,
} from "@lasercode/host";
import { HostRpc, HostRpcError } from "./rpc.js";
import {
  MigrationActivationError,
  completeMigrationLaunch,
  ensureUpdateTransaction,
  prepareUpdateData,
  recoverUpdateData,
  type MigrationEventSink,
} from "./migration-activation.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaserPaths } from "./config.js";
import { hostUrl } from "./config.js";
import { CliError, ExitCode } from "./errors.js";
import {
  clearHostFile,
  inspectHost,
  isProcessAlive,
  isRecordedProcess,
  portInUse,
  probeHealth,
  type HostRecord,
} from "./hostfile.js";

/**
 * Absolute path to this CLI's entry, for re-executing ourselves as the host.
 *
 * Inside a packaged Electron app this module resolves under `app.asar`, which
 * is an archive rather than a directory: the bundled stock Node that runs the
 * daemon (`@lasercode/desktop` `runtime.ts` — deliberately a plain node with no
 * asar patch) cannot open a path inside it, and the spawn dies immediately
 * with "cannot find module". electron-builder writes a second, real copy of
 * the dependency tree to `app.asar.unpacked` (`asarUnpack: node_modules/**`),
 * so that is the path to hand to `spawn`.
 *
 * `existsSync` cannot catch this from the Electron main process: its `fs` is
 * asar-aware and answers `true` for the archive path, which is why the rewrite
 * happens here, once, at the only place the path is produced.
 */
export function cliEntry(): string {
  return unpacked(fileURLToPath(new URL("./main.js", import.meta.url)));
}

/** `…/app.asar/x` → `…/app.asar.unpacked/x`; anything else is returned as it came. */
export function unpacked(file: string): string {
  const marker = `${sep}app.asar${sep}`;
  return file.includes(marker) ? file.replace(marker, `${sep}app.asar.unpacked${sep}`) : file;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export { nodeLaunchEnvironment };

/** Minted by the launcher, before the host process exists. */
export function newLaunchId(): string {
  return randomBytes(16).toString("hex");
}

/** Node argv for every CLI-owned host generation: flag, then script. */
export function hostDaemonArgv(paths: LaserPaths, capacityBytes?: number, entry = cliEntry()): string[] {
  return [oldSpaceSizeFlag(hostOldSpaceMiB(capacityBytes)), entry, "__daemon", ...daemonArgs(paths)];
}

export interface InstalledRuntimeLaunch {
  reference: RuntimeGenerationReference;
  manifest: RuntimeGenerationManifest;
  nodeBinary: string;
  cliEntry: string;
  workerEntry: string;
  env: Readonly<Record<string, string>>;
  migrationUpdateId?: string;
}

/** Resolve, recover, migrate and canonically select the install-root generation before host bind. */
export function prepareInstalledRuntime(
  paths: LaserPaths,
  currentEntry = cliEntry(),
  options: { onMigrationEvent?: MigrationEventSink } = {},
): InstalledRuntimeLaunch {
  const preexistingMarker = readMigrationState(paths.stateDir);
  let staged: ReturnType<typeof stageRuntimeGeneration>;
  try {
    staged = stageRuntimeGeneration(paths.stateDir, currentEntry);
  } catch (error) {
    if (preexistingMarker?.phase === "migrated") {
      recoverUpdateData(paths, {
        updateId: preexistingMarker.updateId,
        targetGenerationId: preexistingMarker.targetGenerationId,
        targetVerified: false,
      }, options.onMigrationEvent);
      throw new MigrationActivationError(preexistingMarker.updateId, "restored", undefined, { cause: error });
    }
    throw error;
  }

  const engine = new MigrationEngine({
    roots: { stateDir: paths.stateDir, agentDir: paths.agentDir, sessionDir: paths.sessionDir },
    registry: MIGRATION_REGISTRY,
  });
  let marker = engine.currentState();
  const store = new UpdateTransactionStore(paths.stateDir);
  const currentUpdateId = runtimeUpdateId(staged.manifest);
  const existing = store.read(currentUpdateId);
  let migrationUpdateId: string | undefined;

  if (marker) {
    migrationUpdateId = marker.updateId;
    if (marker.targetGenerationId !== staged.current.generationId || (marker.phase === "migrated" && marker.launchAttemptId)) {
      recoverUpdateData(paths, {
        updateId: marker.updateId,
        targetGenerationId: marker.targetGenerationId,
        targetVerified: false,
      }, options.onMigrationEvent);
      throw new MigrationActivationError(marker.updateId, "restored");
    }
    if (marker.phase !== "migrated") {
      const recovered = recoverUpdateData(paths, {
        updateId: marker.updateId,
        targetGenerationId: marker.targetGenerationId,
        targetVerified: true,
      }, options.onMigrationEvent);
      if (recovered === "restored") throw new MigrationActivationError(marker.updateId, "restored");
      marker = engine.currentState();
    }
  }

  const selectionChanged = staged.pointer.active.generationId !== staged.current.generationId
    || staged.pointer.active.installRoot !== staged.current.installRoot;
  if (!marker && (selectionChanged || engine.needsMigration())) {
    migrationUpdateId = existing ? currentUpdateId : ensureUpdateTransaction(paths, staged.manifest);
    prepareUpdateData(paths, { updateId: migrationUpdateId, targetGenerationId: staged.current.generationId }, options.onMigrationEvent);
    marker = engine.currentState();
  } else if (!migrationUpdateId && (existing?.phase === "restarting" || existing?.phase === "succeeded")) {
    migrationUpdateId = currentUpdateId;
  }

  // This is the one selection authority; it includes install-root moves as well
  // as generation changes and runs only after migration/recovery has settled.
  const selected = prepareRuntimeGeneration(paths.stateDir, currentEntry);
  if (migrationUpdateId) {
    let transaction = store.read(migrationUpdateId);
    if (transaction?.phase === "ready") {
      transaction = store.transition(migrationUpdateId, "selected");
      store.transition(migrationUpdateId, "restarting");
    }
    if (transaction?.phase !== "selected" && transaction?.phase !== "restarting" && transaction?.phase !== "succeeded") {
      throw new MigrationActivationError(migrationUpdateId, marker?.snapshotDigest ? "available" : "none");
    }
  }

  const reference = selected.pointer.active;
  return {
    reference,
    manifest: selected.manifest,
    nodeBinary: selected.manifest.entries.node ? join(reference.installRoot, selected.manifest.entries.node) : process.execPath,
    cliEntry: join(reference.installRoot, selected.manifest.entries.cli),
    workerEntry: join(reference.installRoot, selected.manifest.entries.worker),
    env: {
      [ENV.runtimeGenerationId]: reference.generationId,
      [ENV.runtimeInstallRoot]: reference.installRoot,
      [ENV.runtimeManifestDigest]: reference.manifestDigest,
    },
    ...(migrationUpdateId ? { migrationUpdateId } : {}),
  };
}

export function markInstalledMigrationLaunch(paths: LaserPaths, installed: InstalledRuntimeLaunch, launchId: string): void {
  if (!installed.migrationUpdateId) return;
  const engine = new MigrationEngine({
    roots: { stateDir: paths.stateDir, agentDir: paths.agentDir, sessionDir: paths.sessionDir }, registry: MIGRATION_REGISTRY,
  });
  const marker = engine.currentState();
  if (marker?.phase === "migrated" && marker.targetGenerationId === installed.reference.generationId) {
    engine.markLaunchAttempt(installed.migrationUpdateId, launchId);
  }
}

/** Commit success only after the exact launched generation and version answer health. */
export function completeInstalledMigration(
  paths: LaserPaths,
  installed: InstalledRuntimeLaunch,
  record: Pick<HostRecord, "launchId" | "generationId" | "cliVersion">,
): boolean {
  if (!installed.migrationUpdateId
    || record.generationId !== installed.reference.generationId
    || record.cliVersion !== installed.manifest.productVersion) return false;
  return completeMigrationLaunch(paths, {
    updateId: installed.migrationUpdateId,
    launchId: record.launchId,
    generationId: record.generationId,
    version: record.cliVersion,
  });
}

export interface ForegroundHostResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ForegroundSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Re-exec because an already-created V8 isolate cannot acquire a heap flag. */
export async function runForegroundHost(
  paths: LaserPaths,
  options: {
    nodeBinary?: string;
    entry?: string;
    capacityBytes?: number;
    env?: NodeJS.ProcessEnv;
    /** Test seam; production forwards signals from this process. */
    signalSource?: ForegroundSignalSource;
  } = {},
): Promise<ForegroundHostResult> {
  mkdirSync(paths.stateDir, { recursive: true });
  const launchId = newLaunchId();
  const installed = options.entry ? undefined : prepareInstalledRuntime(paths, cliEntry(), {
    onMigrationEvent: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  if (installed) markInstalledMigrationLaunch(paths, installed, launchId);
  const child = spawn(
    options.nodeBinary ?? installed?.nodeBinary ?? process.execPath,
    hostDaemonArgv(paths, options.capacityBytes, options.entry ?? installed?.cliEntry ?? cliEntry()),
    {
      stdio: "inherit",
      env: {
        ...nodeLaunchEnvironment(options.env ?? process.env),
        ...installed?.env,
        [ENV.hostLaunchId]: launchId,
      },
      cwd: paths.stateDir,
    },
  );
  return new Promise<ForegroundHostResult>((resolve, reject) => {
    const signals = options.signalSource ?? process;
    const forwardSigint = () => { if (child.exitCode === null) child.kill("SIGINT"); };
    const forwardSigterm = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
    const cleanup = () => {
      signals.off("SIGINT", forwardSigint);
      signals.off("SIGTERM", forwardSigterm);
    };
    signals.on("SIGINT", forwardSigint);
    signals.on("SIGTERM", forwardSigterm);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

export interface StartResult {
  record: HostRecord;
  /** False when a host was already up and we simply attached to it. */
  started: boolean;
}

/**
 * Start a host, or attach to the one that is already there.
 *
 * The wait loop polls `/healthz` rather than trusting the spawn to have worked:
 * a host that dies on startup (port taken, bad agent dir, broken build) must
 * produce the log tail, not a hang.
 */
export async function startHost(
  paths: LaserPaths,
  timeoutMs = 30_000,
  dependencies: { spawnProcess?: typeof spawn } = {},
): Promise<StartResult> {
  const existing = await inspectHost(paths);
  if (existing.state === "running") {
    await refreshHostEnvironment(existing.record);
    return { record: existing.record, started: false };
  }
  if (existing.state === "unreachable") {
    throw new CliError(`a ${PRODUCT_NAME} host is recorded as running but is not answering`, {
      details: [existing.reason],
      fix:
        `Stop it with \`${PRODUCT_NAME} down\`, then run \`${PRODUCT_NAME} up\` again. ` +
        `If ${PRODUCT_NAME} refuses to signal it, check \`ps -p ${existing.record.pid} -o pid,lstart,command\` first — ` +
        `a record can outlive a reboot and a pid can be reused.`,
    });
  }

  await assertPortIsOurs(paths);

  const launchId = newLaunchId();
  mkdirSync(paths.stateDir, { recursive: true });
  const installed = prepareInstalledRuntime(paths, cliEntry(), {
    onMigrationEvent: (event) => appendFileSync(paths.logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
  });
  markInstalledMigrationLaunch(paths, installed, launchId);
  const argv = hostDaemonArgv(paths, undefined, installed.cliEntry);
  const logFd = openSync(paths.logFile, "a");
  const child = (dependencies.spawnProcess ?? spawn)(installed.nodeBinary, argv, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...nodeLaunchEnvironment(process.env), ...installed.env, [ENV.hostLaunchId]: launchId },
    cwd: paths.stateDir,
  });
  closeSync(logFd);
  child.unref();

  // Both are recorded rather than thrown: we are inside event handlers, and the
  // wait loop below is the only place that knows how to report a failed start.
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once("exit", (code, signal) => (childExit = { code, signal }));
  child.once("error", (error) => (spawnError = error));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspectHost(paths, 1000);
    if (status.state === "running") {
      if (status.record.launchId !== launchId) {
        throw new CliError(`the ${PRODUCT_NAME} host that answered is not the process this command started`, {
          details: ["The launch identity changed while the host was starting."],
          fix: `Run \`${PRODUCT_NAME} status\`, then quit the other copy before trying again.`,
        });
      }
      completeInstalledMigration(paths, installed, status.record);
      return { record: status.record, started: true };
    }
    if (spawnError) {
      throw new CliError(`could not start the ${PRODUCT_NAME} host: ${spawnError.message}`, {
        fix: `${PRODUCT_NAME} tried to run: ${process.execPath} ${cliEntry()} __daemon`,
        cause: spawnError,
      });
    }
    if (childExit) {
      throw new CliError(`the ${PRODUCT_NAME} host exited immediately (${childExit.signal ?? `code ${childExit.code}`})`, {
        details: logTail(paths.logFile),
        fix: `Full log: ${paths.logFile}`,
      });
    }
    await sleep(200);
  }
  throw new CliError(`the ${PRODUCT_NAME} host did not answer on ${hostUrl(paths)} within ${Math.round(timeoutMs / 1000)}s`, {
    details: logTail(paths.logFile),
    fix: `Check ${paths.logFile}, then try \`${PRODUCT_NAME} up --foreground\` to watch it start.`,
  });
}

/** Advisory for both launchers: an older or unreachable host never blocks adoption. */
export async function refreshHostEnvironment(
  record: Pick<HostRecord, "host" | "port">,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); },
): Promise<void> {
  let rpc: HostRpc | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(record.host)) throw new Error("not local");
    const hostname = record.host === "::1" ? "[::1]" : record.host;
    rpc = await HostRpc.connect({ url: `ws://${hostname}:${record.port}/ws` });
    await Promise.race([
      rpc.request("pi/host/environment", { variables: environmentOverlay(env) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
    ]);
  } catch (error) {
    // No error details or payload: either can contain environment values.
    log(error instanceof HostRpcError && error.isUnsupported
      ? "The running host does not support environment refresh. Attached without restarting it."
      : "Could not confirm the host environment refresh. Attached without restarting it.");
  } finally {
    if (timer) clearTimeout(timer);
    rpc?.close();
  }
}

/** The arguments a daemon needs to reproduce this CLI's path resolution. */
export function daemonArgs(paths: LaserPaths): string[] {
  return [
    "--port",
    String(paths.port),
    "--agent-dir",
    paths.agentDir,
    "--session-dir",
    paths.sessionDir,
    "--state-dir",
    paths.stateDir,
  ];
}

/**
 * Refuse to start on a port somebody else owns. Without this the daemon dies
 * with EADDRINUSE inside a detached process and the user sees only a timeout.
 */
async function assertPortIsOurs(paths: LaserPaths): Promise<void> {
  if (!(await portInUse(paths.host, paths.port))) return;
  const url = hostUrl(paths);
  if (await probeHealth(url)) {
    // A laser host without a record: started by hand, or by another agent dir.
    throw new CliError(`something is already serving a ${PRODUCT_NAME} host on ${url}, but ${PRODUCT_NAME} did not start it`, {
      fix: `Use it as it is (open ${url}), or start yours elsewhere with \`${PRODUCT_NAME} up --port <port>\`.`,
    });
  }
  throw new CliError(`port ${paths.port} on ${paths.host} is already in use by another program`, {
    fix:
      `Free it (\`lsof -nP -iTCP:${paths.port} -sTCP:LISTEN\` shows what holds it), ` +
      `or pick another with \`${PRODUCT_NAME} up --port <port>\`.`,
  });
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  /** True when SIGTERM was not enough and the host had to be killed. */
  forced: boolean;
}

export async function stopHost(paths: LaserPaths, graceMs = 10_000): Promise<StopResult> {
  const status = await inspectHost(paths);
  if (status.state === "stopped") return { stopped: false, forced: false };

  const { pid } = status.record;
  // A host that answered /healthz is provably ours. One that does not answer is
  // only safe to signal if the recorded process identity still matches; without
  // that proof, SIGTERM-then-SIGKILL could land on an unrelated program that
  // inherited the pid, and there is no undoing that.
  if (status.state === "unreachable" && isRecordedProcess(status.record) !== true) {
    throw new CliError(`${PRODUCT_NAME} cannot confirm that process ${pid} is still its host, so it will not signal it`, {
      details: [
        status.reason,
        `${paths.hostFile} was written by ${PRODUCT_NAME} ${status.record.cliVersion} at ${status.record.startedAt || "an unknown time"}.`,
        "A pid is reused, so this record may point at an unrelated program.",
      ],
      fix:
        `Check it yourself (\`ps -p ${pid} -o pid,lstart,command\`). If it is the ${PRODUCT_NAME} host, ` +
        `stop it with \`kill ${pid}\`; if it is not, delete ${paths.hostFile} and run \`${PRODUCT_NAME} up\`.`,
    });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      clearHostFile(paths.hostFile);
      return { stopped: false, pid, forced: false };
    }
    throw new CliError(`could not signal the ${PRODUCT_NAME} host (pid ${pid}): ${(error as Error).message}`, {
      fix: "It may belong to another user. Stop it from the account that started it.",
      exitCode: ExitCode.Failure,
      cause: error,
    });
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      clearHostFile(paths.hostFile);
      return { stopped: true, pid, forced: false };
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the kill; that is the outcome we wanted.
  }
  for (let i = 0; i < 30 && isProcessAlive(pid); i++) await sleep(100);
  clearHostFile(paths.hostFile);
  if (isProcessAlive(pid)) {
    throw new CliError(`the ${PRODUCT_NAME} host (pid ${pid}) ignored SIGTERM and SIGKILL`, {
      fix: `Investigate the process directly: \`ps -p ${pid} -o pid,stat,command\`.`,
    });
  }
  return { stopped: true, pid, forced: true };
}

/** Last lines of the host log, for error output. Empty when there is no log. */
export function logTail(path: string, lines = 12): string[] {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Open the system browser. Never throws: failing to open a browser must not
 * fail `laser up`, whose real job is to have started the host.
 */
export function openBrowser(url: string): boolean {
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
