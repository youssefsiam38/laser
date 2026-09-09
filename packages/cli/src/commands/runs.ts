/**
 * `laser runs` — the fleet, in a terminal.
 *
 * The nouns are the app's nouns on purpose: a **run** is one execution of an
 * agent inside its own session, and a **task** is a long command the agent left
 * running. Different vocabulary in the terminal and in the window would make
 * laser feel like two products, so this is the same two lists the fleet column
 * draws, from the same two typed sources — `agents/runs/list` and `tasks/list`.
 *
 * No parser of its own, and no idea where anything keeps its files: if the host
 * cannot see a run, neither can the terminal, and that is the correct answer
 * rather than a second opinion.
 */
import { PRODUCT_NAME, isTerminalRunStatus } from "@lasercode/protocol";
import type { AgentRun, AgentRunStatus, BackgroundTask, SessionSummary } from "@lasercode/protocol";
import { bool, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { plural, shortCwd } from "../format.js";
import { sanitizeDeep, table } from "../output.js";
import { HostRpcError, describeRpcError, type HostRpc } from "../rpc.js";
import { listSessions, resolveProject } from "../session-ref.js";
import { connect } from "./host.js";

/** One line of the fleet: an agent run or a background task, joined to its session. */
export interface FleetRow {
  kind: "agent" | "task";
  /** `runId` or `taskId`. */
  id: string;
  title: string;
  /** The subagent's name, or the task's id — what you would address it by. */
  handle: string | null;
  state: FleetState;
  live: boolean;
  model: string | null;
  activity: string | null;
  terminalReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  session: SessionSummary;
  run?: AgentRun;
  task?: BackgroundTask;
}

export type FleetState = AgentRunStatus | BackgroundTask["status"];

export interface FleetSnapshot {
  rows: FleetRow[];
  /** True when the host is too old to answer one of the two lists. */
  partial: boolean;
}

/**
 * Every run and task the host holds, for the sessions in scope. Both lists are
 * one request each — the host answers from memory — so this does not fan out
 * per session the way reading files would.
 */
export async function readFleet(rpc: HostRpc, sessions: readonly SessionSummary[]): Promise<FleetSnapshot> {
  const inScope = new Map(sessions.map((session) => [session.path, session]));
  let partial = false;

  const ask = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HostRpcError && error.isUnsupported) {
        partial = true;
        return fallback;
      }
      throw error;
    }
  };

  const { runs } = await ask(() => rpc.request("agents/runs/list", {}), { runs: [] as AgentRun[] });
  const { tasks } = await ask(() => rpc.request("tasks/list", {}), { tasks: [] as BackgroundTask[] });

  // Every string below this line is agent-authored: a subagent's name, a task's
  // command, a run's activity label. Escapes are stripped once, here, rather
  // than at each place they are printed (`render.ts`: untrusted bytes).
  const rows: FleetRow[] = [];
  for (const run of sanitizeDeep(runs)) {
    const session = inScope.get(run.sessionPath);
    if (!session) continue;
    rows.push({
      kind: "agent",
      id: run.runId,
      title: run.subagentName || run.agentName,
      handle: run.subagentName || null,
      state: run.status,
      live: !isTerminalRunStatus(run.status),
      model: run.model ? `${run.model.provider}/${run.model.id}` : null,
      activity: run.activity?.label ?? (run.activity?.currentTool ? `Running ${run.activity.currentTool}` : null),
      terminalReason: reasonOfRun(run),
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      session,
      run,
    });
  }
  for (const task of sanitizeDeep(tasks)) {
    const session = inScope.get(task.sessionPath);
    if (!session) continue;
    rows.push({
      kind: "task",
      id: task.id,
      title: task.title,
      handle: task.id,
      state: task.status,
      live: task.status === "running",
      model: null,
      activity: task.activity ?? null,
      terminalReason: task.terminalReason ?? null,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
      session,
      task,
    });
  }
  return { rows, partial };
}

function reasonOfRun(run: AgentRun): string | null {
  if (run.endedBy?.reason) return run.endedBy.reason;
  if (run.error) return run.error;
  if (run.status === "cancelled") return run.endedBy?.initiator === "user" ? "you ended it" : "the parent ended it";
  return null;
}

/** Live first, then most recently started. The order a person scans in. */
export function orderRuns(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => Number(b.live) - Number(a.live) || started(b) - started(a));
}

const started = (row: FleetRow): number => {
  const value = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);
  return Number.isNaN(value) ? 0 : value;
};

/**
 * Elapsed in the coarse form the app uses. `render.ts`'s `formatDuration` stops
 * at minutes, and an agent run measured in minutes past the thousand is a
 * number nobody can read: 21h 40m is the same fact, legibly.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

export function elapsedOf(row: FleetRow, now = Date.now()): number | undefined {
  const start = started(row);
  if (!start) return undefined;
  const end = row.endedAt ? Date.parse(row.endedAt) : row.live ? now : undefined;
  return end === undefined || Number.isNaN(end) ? undefined : Math.max(0, end - start);
}

const STATE_WORD: Readonly<Record<FleetState, string>> = {
  queued: "queued",
  running: "running",
  blocked: "blocked",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
  stopped: "stopped",
};

/** Colour follows the app's five states, and degrades to plain words in a pipe. */
export function paintState(state: FleetState, paint: CommandContext["term"]["out"]): string {
  const word = STATE_WORD[state] ?? state;
  switch (state) {
    case "running":
    case "queued":
      return paint.cyan(word);
    case "failed":
      return paint.red(word);
    case "blocked":
      return paint.yellow(word);
    default:
      return paint.dim(word);
  }
}

/** Sessions in scope: one project, one session, or everything the host knows. */
export async function sessionsInScope(rpc: HostRpc, ctx: CommandContext): Promise<SessionSummary[]> {
  const cwd = resolveProject(str(ctx.args, "project"));
  const sessions = await listSessions(rpc, cwd);
  const reference = str(ctx.args, "session");
  if (reference === undefined) return sessions;
  const matched = sessions.filter((session) => session.path === reference || session.id.startsWith(reference) || session.path.endsWith(reference));
  if (matched.length === 0) {
    throw new CliError(`no session matches ${JSON.stringify(reference)}`, {
      exitCode: ExitCode.Usage,
      fix: `\`${PRODUCT_NAME} sessions\` lists them; any unambiguous id or path suffix works.`,
    });
  }
  return matched;
}

export const runsCommand: Command = {
  name: "runs",
  group: "Sessions",
  summary: "list agent work — child agents and background commands",
  usage: `${PRODUCT_NAME} runs [--project <dir>] [--session <ref>] [--running] [--json]`,
  description: `
Two kinds of thing, one list, exactly as the fleet column shows them: a **run**
is one execution of an agent in its own child session, and a **task** is a long
command an agent left running in the background.

A child is listed under the session that started it, not as a session of its
own. The data is the host's own — the run registry and the task register — so
this is exactly what the app shows.`,
  flags: {
    project: { type: "string", description: "only work in this project directory" },
    session: { type: "string", description: "only work in this session (id, path, or suffix)" },
    running: { type: "boolean", description: "only work that is still going" },
  },
  examples: [
    { command: `${PRODUCT_NAME} runs`, note: "every run and task the host can see" },
    { command: `${PRODUCT_NAME} runs --running --json`, note: "machine-readable, live only" },
  ],
  async run(ctx) {
    const rpc = await connect(ctx.paths);
    try {
      const sessions = await sessionsInScope(rpc, ctx);
      const fleet = await readFleet(rpc, sessions);
      const onlyLive = bool(ctx.args, "running");
      const rows = orderRuns(fleet.rows).filter((row) => !onlyLive || row.live);

      ctx.term.data({
        runs: rows.map((row) => ({
          kind: row.kind,
          id: row.id,
          title: row.title,
          handle: row.handle,
          state: row.state,
          live: row.live,
          terminalReason: row.terminalReason,
          activity: row.activity,
          model: row.model,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          elapsedMs: elapsedOf(row) ?? null,
          exitCode: row.task?.exitCode ?? null,
          parent: row.run?.parent ?? null,
          worktree: row.run?.worktree ?? null,
          // Where the work happens, either way: an agent started without a
          // worktree works in its parent's checkout and has no branch.
          cwd: row.run?.cwd ?? null,
          session: { path: row.session.path, cwd: row.session.cwd, id: row.session.id },
        })),
      });

      if (rows.length === 0) {
        ctx.term.print(onlyLive ? "Nothing is running." : "No agent work. Start an agent from a session, and it will show up here.");
        return ExitCode.Ok;
      }

      const now = Date.now();
      for (const line of table(
        rows,
        [
          { header: "state", get: (row) => paintState(row.state, ctx.term.out) },
          { header: "kind", get: (row) => (row.kind === "agent" ? "agent" : "task") },
          { header: "what", get: (row) => row.title },
          { header: "name", get: (row) => row.handle ?? "—" },
          { header: "model", get: (row) => row.model ?? "—" },
          { header: "elapsed", get: (row) => { const ms = elapsedOf(row, now); return ms === undefined ? "—" : formatElapsed(ms); }, align: "right" },
          { header: "project", get: (row) => shortCwd(row.session.cwd) },
        ],
        ctx.term.out,
      )) {
        ctx.term.print(line);
      }

      const live = rows.filter((row) => row.live).length;
      ctx.term.note("");
      ctx.term.note(ctx.term.err.dim(`${plural(rows.length, "item")}, ${live} still going`));
      if (fleet.partial) {
        ctx.term.warn(`This host is older than one of the two lists, so this is incomplete. Restart it (\`${PRODUCT_NAME} restart\`) after an upgrade.`);
      }
      return ExitCode.Ok;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw describeRpcError(error, "could not list agent work");
    } finally {
      rpc.close();
    }
  },
};
