/**
 * `laser missions` — the durable record.
 *
 * A mission outlives the runs it joins, the session that started it, and
 * several compactions; it is the third noun (D-19) and the only one that is
 * still there tomorrow. The host reads `~/.pi/agent/missions` and publishes
 * each session's missions as one `collection` panel, so this command lists
 * rows and `laser missions show <id>` asks the host to render one ledger —
 * the same action the app fires when you open a row.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import type { CollectionItem, CollectionPanel, DocumentPanel, SessionSummary } from "@lasercode/protocol";
import type { Command } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { clip, plural, shortCwd } from "../format.js";
import { sanitizeDeep, table } from "../output.js";
import { describeRpcError } from "../rpc.js";
import { connect } from "./host.js";
import { readFleet, sessionsInScope } from "./runs.js";

/** The id the host gives a session's mission list. Matches `@lasercode/host` `missionCollectionId`. */
const MISSIONS_PANEL_ID = "subagents:missions";
const MISSION_DOCUMENT_PREFIX = "subagents:mission:";

export interface MissionRow {
  item: CollectionItem;
  session: SessionSummary;
}

const metaOf = (item: CollectionItem, label: string): string | undefined =>
  item.meta?.find((entry) => entry.label === label)?.value;

/** Every mission the host holds, newest first (the host already sorts them). */
export function missionRows(
  bySession: ReadonlyMap<string, { session: SessionSummary; panels: readonly { kind: string; id: string }[] }>,
): MissionRow[] {
  const rows: MissionRow[] = [];
  for (const { session, panels } of bySession.values()) {
    const collection = panels.find((panel) => panel.id === MISSIONS_PANEL_ID && panel.kind === "collection") as
      | CollectionPanel
      | undefined;
    for (const item of collection?.items ?? []) rows.push({ item, session });
  }
  return rows;
}

const VERBS = new Set(["list", "show"]);

export const missionsCommand: Command = {
  name: "missions",
  group: "Sessions",
  summary: "list the mission ledger, and read one",
  usage: `${PRODUCT_NAME} missions [list] [--project <dir>] | ${PRODUCT_NAME} missions show <id> [--json]`,
  description: `
A mission is the durable record of a piece of work: its objective, the runs it
spawned, the decisions taken along the way, the artifacts left behind, and the
summary the agent wrote at the end.

\`${PRODUCT_NAME} missions\` lists them. \`${PRODUCT_NAME} missions show <id>\` prints one ledger
as markdown — the same document the app opens when you pick a row, rendered by
the host, so the terminal and the window never disagree about what happened.

A mission whose owning session no longer exists on disk is not listed: the
ledger is joined to its session, and a mission with nowhere to hang is history
rather than state.`,
  positionals: [
    { name: "verb", description: "`list` (default) or `show`", optional: true },
    { name: "id", description: "with `show`: the mission id, or any unambiguous part of it", optional: true },
  ],
  flags: {
    project: { type: "string", description: "only missions in this project directory" },
  },
  examples: [
    { command: `${PRODUCT_NAME} missions`, note: "every mission the host can see" },
    { command: `${PRODUCT_NAME} missions show 21507fe0`, note: "one ledger, as markdown" },
  ],
  async run(ctx) {
    const [first, second] = ctx.args.positionals;
    const verb = first !== undefined && VERBS.has(first) ? first : "list";
    const reference = verb === "show" ? second : first;

    if (verb === "show" && reference === undefined) {
      throw new CliError("show needs a mission id", {
        exitCode: ExitCode.Usage,
        fix: `\`${PRODUCT_NAME} missions\` lists them; any unambiguous part of an id works.`,
      });
    }

    const rpc = await connect(ctx.paths);
    try {
      const sessions = await sessionsInScope(rpc, ctx);
      const fleet = await readFleet(rpc, sessions);
      const rows = missionRows(fleet.bySession);

      if (verb === "list") {
        ctx.term.data({
          missions: rows.map(({ item, session }) => ({
            id: item.id,
            title: item.primary,
            updated: item.secondary ?? null,
            status: metaOf(item, "status") ?? null,
            runs: Number(metaOf(item, "runs") ?? 0),
            decisions: Number(metaOf(item, "decisions") ?? 0),
            session: { path: session.path, cwd: session.cwd, id: session.id },
          })),
        });
        if (rows.length === 0) {
          ctx.term.print("No missions. One is written whenever an agent starts a named piece of work.");
          return ExitCode.Ok;
        }
        for (const line of table(
          rows,
          [
            { header: "status", get: (row) => metaOf(row.item, "status") ?? "—" },
            { header: "mission", get: (row) => clip(row.item.primary, 60) },
            { header: "runs", get: (row) => metaOf(row.item, "runs") ?? "0", align: "right" },
            { header: "updated", get: (row) => (row.item.secondary ?? "").replace(/^updated /, "") },
            { header: "project", get: (row) => shortCwd(row.session.cwd) },
            { header: "id", get: (row) => row.item.id.slice(0, 8) },
          ],
          ctx.term.out,
        )) {
          ctx.term.print(line);
        }
        ctx.term.note("");
        ctx.term.note(ctx.term.err.dim(`${plural(rows.length, "mission")} · \`${PRODUCT_NAME} missions show <id>\` reads one`));
        return ExitCode.Ok;
      }

      // show
      const matched = rows.filter((row) => row.item.id === reference || row.item.id.startsWith(reference!));
      if (matched.length === 0) {
        throw new CliError(`no mission matches ${JSON.stringify(reference)}`, {
          fix: `\`${PRODUCT_NAME} missions\` lists them. A mission whose session is gone is not listed.`,
        });
      }
      if (matched.length > 1) {
        throw new CliError(`${JSON.stringify(reference)} matches ${matched.length} missions`, {
          exitCode: ExitCode.Usage,
          details: matched.slice(0, 8).map((row) => `${row.item.id}  ${clip(row.item.primary, 60)}`),
          fix: "Use a longer id.",
        });
      }

      const { item, session } = matched[0]!;
      // The same action the app fires when a row is opened: the host renders
      // the ledger and publishes it as a document panel for this session.
      const { delivered } = await rpc.request("pi/panel/action", {
        path: session.path,
        id: MISSIONS_PANEL_ID,
        actionId: "open",
        value: item.id,
      });
      if (!delivered) {
        throw new CliError("the host would not open that mission", {
          fix: `It may have just been pruned. Run \`${PRODUCT_NAME} missions\` again.`,
        });
      }

      // A second list, so it needs the same pass `readFleet` makes: the
      // ledger below is markdown an agent wrote, printed straight to a
      // terminal.
      const { panels } = sanitizeDeep(await rpc.request("pi/panel/list", { path: session.path }));
      const document = panels.find((panel) => panel.id === `${MISSION_DOCUMENT_PREFIX}${item.id}`) as DocumentPanel | undefined;
      const inline = document?.content && "inline" in document.content ? document.content.inline : undefined;
      if (!inline) {
        throw new CliError("the host opened that mission but sent no text", {
          fix: `Check the host log (\`${PRODUCT_NAME} logs\`); the ledger file may be unreadable.`,
        });
      }

      ctx.term.data({
        id: item.id,
        title: document?.title ?? item.primary,
        path: document?.path ?? null,
        mediaType: document?.mediaType ?? "text/markdown",
        markdown: inline,
        session: { path: session.path, cwd: session.cwd, id: session.id },
      });
      ctx.term.print(inline.trimEnd());
      if (document?.path) ctx.term.note(ctx.term.err.dim(document.path));
      return ExitCode.Ok;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw describeRpcError(error, "could not read the missions ledger");
    } finally {
      rpc.close();
    }
  },
};
