/**
 * pi-subagents file layer (M3-T2, M3-T3, M3-T4). Lives in the host, not the
 * extension, so sessions started from a terminal (no worker, no extension) are
 * still visible. Parses JSON only; imports nothing from Pi or pi-subagents.
 *
 * On-disk layout (pi-subagents 0.65):
 *   <root>/async-subagent-runs/<runId>/status.json        atomic, ≤100 ms stale
 *   <root>/async-subagent-runs/<runId>/events.jsonl       append-only, no text deltas
 *   <root>/async-subagent-runs/<runId>/control/{steer-requests,stop-requests}/*.json, interrupt.json
 *   <root>/async-subagent-runs/.active-runs/<runId>
 *   <root>/async-subagent-runs/.terminal-runs/<sha256(sessionId)>/<endedAt>-<runId>.json
 *   ~/.pi/agent/sessions/<slug>/subagent-artifacts/{runId}_{agent}_{n}_transcript.jsonl   (foreground)
 *   ~/.pi/agent/missions/{index,projects}/**                                             (missions)
 */
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { defaultAgentDir } from "../paths.js";

/** pi-subagents' own index of runs it believes are active. */
export const ACTIVE_RUN_INDEX = ".active-runs";

/** Roots to scan. PI_SUBAGENTS_TEMP_ROOT first, then the uid-scoped default. */
export function subagentsTempRoots(): string[] {
  const roots = new Set<string>();
  const env = process.env["PI_SUBAGENTS_TEMP_ROOT"];
  if (env) roots.add(env);
  if (process.platform !== "win32") roots.add(join(tmpdir(), `pi-subagents-uid-${userInfo().uid}`));
  return [...roots];
}

export function asyncRunsDir(root: string): string {
  return join(root, "async-subagent-runs");
}

export function missionsDir(agentDir = defaultAgentDir()): string {
  return join(agentDir, "missions");
}

// ---------------------------------------------------------------------------
// Live background runs (M2-T1: the worker-retirement guard)
// ---------------------------------------------------------------------------

/**
 * One background run as `status.json` describes it. Only the fields the
 * retirement guard needs; the full schema arrives with M3-T2.
 */
export interface ActiveRun {
  runId: string;
  dir: string;
  state: "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
  /** Pi session id of the parent session that launched the run. */
  sessionId?: string;
  cwd?: string;
  /** Detached runner process. */
  pid?: number;
}

/** pi-subagents' own definition of "this run still has a process behind it". */
export function isActiveState(state: string): boolean {
  return state === "queued" || state === "running";
}

/**
 * Is the runner still there? `EPERM` (another uid) means "yes, probably", and
 * a run with no recorded pid is treated as alive: reaping a session out from
 * under a running subagent is far worse than keeping a worker a few minutes
 * too long.
 *
 * Deliberately not `lastUpdate`: a background run that is thinking writes
 * nothing for minutes, and findings.md records that using it as a heartbeat is
 * how sessions get reaped mid-run.
 */
export function isRunnerAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Names under `.active-runs/` that are not run markers. */
const NOT_A_RUN = new Set(["tool-calls"]);
/** Bound on a fallback scan of a runs root, so a stale temp dir cannot stall us. */
const MAX_RUN_DIRS = 500;

/**
 * Every background run pi-subagents currently believes is active, across all
 * temp roots. Reads `.active-runs/` (its own index) when present and falls back
 * to listing the runs directory, both bounded and failure-tolerant: this is
 * called on a timer and must never throw.
 */
export function activeRuns(roots: readonly string[] = subagentsTempRoots()): ActiveRun[] {
  const out: ActiveRun[] = [];
  for (const root of roots) {
    const runs = asyncRunsDir(root);
    for (const runId of runIds(runs)) {
      const status = readStatus(join(runs, runId));
      if (!status || !isActiveState(status.state)) continue;
      if (!isRunnerAlive(status.pid)) continue;
      out.push(status);
    }
  }
  return out;
}

/**
 * True when any live background run belongs to one of these sessions (by Pi
 * session id) or was launched in one of these directories. Session ids are
 * unique per cwd, so both checks are needed.
 */
export function hasLiveRunFor(
  sessionIds: ReadonlySet<string>,
  cwds: ReadonlySet<string>,
  roots?: readonly string[],
): boolean {
  if (sessionIds.size === 0 && cwds.size === 0) return false;
  return activeRuns(roots).some(
    (run) => (run.sessionId !== undefined && sessionIds.has(run.sessionId)) || (run.cwd !== undefined && cwds.has(run.cwd)),
  );
}

function runIds(runsDir: string): string[] {
  try {
    return readdirSync(join(runsDir, ACTIVE_RUN_INDEX), { withFileTypes: true })
      .filter((entry) => !NOT_A_RUN.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    /* no index (older runs, or nothing has run yet): fall back to the runs dir */
  }
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, MAX_RUN_DIRS)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readStatus(dir: string): ActiveRun | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "status.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveRun> & { runId?: unknown; state?: unknown };
    if (typeof parsed.state !== "string") return undefined;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : basename(dir),
      dir,
      state: parsed.state as ActiveRun["state"],
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
    };
  } catch {
    // status.json is written atomically, so a parse failure means a foreign
    // file, not a torn write. Treat the run as unknown, not as finished.
    return undefined;
  }
}

// TODO(M3-T2): watchAsyncRuns(root): AsyncIterable<{ runId, status, event? }>
// TODO(M3-T3): watchForegroundTranscripts(sessionsDir)
// TODO(M3-T4): requestStop / requestSteer / requestInterrupt (control inbox JSON files)
