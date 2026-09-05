/**
 * `piorbit logs` — the host's low-level log store from a terminal (M9-T7).
 *
 * The store lives in the host (`pi/logs/*`), so this sees exactly what the
 * Logs page sees: provider round-trips, tool executions, session events,
 * subagent events and worker output, across every project.
 *
 * `--follow` polls `afterId` rather than subscribing to `pi/logs/append`: the
 * host batches appends on a tick and a client that connects mid-turn would
 * otherwise miss everything already written. Polling from a known id has no
 * such gap, and one query per second costs nothing against SQLite.
 */
import type { LogEntry, LogLevel, LogSection } from "@piorbit/protocol";
import { bool, list, num, str } from "../args.js";
import type { Command } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { clip } from "../format.js";
import { sanitize, type Terminal } from "../output.js";
import { describeRpcError, type HostRpc } from "../rpc.js";
import { resolveProject, resolveSession } from "../session-ref.js";
import { connect } from "./host.js";

const SECTIONS: readonly LogSection[] = ["provider", "tools", "session", "subagents", "host"];
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const FOLLOW_INTERVAL_MS = 1000;

function parseChoices<T extends string>(values: readonly string[], allowed: readonly T[], what: string): T[] {
  const chosen: T[] = [];
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new CliError(`unknown ${what} ${JSON.stringify(value)}`, {
        exitCode: ExitCode.Usage,
        fix: `Use one or more of: ${allowed.join(", ")}.`,
      });
    }
    chosen.push(value as T);
  }
  return chosen;
}

function paintLevel(level: LogLevel, term: Terminal): string {
  const label = level.padEnd(5);
  if (level === "error") return term.out.red(label);
  if (level === "warn") return term.out.yellow(label);
  if (level === "debug") return term.out.dim(label);
  return label;
}

export const logsCommand: Command = {
  name: "logs",
  group: "Diagnostics",
  summary: "read the host's provider, tool and session logs",
  usage:
    "piorbit logs [--follow] [--section <s,…>] [--level <l,…>] [--search <text>] " +
    "[--session <id>] [--project <dir>] [--limit <n>] [--detail] [--stats] [--clear --yes]",
  description: `
Every provider round-trip, tool execution, session event and worker line the
host recorded, newest last. The same store the Logs page reads.

Pi 0.85 hands extensions the complete provider *request* but only the
response's status and headers — there is no raw-body hook — so a response row
carries no body. The assistant's actual output is in the session section.

Use --detail to print the full payload of each row (large; pipe it), or
\`--stats\` for what the store holds.

With --json this prints one JSON object; with --follow it streams NDJSON, one
row per line. --clear deletes rows and needs --yes; it can only narrow by
--section, because that is all the store can delete by.
`,
  flags: {
    follow: { type: "boolean", short: "f", description: "Keep printing new rows until interrupted" },
    section: {
      type: "string",
      description: `Comma-separated: ${SECTIONS.join(", ")}`,
      placeholder: "<s,…>",
      repeat: true,
    },
    level: { type: "string", description: `Comma-separated: ${LEVELS.join(", ")}`, placeholder: "<l,…>", repeat: true },
    search: { type: "string", description: "Case-insensitive substring over the summary and payload", placeholder: "<text>" },
    session: { type: "string", short: "s", description: "Only rows for this session (id or path)", placeholder: "<id>" },
    project: { type: "string", short: "P", description: "Only rows for this project directory", placeholder: "<dir>" },
    limit: { type: "number", short: "n", default: 100, description: "How many rows to print before following", placeholder: "<n>" },
    detail: { type: "boolean", description: "Print each row's full payload, fetching it when stored out of line" },
    stats: { type: "boolean", description: "Show what the store holds instead of rows" },
    clear: { type: "boolean", description: "Delete rows (only --section narrows it) instead of printing them" },
    yes: { type: "boolean", short: "y", description: "Skip the confirmation --clear otherwise requires" },
  },
  examples: [
    { note: "the last hundred rows", command: "piorbit logs" },
    { note: "watch provider traffic live", command: "piorbit logs --follow --section provider" },
    { note: "find a failing tool call", command: "piorbit logs --section tools --level error --detail" },
  ],
  async run({ term, paths, args }) {
    const sections = parseChoices(list(args, "section").flatMap((v) => v.split(",")).filter(Boolean), SECTIONS, "log section");
    const levels = parseChoices(list(args, "level").flatMap((v) => v.split(",")).filter(Boolean), LEVELS, "log level");
    const rpc = await connect(paths);

    try {
      if (bool(args, "stats")) {
        const { stats } = await rpc.request("pi/logs/stats", {}).catch((error: unknown) => {
          throw describeRpcError(error, "could not read log statistics");
        });
        if (term.json) {
          term.data({ stats });
          return;
        }
        term.print(`${stats.total} rows, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
        for (const section of SECTIONS) term.print(`  ${section.padEnd(10)} ${stats.bySection[section] ?? 0}`);
        if (stats.oldestAt) term.note(term.err.dim(`oldest ${stats.oldestAt} · newest ${stats.newestAt ?? "—"}`));
        term.note(
          term.err.dim(
            `keeps ${stats.retention.maxRows} rows / ${stats.retention.maxAgeDays} days · provider response bodies: ${stats.providerResponseBodies}`,
          ),
        );
        return;
      }

      if (bool(args, "clear")) {
        // The store deletes by section and nothing else. Accepting a filter it
        // cannot honour and then wiping everything is the worst possible answer.
        const ignored = (["level", "search", "session", "project"] as const).filter(
          (flag) => (flag === "level" ? levels.length > 0 : str(args, flag) !== undefined),
        );
        if (ignored.length > 0) {
          throw new CliError(`--clear cannot narrow by ${ignored.map((f) => `--${f}`).join(", ")}`, {
            exitCode: ExitCode.Usage,
            fix: "The store only deletes whole sections: `piorbit logs --clear --section provider --yes`.",
          });
        }
        const { stats } = await rpc.request("pi/logs/stats", {}).catch((error: unknown) => {
          throw describeRpcError(error, "could not read log statistics");
        });
        const doomed =
          sections.length > 0 ? sections.reduce((n, s) => n + (stats.bySection[s] ?? 0), 0) : stats.total;
        const scope = sections.length > 0 ? sections.join(", ") : "every section";
        if (!bool(args, "yes")) {
          throw new CliError(`this would permanently delete ${doomed} log rows from ${scope}`, {
            exitCode: ExitCode.Usage,
            fix: `Nothing was deleted. Re-run with --yes to confirm: \`piorbit logs --clear${
              sections.length > 0 ? ` --section ${sections.join(",")}` : ""
            } --yes\`.`,
          });
        }
        const { deleted } = await rpc
          .request("pi/logs/clear", { ...(sections.length > 0 ? { sections } : {}) })
          .catch((error: unknown) => {
            throw describeRpcError(error, "could not clear the log store");
          });
        if (term.json) term.data({ deleted, sections: sections.length > 0 ? sections : null });
        else term.note(`${term.err.green("cleared")} ${deleted} rows${sections.length > 0 ? ` in ${sections.join(", ")}` : ""}`);
        return;
      }

      const project = resolveProject(str(args, "project"));
      // Every other verb takes an id or an unambiguous suffix here; taking only
      // a raw path would make this the one command that does not.
      const sessionRef = str(args, "session");
      const sessionPath =
        sessionRef === undefined
          ? undefined
          : (await resolveSession(rpc, sessionRef, { ...(project !== undefined ? { cwd: project } : {}) })).path;

      const filter = {
        ...(sections.length > 0 ? { sections } : {}),
        ...(levels.length > 0 ? { levels } : {}),
        ...(str(args, "search") ? { search: str(args, "search") as string } : {}),
        ...(sessionPath !== undefined ? { sessionPath } : {}),
        ...(project !== undefined ? { cwd: project } : {}),
      };
      const limit = num(args, "limit") ?? 100;
      const detail = bool(args, "detail");
      const follow = bool(args, "follow");

      const page = await rpc.request("pi/logs/query", { ...filter, limit }).catch((error: unknown) => {
        throw describeRpcError(error, "could not read the logs");
      });

      // `--json` without `--follow` is one JSON value, per the CLI's own
      // contract; a script must be able to tell "no rows" from "it crashed".
      if (term.json && !follow) {
        const entries = detail
          ? await Promise.all(page.entries.map(async (e) => ({ ...e, detail: await payloadOf(rpc, e) })))
          : page.entries;
        term.data({ entries, hasMore: page.hasMore, ...(page.newestId !== undefined ? { newestId: page.newestId } : {}) });
        return;
      }

      for (const entry of page.entries) await emit(rpc, term, entry, detail);

      if (!follow) {
        if (page.entries.length === 0) {
          term.note("no log rows match");
          term.note();
          term.note(`  The store fills as sessions run. ${term.err.bold("piorbit logs --stats")} shows what it holds.`);
        } else if (page.hasMore) {
          term.note(term.err.dim(`more rows exist before this page; raise --limit to see them`));
        }
        return;
      }

      // --- follow ---
      let afterId = page.newestId ?? 0;
      let stop = false;
      const onSignal = () => {
        stop = true;
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      if (!term.json) term.note(term.err.dim("following — press Ctrl-C to stop"));

      try {
        while (!stop) {
          await new Promise((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS));
          if (stop) break;
          const next = await rpc.request("pi/logs/query", { ...filter, afterId, limit: 500 }).catch((error: unknown) => {
            throw describeRpcError(error, "the log tail stopped");
          });
          for (const entry of next.entries) await emit(rpc, term, entry, detail);
          if (next.newestId !== undefined) afterId = next.newestId;
        }
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    } finally {
      rpc.close();
    }
  },
};

/** One row. `--json` streams NDJSON so `piorbit logs -f --json | jq` works. */
async function emit(
  rpc: HostRpc,
  term: Terminal,
  entry: LogEntry,
  detail: boolean,
): Promise<void> {
  const full = detail ? await payloadOf(rpc, entry) : undefined;

  if (term.json) {
    term.record(full === undefined ? entry : { ...entry, detail: full });
    return;
  }

  const summary = sanitize(entry.summary);
  const bits = [
    term.out.dim(clockTime(entry.at)),
    paintLevel(entry.level, term),
    term.out.dim(entry.section.padEnd(9)),
    entry.kind.padEnd(18),
    clip(summary, 100),
  ];
  // Provider rows already read "HTTP 200 · 13 ms"; repeating it as "[200] 13ms"
  // is noise, not columns.
  if (entry.status !== undefined && !summary.includes(String(entry.status))) {
    bits.push(term.out.dim(`[${entry.status}]`));
  }
  const ms = entry.durationMs === undefined ? undefined : Math.round(entry.durationMs);
  if (ms !== undefined && !summary.includes(`${ms} ms`) && !summary.includes(`${ms}ms`)) {
    bits.push(term.out.dim(`${ms}ms`));
  }
  term.print(bits.join(" "));

  if (full !== undefined) {
    const text = typeof full === "string" ? full : JSON.stringify(full, null, 2);
    for (const line of sanitize(text).split("\n")) term.print(`    ${line}`);
  }
}

/** Local wall-clock time, so the terminal and the Logs page agree. */
function clockTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(11, 19);
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Inline detail when the store kept it, otherwise the content-addressed blob.
 * A missing blob is reported, not silently dropped: retention can collect the
 * payload while the row survives, and that is worth saying once per row.
 */
async function payloadOf(rpc: HostRpc, entry: LogEntry): Promise<unknown> {
  if (entry.detail !== undefined) return entry.detail;
  if (!entry.detailRef) return undefined;
  try {
    const { text, truncated } = await rpc.request("pi/logs/content", { ref: entry.detailRef.ref });
    return truncated ? `${text}\n… truncated` : text;
  } catch (error) {
    return `<payload unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}
