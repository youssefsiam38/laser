/**
 * `piorbit runs` — the fleet, in a terminal.
 *
 * The nouns are the app's nouns on purpose (D-19 §5): a **run** is a unit of
 * agent work with a lifecycle, a **plan** is the intended shape of several of
 * them, a **ledger** is the durable record. Different vocabulary in the
 * terminal and in the window would make piorbit feel like two products.
 *
 * The data is the host's panel data — the same `pi/panel/list` the app reads,
 * so a run shown here is the same object, with the same id, as the island in
 * the dock. This file therefore has no parser of its own and no idea where
 * pi-subagents keeps its files; if the host cannot see a run, neither can the
 * terminal, and that is the correct answer rather than a second opinion.
 */
import type { Panel, PlanPanel, RunPanel, SessionSummary } from "@piorbit/protocol";
import { bool, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { plural, shortCwd } from "../format.js";
import { sanitizeDeep, table } from "../output.js";
import { HostRpcError, describeRpcError, type HostRpc } from "../rpc.js";
import { listSessions, resolveProject } from "../session-ref.js";
import { connect } from "./host.js";

/** One run, joined to the session it belongs to. */
export interface RunRow {
  panel: RunPanel;
  session: SessionSummary;
}

export interface FleetSnapshot {
  runs: RunRow[];
  plans: Array<{ panel: PlanPanel; session: SessionSummary }>;
  /** Every panel, keyed by session path, for callers that want more (plan, missions). */
  bySession: Map<string, { session: SessionSummary; panels: Panel[] }>;
  /** Sessions whose panels could not be read, so a partial answer says so. */
  unreadable: number;
}

/** Sessions asked at once. The host answers from memory; this only bounds the socket. */
const CONCURRENCY = 8;

/**
 * Every panel the host holds, for the sessions we care about. A host that
 * predates the panel hub answers `Unsupported`; that is reported once, as a
 * sentence, rather than as one error per session.
 */
export async function readFleet(rpc: HostRpc, sessions: readonly SessionSummary[]): Promise<FleetSnapshot> {
  const bySession = new Map<string, { session: SessionSummary; panels: Panel[] }>();
  let unreadable = 0;
  let unsupported: HostRpcError | undefined;

  const queue = [...sessions];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let session = queue.shift(); session !== undefined; session = queue.shift()) {
      try {
        const { panels } = await rpc.request("pi/panel/list", { path: session.path });
        // Every string below this line is agent-authored: a run's title, a
        // plan step's label, a mission's summary. Escapes are stripped once,
        // here, rather than at each of the two dozen places they are printed
        // (`render.ts`: "a tool result is untrusted bytes").
        if (panels.length > 0) bySession.set(session.path, { session, panels: sanitizeDeep(panels) });
      } catch (error) {
        if (error instanceof HostRpcError && error.isUnsupported) unsupported = error;
        else unreadable += 1;
      }
    }
  });
  await Promise.all(workers);

  if (unsupported) {
    throw new CliError("this host does not keep panels, so it cannot list runs", {
      fix: "Update the host (`piorbit restart` after an upgrade) and try again.",
    });
  }

  const runs: RunRow[] = [];
  const plans: FleetSnapshot["plans"] = [];
  for (const { session, panels } of bySession.values()) {
    for (const panel of panels) {
      if (panel.kind === "run") runs.push({ panel, session });
      else if (panel.kind === "plan") plans.push({ panel, session });
    }
  }
  return { runs, plans, bySession, unreadable };
}

const LIVE = new Set<RunPanel["lifecycle"]>(["running", "queued"]);

/** Live first, then most recently started. The order a person scans in. */
export function orderRuns(rows: readonly RunRow[]): RunRow[] {
  const rank = (row: RunRow): number => (LIVE.has(row.panel.lifecycle) ? 0 : row.panel.lifecycle === "paused" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || started(b.panel) - started(a.panel));
}

const started = (panel: RunPanel): number => (panel.startedAt ? Date.parse(panel.startedAt) : 0);

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

export function elapsedOf(panel: RunPanel, now = Date.now()): number | undefined {
  const start = started(panel);
  if (!start) return undefined;
  const end = panel.endedAt ? Date.parse(panel.endedAt) : LIVE.has(panel.lifecycle) ? now : undefined;
  return end === undefined || Number.isNaN(end) ? undefined : Math.max(0, end - start);
}

/** Tokens and cost, or the words that say they were never measured (R8). */
export function usageCells(panel: RunPanel | PlanPanel): { tokens: string; cost: string } {
  const usage = panel.usage;
  if (usage === null) return { tokens: "not measured", cost: "—" };
  if (usage === undefined) return { tokens: "—", cost: "—" };
  const total = [usage.input, usage.output].filter((n): n is number => typeof n === "number").reduce((a, b) => a + b, 0);
  const counted = usage.input !== undefined || usage.output !== undefined;
  return {
    tokens: counted ? total.toLocaleString("en-US") : "not measured",
    cost:
      typeof usage.costUsd !== "number"
        ? "—"
        : usage.costUsd === 0
          ? "$0"
          : `$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 4 : 2)}`,
  };
}

const STATE_WORD: Record<RunPanel["lifecycle"], string> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

/** Colour follows the app's five states, and degrades to plain words in a pipe. */
export function paintState(lifecycle: RunPanel["lifecycle"], paint: CommandContext["term"]["out"]): string {
  const word = STATE_WORD[lifecycle];
  switch (lifecycle) {
    case "running":
    case "queued":
      return paint.cyan(word);
    case "failed":
      return paint.red(word);
    case "paused":
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
      fix: "`piorbit sessions` lists them; any unambiguous id or path suffix works.",
    });
  }
  return matched;
}

export const runsCommand: Command = {
  name: "runs",
  group: "Sessions",
  summary: "list agent runs — subagents, workflows and background jobs",
  usage: "piorbit runs [--project <dir>] [--session <ref>] [--running] [--json]",
  description: `
A run is one unit of agent work with a lifecycle: a subagent, a workflow lane,
a background job, or a run another extension contributed. Children are listed
under the session that started them, not as sessions of their own.

Reads the host's panels, so this is exactly what the app shows — including runs
started from a terminal, which the host sees through pi-subagents' files.

Controls are honest: a run that cannot be steered from here is not offered a
steer. Use \`piorbit plan\` for the shape of a multi-step run.`,
  flags: {
    project: { type: "string", description: "only runs in this project directory" },
    session: { type: "string", description: "only runs in this session (id, path, or suffix)" },
    running: { type: "boolean", description: "only runs that are still going" },
  },
  examples: [
    { command: "piorbit runs", note: "every run the host can see" },
    { command: "piorbit runs --running --json", note: "machine-readable, live only" },
  ],
  async run(ctx) {
    const rpc = await connect(ctx.paths);
    try {
      const sessions = await sessionsInScope(rpc, ctx);
      const fleet = await readFleet(rpc, sessions);
      const onlyLive = bool(ctx.args, "running");
      const rows = orderRuns(fleet.runs).filter((row) => !onlyLive || LIVE.has(row.panel.lifecycle));

      ctx.term.data({
        runs: rows.map(({ panel, session }) => ({
          id: panel.id,
          title: panel.title,
          handle: panel.handle ?? null,
          lifecycle: panel.lifecycle,
          terminalReason: panel.terminalReason ?? null,
          activity: panel.activity ?? null,
          model: panel.model ?? null,
          requested: panel.requested ?? null,
          origin: panel.origin ?? null,
          parent: panel.parent ?? null,
          startedAt: panel.startedAt ?? null,
          endedAt: panel.endedAt ?? null,
          elapsedMs: elapsedOf(panel) ?? null,
          usage: panel.usage ?? null,
          actions: (panel.actions ?? []).map((action) => action.id),
          session: { path: session.path, cwd: session.cwd, id: session.id },
        })),
        unreadableSessions: fleet.unreadable,
      });

      if (rows.length === 0) {
        ctx.term.print(onlyLive ? "Nothing is running." : "No runs. Start one from a session, and it will show up here.");
        return ExitCode.Ok;
      }

      const now = Date.now();
      for (const line of table(
        rows,
        [
          { header: "state", get: (row) => paintState(row.panel.lifecycle, ctx.term.out) },
          { header: "run", get: (row) => row.panel.title },
          { header: "agent", get: (row) => row.panel.handle ?? "—" },
          { header: "model", get: (row) => row.panel.model ?? "—" },
          { header: "elapsed", get: (row) => { const ms = elapsedOf(row.panel, now); return ms === undefined ? "—" : formatElapsed(ms); }, align: "right" },
          { header: "tokens", get: (row) => usageCells(row.panel).tokens, align: "right" },
          { header: "cost", get: (row) => usageCells(row.panel).cost, align: "right" },
          { header: "project", get: (row) => shortCwd(row.session.cwd) },
        ],
        ctx.term.out,
      )) {
        ctx.term.print(line);
      }

      const live = rows.filter((row) => LIVE.has(row.panel.lifecycle)).length;
      ctx.term.note("");
      ctx.term.note(ctx.term.err.dim(`${plural(rows.length, "run")}, ${live} still going`));
      if (fleet.unreadable > 0) {
        ctx.term.warn(`${plural(fleet.unreadable, "session")} could not be read; this list is incomplete.`);
      }
      return ExitCode.Ok;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw describeRpcError(error, "could not list runs");
    } finally {
      rpc.close();
    }
  },
};
