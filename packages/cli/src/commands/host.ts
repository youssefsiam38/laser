/**
 * `up`, `down`, `status`, `restart` — the host's lifecycle.
 *
 * `up` is the command people type most, and the one that must never scold: if a
 * host is already listening it attaches, prints the URL, and exits 0.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { resolve } from "node:path";
import type { HostNotifications } from "@lasercode/protocol";
import { bool } from "../args.js";
import type { Command } from "../command.js";
import { hostUrl, type LaserPaths } from "../config.js";
import { runDaemon } from "../daemon.js";
import { CliError, ExitCode } from "../errors.js";
import { shortCwd } from "../format.js";
import { logTail, openBrowser, startHost, stopHost } from "../host-control.js";
import { inspectHost, portInUse, probeHealth, type HostRecord } from "../hostfile.js";
import type { Terminal } from "../output.js";
import { HostRpc, type NotificationHandler } from "../rpc.js";
import { listSessions } from "../session-ref.js";

function uptime(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function printRecord(term: Terminal, record: HostRecord, extra: Array<[string, string]> = []): void {
  const p = term.out;
  const rows: Array<[string, string]> = [
    ["url", p.underline(record.url)],
    ["pid", String(record.pid)],
    ["uptime", uptime(record.startedAt)],
    ["agent dir", record.agentDir],
    ["session dir", record.sessionDir],
    ...extra,
  ];
  const pad = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) term.print(`  ${p.dim(label.padEnd(pad))}  ${value}`);
}

export const upCommand: Command = {
  name: "up",
  aliases: ["start"],
  group: "Host",
  summary: "start the host (or attach to a running one) and open the app",
  usage: `${PRODUCT_NAME} up [--port <port>] [--no-open] [--foreground]`,
  description: `
Starts the ${PRODUCT_NAME} host on 127.0.0.1 and opens the app in your browser.

Running it when a host is already up is not an error: ${PRODUCT_NAME} attaches to it and
prints the same URL. That makes \`${PRODUCT_NAME} up\` safe to put in a shell alias, a
tmux startup script, or muscle memory.
`,
  flags: {
    open: { type: "boolean", default: true, description: "Open the app in a browser" },
    foreground: {
      type: "boolean",
      description: "Run the host in this terminal instead of detaching (Ctrl-C stops it)",
    },
  },
  examples: [
    { note: "start it and open the app", command: PRODUCT_NAME },
    { note: "start it on another port, headless", command: `${PRODUCT_NAME} up --port 41500 --no-open` },
    { note: "watch it start, for debugging", command: `${PRODUCT_NAME} up --foreground` },
  ],
  async run({ term, paths, args }) {
    if (bool(args, "foreground")) {
      const running = await inspectHost(paths);
      if (running.state === "running") {
        throw new CliError(`a ${PRODUCT_NAME} host is already running at ${running.record.url} (pid ${running.record.pid})`, {
          fix: `Stop it with \`${PRODUCT_NAME} down\` first, or use a different --port.`,
        });
      }
      if (await portInUse(paths.host, paths.port)) {
        throw new CliError(`port ${paths.port} is already in use`, {
          fix: `Free it, or run \`${PRODUCT_NAME} up --foreground --port <port>\`.`,
        });
      }
      term.note(`${term.err.dim(`starting the ${PRODUCT_NAME} host in the foreground; Ctrl-C stops it`)}`);
      await runDaemon({ paths });
      await new Promise<never>(() => {}); // runDaemon owns the process from here.
    }

    const { record, started } = await startHost(paths);
    const opened = bool(args, "open") ? openBrowser(record.url) : false;

    if (term.json) {
      term.data({
        url: record.url,
        port: record.port,
        pid: record.pid,
        started,
        attached: !started,
        browserOpened: opened,
        agentDir: record.agentDir,
        sessionDir: record.sessionDir,
      });
      return;
    }

    term.note(
      started
        ? `${term.err.green("started")} the ${PRODUCT_NAME} host`
        : `${term.err.dim("already running")} — attached to the host that was already up`,
    );
    printRecord(term, record);
    if (bool(args, "open") && !opened) {
      term.note();
      term.warn(`could not open a browser. Open ${record.url} yourself.`);
    }
  },
};

export const downCommand: Command = {
  name: "down",
  aliases: ["stop-host"],
  group: "Host",
  summary: "stop the running host",
  usage: `${PRODUCT_NAME} down`,
  description: `
Sends SIGTERM to the host, waits for it to close its sockets and retire its
workers, and escalates to SIGKILL only if it does not go. Doing this when
nothing is running succeeds quietly, so it is safe in teardown scripts.
`,
  examples: [{ note: "stop the host", command: `${PRODUCT_NAME} down` }],
  async run({ term, paths }) {
    const before = await inspectHost(paths);
    const result = await stopHost(paths);

    if (term.json) {
      term.data({
        stopped: result.stopped,
        ...(result.pid !== undefined ? { pid: result.pid } : {}),
        forced: result.forced,
        wasRunning: before.state === "running",
      });
      return;
    }
    if (!result.stopped) {
      term.note(`${term.err.dim("nothing to do")} — no ${PRODUCT_NAME} host was running`);
      return;
    }
    term.note(
      `${term.err.green("stopped")} the ${PRODUCT_NAME} host (pid ${result.pid})${result.forced ? term.err.yellow(" — it needed SIGKILL") : ""}`,
    );
  },
};

export const statusCommand: Command = {
  name: "status",
  group: "Host",
  summary: "show whether the host is running, and what it is serving",
  usage: `${PRODUCT_NAME} status`,
  description: `
Asks the host's /healthz endpoint rather than trusting the pid file, so a stale
record left by a crash is reported as "not running" and cleaned up.

Exits 3 when nothing is serving the port, so \`${PRODUCT_NAME} status >/dev/null ||
${PRODUCT_NAME} up\` does the obvious thing. A host ${PRODUCT_NAME} did not start (\`pnpm
sandbox\`, the desktop app, one started by hand) counts as running — the
session commands will use it — but \`${PRODUCT_NAME} down\` still refuses to stop it.
`,
  examples: [
    { note: "is it up?", command: `${PRODUCT_NAME} status` },
    { note: "start it only if it is not", command: `${PRODUCT_NAME} status --json >/dev/null || ${PRODUCT_NAME} up --no-open` },
  ],
  async run({ term, paths }) {
    const status = await inspectHost(paths);

    if (status.state === "stopped") {
      // No record of our own. Something may still be serving there — a host
      // started by hand, or by `pnpm sandbox`. Saying "not running" while a
      // laser UI answers on the port would be a lie worth avoiding.
      const foreign = await probeHealth(hostUrl(paths), 1000);
      if (term.json) {
        term.data({
          running: foreign,
          ours: false,
          expectedUrl: hostUrl(paths),
          removedStaleRecord: status.removedStaleRecord,
          foreignHost: foreign,
        });
      } else if (foreign) {
        term.note(`${term.err.green("running")} ${term.err.dim(`(not started by ${PRODUCT_NAME})`)} — ${hostUrl(paths)}`);
        term.note();
        term.note(`  Session commands use it. ${term.err.bold(`${PRODUCT_NAME} down`)} will not stop it, because ${PRODUCT_NAME} did not start it.`);
      } else {
        term.note(`${term.err.dim("not running")} — no ${PRODUCT_NAME} host on ${hostUrl(paths)}`);
        if (status.removedStaleRecord) term.note(`  ${term.err.dim("(removed a stale record left by a crashed host)")}`);
        term.note();
        term.note(`  Start one with ${term.err.bold(`${PRODUCT_NAME} up`)}.`);
      }
      // A reachable host is a running host, whoever started it: exiting 3 here
      // would send `status || up` at a port that is already taken.
      return foreign ? ExitCode.Ok : ExitCode.NoHost;
    }

    if (status.state === "unreachable") {
      if (term.json) {
        term.data({ running: false, unreachable: true, reason: status.reason, record: status.record });
      } else {
        term.note(`${term.err.yellow("unreachable")} — ${status.reason}`);
        printRecord(term, status.record);
        const tail = logTail(paths.logFile, 6);
        if (tail.length > 0) {
          term.note();
          term.note(`  ${term.err.dim(`last lines of ${paths.logFile}:`)}`);
          for (const line of tail) term.note(`    ${term.err.dim(line)}`);
        }
        term.note();
        term.note(`  Stop it with ${term.err.bold(`${PRODUCT_NAME} down`)} and start again.`);
      }
      return ExitCode.Failure;
    }

    // Running: ask it what it is serving. A failure here is informational only.
    let sessionCount: number | undefined;
    let projectCount: number | undefined;
    let rpc: HostRpc | undefined;
    try {
      rpc = await HostRpc.connect({ url: `ws://${status.record.host}:${status.record.port}/ws`, connectTimeoutMs: 3000 });
      const sessions = await listSessions(rpc);
      sessionCount = sessions.length;
      projectCount = new Set(sessions.map((session) => session.cwd)).size;
    } catch {
      // The host answered /healthz but not the socket; say nothing rather than
      // turning `status` into a failure.
    } finally {
      rpc?.close();
    }

    if (term.json) {
      term.data({
        running: true,
        record: status.record,
        ...(sessionCount !== undefined ? { sessionCount, projectCount } : {}),
      });
      return;
    }
    term.note(`${term.err.green("running")}`);
    printRecord(
      term,
      status.record,
      sessionCount !== undefined ? [["sessions", `${sessionCount} across ${projectCount} project(s)`]] : [],
    );
    return;
  },
};

export const restartCommand: Command = {
  name: "restart",
  group: "Host",
  summary: "stop the host and start it again",
  usage: `${PRODUCT_NAME} restart [--port <port>] [--no-open]`,
  description: `
Equivalent to \`${PRODUCT_NAME} down && ${PRODUCT_NAME} up --no-open\`, but it waits for the old
process to actually exit before binding the port again, which is the part that
goes wrong when you do it by hand.
`,
  flags: {
    open: { type: "boolean", default: false, description: "Open the app in a browser afterwards" },
  },
  examples: [{ note: "pick up a rebuilt host", command: `pnpm -r build && ${PRODUCT_NAME} restart` }],
  async run({ term, paths, args }) {
    const stopped = await stopHost(paths);
    if (stopped.stopped) term.note(`${term.err.dim("stopped")} the old host (pid ${stopped.pid})`);
    const { record } = await startHost(paths);
    const opened = bool(args, "open") ? openBrowser(record.url) : false;

    if (term.json) {
      term.data({ url: record.url, port: record.port, pid: record.pid, restarted: stopped.stopped, browserOpened: opened });
      return;
    }
    term.note(`${term.err.green("started")} the ${PRODUCT_NAME} host`);
    printRecord(term, record);
  },
};

/** Hidden: the process `laser up` re-executes as the host. */
export const daemonCommand: Command = {
  name: "__daemon",
  group: "Host",
  hidden: true,
  summary: "internal: run the host in this process",
  usage: `${PRODUCT_NAME} __daemon`,
  async run({ paths }) {
    await runDaemon({ paths });
    await new Promise<never>(() => {});
  },
};

/** Shared by every command that needs a live host. */
export async function requireHost(paths: LaserPaths): Promise<HostRecord> {
  const status = await inspectHost(paths);
  if (status.state === "running") return status.record;
  if (status.state === "unreachable") {
    throw new CliError(`the ${PRODUCT_NAME} host is not answering`, {
      details: [status.reason],
      exitCode: ExitCode.NoHost,
      fix: `Run \`${PRODUCT_NAME} restart\`.`,
    });
  }
  // No record of our own, but a laser host may still be serving this port —
  // started by hand, by `pnpm sandbox`, or by the desktop app. Refusing to talk
  // to a host that is right there and answering would be pedantry, not safety:
  // the port is the address, and `/healthz` is the proof. `down` still refuses
  // to stop what it did not start; that check reads the record, not this.
  const adopted = await adoptForeignHost(paths);
  if (adopted) return adopted;
  throw new CliError(`no ${PRODUCT_NAME} host is running`, {
    exitCode: ExitCode.NoHost,
    fix: `Start one with \`${PRODUCT_NAME} up\` (add --no-open to skip the browser).`,
  });
}

/** A healthy laser host on the configured port that laser did not start. */
async function adoptForeignHost(paths: LaserPaths): Promise<HostRecord | undefined> {
  const url = hostUrl(paths);
  if (!(await probeHealth(url))) return undefined;
  return {
    pid: 0,
    host: paths.host,
    port: paths.port,
    url,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    startedAt: "",
    cliVersion: "unknown",
  };
}

/** Connect to the running host, or explain why we cannot. */
export async function connect(paths: LaserPaths, onNotification?: NotificationHandler): Promise<HostRpc> {
  const record = await requireHost(paths);
  return HostRpc.connect({
    url: `ws://${record.host}:${record.port}/ws`,
    ...(onNotification ? { onNotification } : {}),
  });
}

/**
 * `connect`, for a command that is about to touch one project.
 *
 * Anything that starts a worker (settings, packages, a session) can make the
 * host discover that the directory has trust-gated resources in it. The host
 * then holds the worker start and asks its clients
 * (`pi/project/trust_request`), and keeps holding it until one answers. A
 * terminal cannot answer: there is no modal, and answering from a flag would
 * be a security decision made by a flag. Before this, the command simply
 * never returned — the failure mode was an unexplained hang, which is the one
 * thing a CLI must never do.
 *
 * So the question is turned into an error that says what was asked and how to
 * answer it, and the command exits.
 */
export async function connectForProject(
  paths: LaserPaths,
  cwd: string,
  onNotification?: NotificationHandler,
): Promise<HostRpc> {
  let rpc: HostRpc | undefined;
  const handler: NotificationHandler = (method, params) => {
    if (method === "pi/project/trust_request") {
      const ask = params as HostNotifications["pi/project/trust_request"];
      if (resolve(ask.cwd) === resolve(cwd)) {
        rpc?.failPending(
          new CliError(`${shortCwd(ask.cwd)} has not been trusted yet, and this command cannot ask`, {
            exitCode: ExitCode.Usage,
            fix: `It ships its own agent configuration (${ask.reasons.join(", ")}), which the agent would load and run with your permissions. Answer once with \`${PRODUCT_NAME} projects trust ${ask.cwd}\` (or \`--no\` to decline), then run this again.`,
          }),
        );
        return;
      }
    }
    onNotification?.(method, params as never);
  };
  rpc = await connect(paths, handler);
  return rpc;
}

export const hostCommands: readonly Command[] = [upCommand, downCommand, statusCommand, restartCommand, daemonCommand];
