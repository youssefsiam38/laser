/**
 * Proving, at every launch, that the agent piorbit runs is the agent piorbit
 * ships (M10-T3).
 *
 * The app is self-contained or it is not, and "not" has to be a refusal rather
 * than a surprise three prompts later. Before the host is spawned, the shell
 * asks the **bundled Node** — the same binary every worker runs on — to resolve
 * the agent from the **worker's own directory** and to import it. Three answers
 * matter and all three come from one child process:
 *
 *   is it there · is it the pinned version · does its whole import graph load
 *
 * The last one is not paranoia. A packager that misses a transitive package
 * produces a tree where the agent's entry file exists, its manifest reads
 * correctly, and the first `import` dies. Only importing it catches that, and
 * only the bundled Node's answer counts — this process is Electron, and its
 * module resolution is not the one that will be used.
 *
 * The check runs concurrently with the host's own start, so on a healthy
 * install it costs no wall-clock time at all.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliEntry, unpacked } from "@piorbit/cli";
import type { DesktopLog } from "./log.js";

/** What the bundled Node reported about the agent it found. */
export interface BundledAgent {
  package: string;
  version: string;
  /** The version pinned in git. Equal to `version`, or the check failed. */
  pinned: string;
  packageDir: string;
  bin: string;
  /** Milliseconds the agent's import graph took to load. */
  loadMs?: number;
}

export interface AgentCheckOk {
  ok: true;
  agent: BundledAgent;
  /** The bundled Node that answered, as it sees itself. */
  runtime: { execPath: string; version: string };
  /** An agent installation on this machine, found and deliberately not used. */
  machine: { commandOnPath?: string; homeAgentDir?: string };
}

export interface AgentCheckFailed {
  ok: false;
  /** One sentence, written for a person: what is wrong. */
  message: string;
  /** One sentence: what to do about it. */
  fix: string;
}

export type AgentCheck = AgentCheckOk | AgentCheckFailed;

const CHECK_TIMEOUT_MS = 60_000;

/**
 * The worker's `resolve-pi.js`, found the way Node itself would: walk the
 * `node_modules` chain above the CLI entry we already know how to locate. The
 * packaged app has one flat tree there and a development checkout has pnpm's
 * links; both end at the same file.
 *
 * `cliEntry()` has already rewritten `app.asar` to `app.asar.unpacked`, and
 * `unpacked()` is applied again because a path built from it must be one the
 * bundled Node can open — Electron's own `fs` would happily stat the archive.
 */
export function agentCheckScript(): string | undefined {
  let dir = resolve(dirname(cliEntry()));
  for (;;) {
    const candidate = join(dir, "node_modules", "@piorbit", "worker", "dist", "resolve-pi.js");
    if (existsSync(unpacked(candidate))) return unpacked(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Run the check. Never throws: every failure becomes a sentence and a fix,
 * because the only caller puts them on screen.
 */
export function checkBundledAgent(options: {
  nodeBinary: string;
  env: NodeJS.ProcessEnv;
  log: DesktopLog;
}): Promise<AgentCheck> {
  const script = agentCheckScript();
  if (!script) {
    return Promise.resolve({
      ok: false,
      message: "piorbit could not find the agent it ships with.",
      fix: "This install is incomplete. Reinstall piorbit.",
    });
  }

  return new Promise<AgentCheck>((settle) => {
    execFile(
      options.nodeBinary,
      [script, "--check"],
      { timeout: CHECK_TIMEOUT_MS, env: options.env, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const report = parseReport(stdout);
        if (report && report.ok === false) {
          settle({ ok: false, message: report.error, fix: report.fix });
          return;
        }
        if (report && report.ok === true) {
          const { agent, runtime, machine } = report;
          settle({
            ok: true,
            agent: {
              package: agent.package,
              version: agent.version,
              pinned: agent.pinned,
              packageDir: agent.packageDir,
              bin: agent.bin,
              ...(agent.loadMs === undefined ? {} : { loadMs: agent.loadMs }),
            },
            runtime,
            machine: machine ?? {},
          });
          return;
        }
        // No parsable answer at all: the child died, or something else printed
        // over it. Say which, and keep the detail in the log rather than on screen.
        options.log.error(
          `the bundled agent check produced no answer (${error?.message ?? "no error"})`,
          new Error(stderr.trim() || stdout.trim() || "no output"),
        );
        settle({
          ok: false,
          message: "piorbit could not check the agent it ships with, so it did not start it.",
          fix: "Reinstall piorbit. If it happens again, please report it with the piorbit log.",
        });
      },
    );
  });
}

/** The report is one JSON line; anything else on the stream is somebody's noise. */
function parseReport(stdout: string): AgentReportWire | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentReportWire;
      if (typeof parsed?.ok === "boolean") return parsed;
    } catch {
      // Not the line we want; keep looking backwards.
    }
  }
  return undefined;
}

/**
 * The shape `@piorbit/worker`'s `resolve-pi.js` prints. Declared here rather
 * than imported because this package must not depend on the worker: it is the
 * *contract* of a child process, and a child process contract is data.
 */
type AgentReportWire =
  | {
      ok: true;
      agent: { package: string; version: string; pinned: string; packageDir: string; bin: string; loadMs?: number };
      runtime: { execPath: string; version: string };
      machine?: { commandOnPath?: string; homeAgentDir?: string };
    }
  | { ok: false; error: string; fix: string };
