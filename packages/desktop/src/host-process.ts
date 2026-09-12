/**
 * The host process, supervised by the shell (M5-T1, M5-T2).
 *
 * Two rules shape all of this:
 *
 * 1. **The host is a child, not a thread.** It runs in the bundled stock Node
 *    (see `runtime.ts`), never inside Electron, so every process Pi spawns —
 *    MCP servers over stdio, `npx`, a worker per project — inherits a
 *    `process.execPath` that is a real node.
 * 2. **Starting twice is not an error.** Someone may already have run
 *    `laser up`, or left a host running from a previous session. If one
 *    answers `/healthz` at this app's version, the app attaches to it. An old
 *    generation is shut down cleanly and replaced before the UI connects.
 *
 * We spawn the CLI's `__daemon` entry rather than the host's own `main.js`,
 * because the daemon writes `<state-dir>/host.json`. That one file is what lets
 * `laser status`, `laser down` and the next launch of the app all agree
 * about which host is running.
 *
 * Rule 1 has a second half that is easy to miss: the *script* has to be outside
 * `app.asar` too, not only the binary. `cliEntry()` (`@lasercode/cli`) does that
 * rewrite, and the log line below records the exact command so a failed start
 * on someone else's machine is one line to read rather than a guess.
 */
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import {
  CLI_VERSION,
  cliEntry,
  daemonArgs,
  inspectHost,
  logTail,
  piEnv,
  portInUse,
  probeHealth,
  refreshHostEnvironment,
  stopHost,
  type LaserPaths,
} from "@lasercode/cli";
import { hostNeedsRefresh } from "./host-compatibility.js";
import { installedHostVersion } from "./native-update.js";
import { checkBundledAgent, type AgentCheck } from "./agent.js";
import type { DesktopHostInfo } from "./api.js";
import type { DesktopLog } from "./log.js";
import { resolveNodeRuntime, RuntimeError, type NodeRuntime } from "./runtime.js";

const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 8000;
/** Automatic restarts after an unexpected exit, then we stop and say so. */
const MAX_RESTARTS = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HostProcessOptions {
  paths: LaserPaths;
  packaged: boolean;
  resourcesPath: string;
  log: DesktopLog;
  /**
   * The environment children inherit, before laser's own pins are applied.
   * The shell hands in a scrubbed copy (see `agent-home.ts`) so a variable that
   * points at the person's *own* agent installation cannot reach a worker.
   */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Extra environment for the host. Used for `LASER_ALLOWED_ORIGINS` when the
   * UI is served by a dev server: the host refuses WebSocket upgrades from an
   * origin it does not know, and Vite forwards the browser's own.
   */
  env?: Readonly<Record<string, string>>;
  onChange: (info: DesktopHostInfo) => void;
  confirmHostRefresh?: (runningVersion: string) => Promise<boolean>;
}

/** A partial update to the published info. `message: null` clears the message. */
interface HostInfoPatch {
  state?: DesktopHostInfo["state"];
  url?: string;
  wsUrl?: string;
  port?: number;
  startedByUs?: boolean;
  runtime?: DesktopHostInfo["runtime"];
  message?: string | null;
}

export class HostProcess {
  private child: ChildProcess | undefined;
  private runtime: NodeRuntime | undefined;
  /**
   * Started next to the daemon spawn and awaited before "ready", so proving the
   * bundled agent costs nothing on a healthy install and is never skipped.
   */
  private agentCheck: Promise<AgentCheck> | undefined;
  private restarts = 0;
  private stopping = false;
  private info: DesktopHostInfo;

  constructor(private readonly options: HostProcessOptions) {
    const { paths } = options;
    this.info = {
      state: "starting",
      url: `http://${paths.host}:${paths.port}`,
      wsUrl: `ws://${paths.host}:${paths.port}/ws`,
      port: paths.port,
      startedByUs: false,
      logFile: paths.logFile,
    };
  }

  current(): DesktopHostInfo {
    return this.info;
  }

  /** Start a host, or adopt the one that is already answering. */
  async start(): Promise<DesktopHostInfo> {
    const { paths, log } = this.options;
    this.stopping = false;

    // Our own child is already running: a retry must not "adopt" it, or we
    // would forget that we own it and leave it behind on quit.
    if (this.child && this.child.exitCode === null) return this.info;

    if (this.options.packaged && installedHostVersion(this.options.resourcesPath) !== CLI_VERSION) {
      return this.publish({ state: "failed", message: "An update is installed. Restart the app and host together when you are ready." });
    }

    const existing = await inspectHost(paths);
    if (existing.state === "running") {
      if (hostNeedsRefresh(existing.record.cliVersion, CLI_VERSION)) {
        if (!await this.options.confirmHostRefresh?.(existing.record.cliVersion)) {
          return this.publish({ state: "failed", message: "The host is a different version. Restart the app and host together when you are ready." });
        }
        log.line(
          `refreshing background service ${existing.record.cliVersion} to ${CLI_VERSION} (pid ${existing.record.pid})`,
        );
        try {
          await stopHost(paths);
        } catch (error) {
          log.error("could not refresh the old background service", error);
          return this.publish({
            state: "failed",
            startedByUs: false,
            message: `${PRODUCT_NAME} could not refresh its background service. Quit ${PRODUCT_NAME} completely and open it again.`,
          });
        }
      } else {
        await refreshHostEnvironment(existing.record, this.options.baseEnv ?? process.env, (line) => log.line(line));
        log.line(`attached to the host already running at ${existing.record.url} (pid ${existing.record.pid})`);
        return this.publish({
          state: "ready",
          url: existing.record.url,
          wsUrl: `ws://${existing.record.host}:${existing.record.port}/ws`,
          port: existing.record.port,
          startedByUs: false,
        });
      }
    }
    if (existing.state === "unreachable") {
      return this.publish({
        state: "failed",
        startedByUs: false,
        message:
          `${PRODUCT_NAME} found a copy of itself already running at ${existing.record.url}, but it has stopped answering. ` +
          `Quit ${PRODUCT_NAME} completely — including the icon in your system tray — and open it again. ` +
          `If that does not help, restarting the computer will clear it.`,
      });
    }

    try {
      this.runtime = resolveNodeRuntime({ packaged: this.options.packaged, resourcesPath: this.options.resourcesPath });
    } catch (error) {
      if (error instanceof RuntimeError) {
        log.error("no usable Node runtime", error);
        return this.publish({ state: "failed", message: `${error.message} ${error.fix}` });
      }
      throw error;
    }
    log.line(
      `host runtime: ${this.runtime.binary} (${this.runtime.version}, ${this.runtime.source}), ` +
        `process.execPath = ${this.runtime.execPath}`,
    );
    this.agentCheck ??= checkBundledAgent({
      nodeBinary: this.runtime.binary,
      env: this.hostEnv(),
      log,
    }).then((result) => {
      if (result.ok) {
        log.line(
          `bundled agent: ${result.agent.package} ${result.agent.version} (pinned ${result.agent.pinned}) ` +
            `at ${result.agent.packageDir}, loaded in ${result.agent.loadMs ?? 0}ms`,
        );
        // Said out loud because it is the claim this whole design makes: an
        // agent the person installed themselves is found and left alone.
        if (result.machine.commandOnPath || result.machine.homeAgentDir) {
          log.line(
            `this machine also has an agent (${[result.machine.commandOnPath, result.machine.homeAgentDir]
              .filter(Boolean)
              .join(", ")}); ${PRODUCT_NAME} does not use it`,
          );
        }
      } else {
        log.line(`bundled agent check failed: ${result.message}`);
      }
      return result;
    });

    // `cliEntry()` already rewrites `app.asar` to `app.asar.unpacked`, which is
    // the path the bundled Node can actually open — Electron's own `fs` is
    // asar-aware and would answer `true` for the archive path, so this check
    // has to stat the same path the spawn uses or it is a guaranteed pass in
    // exactly the case it exists to catch.
    const entry = cliEntry();
    if (!existsSync(entry)) {
      log.error(`the host entry is missing at ${entry}`, new Error("cliEntry does not exist"));
      return this.publish({
        state: "failed",
        message:
          `${PRODUCT_NAME} could not find the agent host it ships with. This install is incomplete — reinstall ${PRODUCT_NAME}.`,
      });
    }

    if (await portInUse(paths.host, paths.port)) {
      const theirs = await probeHealth(this.info.url);
      return this.publish({
        state: "failed",
        message: theirs
          ? `Another copy of ${PRODUCT_NAME} is already running on this computer, at ${this.info.url}. ` +
            `Switch to that window instead of opening a second one — look for ${PRODUCT_NAME} in your system tray.`
          : `Something else on this computer is already using the connection ${PRODUCT_NAME} needs (port ${paths.port}). ` +
            `Close whatever else is running and open ${PRODUCT_NAME} again. If you know what it is and want to keep it, ` +
            `${PRODUCT_NAME} can be moved to another port by setting ${ENV.port} before it starts.`,
      });
    }

    return this.spawnDaemon();
  }

  private async spawnDaemon(): Promise<DesktopHostInfo> {
    if (this.options.packaged && installedHostVersion(this.options.resourcesPath) !== CLI_VERSION) {
      return this.publish({ state: "failed", message: "An update is installed. Restart the app and host together when you are ready." });
    }
    const { paths, log } = this.options;
    const runtime = this.runtime;
    if (!runtime) return this.publish({ state: "failed", message: "The Node runtime was not resolved." });

    mkdirSync(paths.stateDir, { recursive: true });
    // The daemon's own stdout and stderr go straight to the host log, the same
    // file `laser up` uses, so both ways of starting leave one trail.
    const logFd = openSync(paths.logFile, "a");
    const env = this.hostEnv();
    let child: ChildProcess;
    try {
      log.line(`spawning the host: ${runtime.binary} ${cliEntry()} __daemon`);
      child = spawn(runtime.binary, [cliEntry(), "__daemon", ...daemonArgs(paths)], {
        stdio: ["ignore", logFd, logFd],
        env,
        cwd: paths.stateDir,
        windowsHide: true,
      });
    } finally {
      closeSync(logFd);
    }
    this.child = child;
    this.publish({ state: "starting", startedByUs: true, message: null });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      this.onChildExit(code, signal);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await inspectHost(paths, 1000);
      if (status.state === "running") {
        if (hostNeedsRefresh(status.record.cliVersion, CLI_VERSION)) {
          await this.stop();
          return this.publish({ state: "failed", message: "The installed version changed during startup. Restart the app and host together when you are ready." });
        }
        // The host answers; the agent it will load is the last thing to prove.
        // Running an agent nobody pinned, or one that cannot load, is worse
        // than not starting — and it must be said now rather than at the first
        // prompt, when a person is already typing.
        const agent = await (this.agentCheck ?? Promise.resolve(undefined));
        if (agent && !agent.ok) {
          await this.stop();
          this.stopping = false;
          return this.publish({ state: "failed", message: `${agent.message} ${agent.fix}` });
        }
        this.restarts = 0;
        log.line(`host ready at ${status.record.url} (pid ${status.record.pid})`);
        return this.publish({
          state: "ready",
          url: status.record.url,
          wsUrl: `ws://${status.record.host}:${status.record.port}/ws`,
          port: status.record.port,
          startedByUs: true,
          runtime: {
            binary: runtime.binary,
            version: runtime.version,
            execPath: runtime.execPath,
            ...(agent?.ok
              ? {
                  agent: {
                    package: agent.agent.package,
                    version: agent.agent.version,
                    packageDir: agent.agent.packageDir,
                  },
                }
              : {}),
          },
          message: null,
        });
      }
      if (spawnError) {
        log.error("could not spawn the host", spawnError);
        return this.publish({
          state: "failed",
          message: `${PRODUCT_NAME} could not start its agent host (${spawnError.message}). The log is at ${paths.logFile}.`,
        });
      }
      if (exited) {
        return this.publish({
          state: "failed",
          message:
            `The agent host stopped immediately (${exited.signal ?? `exit code ${exited.code}`}). ` +
            `${lastLogLine(paths.logFile)} Full log: ${paths.logFile}`,
        });
      }
      await sleep(200);
    }

    return this.publish({
      state: "failed",
      message: `The agent host did not answer on ${this.info.url} within 30 seconds. Its log is at ${paths.logFile}.`,
    });
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined;
    if (this.stopping) return;
    const { log, paths } = this.options;
    log.line(`host exited unexpectedly (${signal ?? `code ${code}`})`);
    if (this.restarts >= MAX_RESTARTS) {
      this.publish({
        state: "failed",
        message:
          `The agent host stopped ${this.restarts + 1} times, so ${PRODUCT_NAME} stopped restarting it. ` +
          `${lastLogLine(paths.logFile)} Full log: ${paths.logFile}`,
      });
      return;
    }
    this.restarts += 1;
    this.publish({ state: "starting", message: "The agent host stopped. Restarting it…" });
    void sleep(500 * this.restarts).then(() => {
      if (!this.stopping) void this.spawnDaemon();
    });
  }

  /**
   * Stop the host we started, and wait for it: quitting the app while a Pi
   * session is mid-write is how a session file gets a torn tail.
   */
  async stop(includeAttached = false): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      if (includeAttached) await stopHost(this.options.paths);
      this.publish({ state: "stopped", message: null });
      return;
    }
    this.options.log.line(`stopping the host (pid ${child.pid ?? "unknown"})`);
    const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone between the check and the signal, which is the outcome we want.
    }
    const timedOut = await Promise.race([ended.then(() => false), sleep(STOP_GRACE_MS).then(() => true)]);
    if (timedOut) {
      this.options.log.line("the host ignored SIGTERM; killing it");
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing left to kill.
      }
      await Promise.race([ended, sleep(2000)]);
    }
    this.child = undefined;
    this.publish({ state: "stopped", message: null });
  }

  /**
   * The environment every child of this shell gets: the host, and the agent
   * check that has to see exactly what the host will see. One function, so the
   * thing we verify and the thing we run can never diverge.
   */
  private hostEnv(): NodeJS.ProcessEnv {
    return {
      ...piEnv(this.options.paths, this.electronFreeEnv()),
      // The package manager that came out of the pinned Node archive. Settings
      // installs extensions with it, on a machine that has never had Node.
      // Absent in a development build that has not run `pnpm -F
      // @lasercode/desktop runtime`, and the host says so rather than guessing.
      ...(this.runtime?.npmCli ? { [ENV.npmCli]: this.runtime.npmCli } : {}),
      ...this.options.env,
    };
  }

  /**
   * Electron sets variables that would confuse a plain Node child (and
   * `ELECTRON_RUN_AS_NODE` would change what our own binary means). The host
   * gets a clean environment plus the laser path pins.
   */
  private electronFreeEnv(): NodeJS.ProcessEnv {
    const env = { ...(this.options.baseEnv ?? process.env) };
    for (const key of Object.keys(env)) {
      if (key.startsWith("ELECTRON_")) delete env[key];
    }
    delete env["NODE_OPTIONS"]; // An inspector flag meant for the shell must not land in the host.
    return env;
  }

  private publish(patch: HostInfoPatch): DesktopHostInfo {
    const { message, runtime, ...rest } = patch;
    const next: DesktopHostInfo = {
      ...this.info,
      ...rest,
      ...(runtime !== undefined ? { runtime } : {}),
    };
    // `null` clears the message; leaving the key out keeps whatever was there.
    // Under `exactOptionalPropertyTypes` an explicit `undefined` cannot say
    // either of those things, so it does not appear in the patch type.
    if (message === null) delete next.message;
    else if (message !== undefined) next.message = message;
    this.info = next;
    this.options.onChange(next);
    return next;
  }
}

/** One line of context for an error message, never a stack trace. */
function lastLogLine(file: string): string {
  const tail = logTail(file, 1)[0];
  return tail ? `Last log line: ${tail}` : "";
}
