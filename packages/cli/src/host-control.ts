/**
 * Host lifecycle: start it, wait for it to actually answer, stop it politely,
 * and open a browser at it.
 *
 * Starting twice is not an error. `piorbit up` on a machine that already has a
 * host attaches to it and prints the URL, which is what a person means when
 * they type it a second time.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiorbitPaths } from "./config.js";
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
 * daemon (`@piorbit/desktop` `runtime.ts` — deliberately a plain node with no
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
export async function startHost(paths: PiorbitPaths, timeoutMs = 30_000): Promise<StartResult> {
  const existing = await inspectHost(paths);
  if (existing.state === "running") return { record: existing.record, started: false };
  if (existing.state === "unreachable") {
    throw new CliError(`a piorbit host is recorded as running but is not answering`, {
      details: [existing.reason],
      fix:
        `Stop it with \`piorbit down\`, then run \`piorbit up\` again. ` +
        `If piorbit refuses to signal it, check \`ps -p ${existing.record.pid} -o pid,lstart,command\` first — ` +
        `a record can outlive a reboot and a pid can be reused.`,
    });
  }

  await assertPortIsOurs(paths);

  mkdirSync(paths.stateDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a");
  const child = spawn(process.execPath, [cliEntry(), "__daemon", ...daemonArgs(paths)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
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
    if (status.state === "running") return { record: status.record, started: true };
    if (spawnError) {
      throw new CliError(`could not start the piorbit host: ${spawnError.message}`, {
        fix: `piorbit tried to run: ${process.execPath} ${cliEntry()} __daemon`,
        cause: spawnError,
      });
    }
    if (childExit) {
      throw new CliError(`the piorbit host exited immediately (${childExit.signal ?? `code ${childExit.code}`})`, {
        details: logTail(paths.logFile),
        fix: `Full log: ${paths.logFile}`,
      });
    }
    await sleep(200);
  }
  throw new CliError(`the piorbit host did not answer on ${hostUrl(paths)} within ${Math.round(timeoutMs / 1000)}s`, {
    details: logTail(paths.logFile),
    fix: `Check ${paths.logFile}, then try \`piorbit up --foreground\` to watch it start.`,
  });
}

/** The arguments a daemon needs to reproduce this CLI's path resolution. */
export function daemonArgs(paths: PiorbitPaths): string[] {
  return [
    "--port",
    String(paths.port),
    "--agent-dir",
    paths.agentDir,
    "--session-dir",
    paths.sessionDir,
    "--state-dir",
    paths.stateDir,
    "--subagents-temp-root",
    paths.subagentsTempRoot,
  ];
}

/**
 * Refuse to start on a port somebody else owns. Without this the daemon dies
 * with EADDRINUSE inside a detached process and the user sees only a timeout.
 */
async function assertPortIsOurs(paths: PiorbitPaths): Promise<void> {
  if (!(await portInUse(paths.host, paths.port))) return;
  const url = hostUrl(paths);
  if (await probeHealth(url)) {
    // A piorbit host without a record: started by hand, or by another agent dir.
    throw new CliError(`something is already serving a piorbit host on ${url}, but piorbit did not start it`, {
      fix: `Use it as it is (open ${url}), or start yours elsewhere with \`piorbit up --port <port>\`.`,
    });
  }
  throw new CliError(`port ${paths.port} on ${paths.host} is already in use by another program`, {
    fix:
      `Free it (\`lsof -nP -iTCP:${paths.port} -sTCP:LISTEN\` shows what holds it), ` +
      `or pick another with \`piorbit up --port <port>\`.`,
  });
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  /** True when SIGTERM was not enough and the host had to be killed. */
  forced: boolean;
}

export async function stopHost(paths: PiorbitPaths, graceMs = 10_000): Promise<StopResult> {
  const status = await inspectHost(paths);
  if (status.state === "stopped") return { stopped: false, forced: false };

  const { pid } = status.record;
  // A host that answered /healthz is provably ours. One that does not answer is
  // only safe to signal if the recorded process identity still matches; without
  // that proof, SIGTERM-then-SIGKILL could land on an unrelated program that
  // inherited the pid, and there is no undoing that.
  if (status.state === "unreachable" && isRecordedProcess(status.record) !== true) {
    throw new CliError(`piorbit cannot confirm that process ${pid} is still its host, so it will not signal it`, {
      details: [
        status.reason,
        `${paths.hostFile} was written by piorbit ${status.record.cliVersion} at ${status.record.startedAt || "an unknown time"}.`,
        "A pid is reused, so this record may point at an unrelated program.",
      ],
      fix:
        `Check it yourself (\`ps -p ${pid} -o pid,lstart,command\`). If it is the piorbit host, ` +
        `stop it with \`kill ${pid}\`; if it is not, delete ${paths.hostFile} and run \`piorbit up\`.`,
    });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      clearHostFile(paths.hostFile);
      return { stopped: false, pid, forced: false };
    }
    throw new CliError(`could not signal the piorbit host (pid ${pid}): ${(error as Error).message}`, {
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
    throw new CliError(`the piorbit host (pid ${pid}) ignored SIGTERM and SIGKILL`, {
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
 * fail `piorbit up`, whose real job is to have started the host.
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
