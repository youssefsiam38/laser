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
 *    `piorbit up`, or left a host running from a previous session. If one
 *    answers `/healthz`, the app attaches to it and does not stop it on quit.
 *    Nothing is more annoying than a GUI that kills your terminal's daemon.
 *
 * We spawn the CLI's `__daemon` entry rather than the host's own `main.js`,
 * because the daemon writes `<state-dir>/host.json`. That one file is what lets
 * `piorbit status`, `piorbit down` and the next launch of the app all agree
 * about which host is running.
 *
 * Rule 1 has a second half that is easy to miss: the *script* has to be outside
 * `app.asar` too, not only the binary. `cliEntry()` (`@piorbit/cli`) does that
 * rewrite, and the log line below records the exact command so a failed start
 * on someone else's machine is one line to read rather than a guess.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { existsSync } from "node:fs";
import { cliEntry, daemonArgs, inspectHost, logTail, piEnv, portInUse, probeHealth, type PiorbitPaths } from "@piorbit/cli";
import type { DesktopHostInfo } from "./api.js";
import type { DesktopLog } from "./log.js";
import { resolveNodeRuntime, RuntimeError, type NodeRuntime } from "./runtime.js";

const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 8000;
/** Automatic restarts after an unexpected exit, then we stop and say so. */
const MAX_RESTARTS = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HostProcessOptions {
  paths: PiorbitPaths;
  packaged: boolean;
  resourcesPath: string;
  log: DesktopLog;
  /**
   * Extra environment for the host. Used for `PIORBIT_ALLOWED_ORIGINS` when the
   * UI is served by a dev server: the host refuses WebSocket upgrades from an
   * origin it does not know, and Vite forwards the browser's own.
   */
  env?: Readonly<Record<string, string>>;
  onChange: (info: DesktopHostInfo) => void;
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

    const existing = await inspectHost(paths);
    if (existing.state === "running") {
      log.line(`attached to the host already running at ${existing.record.url} (pid ${existing.record.pid})`);
      return this.publish({
        state: "ready",
        url: existing.record.url,
        wsUrl: `ws://${existing.record.host}:${existing.record.port}/ws`,
        port: existing.record.port,
        startedByUs: false,
      });
    }
    if (existing.state === "unreachable") {
      return this.publish({
        state: "failed",
        startedByUs: false,
        message:
          `A piorbit host is recorded at ${existing.record.url} but is not answering. ` +
          `Stop it with \`piorbit down\` and open piorbit again.`,
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
          "piorbit could not find the agent host it ships with. This install is incomplete — reinstall piorbit.",
      });
    }

    if (await portInUse(paths.host, paths.port)) {
      const theirs = await probeHealth(this.info.url);
      return this.publish({
        state: "failed",
        message: theirs
          ? `Another piorbit host is already serving ${this.info.url}. Open that one, or set PIORBIT_PORT and try again.`
          : `Port ${paths.port} is already taken by another program. Set PIORBIT_PORT to a free port and open piorbit again.`,
      });
    }

    return this.spawnDaemon();
  }

  private async spawnDaemon(): Promise<DesktopHostInfo> {
    const { paths, log } = this.options;
    const runtime = this.runtime;
    if (!runtime) return this.publish({ state: "failed", message: "The Node runtime was not resolved." });

    mkdirSync(paths.stateDir, { recursive: true });
    // The daemon's own stdout and stderr go straight to the host log, the same
    // file `piorbit up` uses, so both ways of starting leave one trail.
    const logFd = openSync(paths.logFile, "a");
    const env = { ...piEnv(paths, this.electronFreeEnv()), ...this.options.env };
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
        this.restarts = 0;
        log.line(`host ready at ${status.record.url} (pid ${status.record.pid})`);
        return this.publish({
          state: "ready",
          url: status.record.url,
          wsUrl: `ws://${status.record.host}:${status.record.port}/ws`,
          port: status.record.port,
          startedByUs: true,
          runtime: { binary: runtime.binary, version: runtime.version, execPath: runtime.execPath },
          message: null,
        });
      }
      if (spawnError) {
        log.error("could not spawn the host", spawnError);
        return this.publish({
          state: "failed",
          message: `piorbit could not start its agent host (${spawnError.message}). The log is at ${paths.logFile}.`,
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
          `The agent host stopped ${this.restarts + 1} times, so piorbit stopped restarting it. ` +
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
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) {
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
   * Electron sets variables that would confuse a plain Node child (and
   * `ELECTRON_RUN_AS_NODE` would change what our own binary means). The host
   * gets a clean environment plus the piorbit path pins.
   */
  private electronFreeEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
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
