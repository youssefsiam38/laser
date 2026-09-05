/**
 * `piorbit projects` — the project list the app shows, edited from a terminal.
 *
 * The list lives in the host (`pi/project/*`), not in this process, so adding a
 * project here makes it appear in an open browser tab without a reload. When a
 * host build predates those calls, the list is still shown — derived from the
 * session catalog — and only the mutating verbs refuse, with the reason.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { resolve } from "node:path";
import type { ProjectInfo, WorkerInfo } from "@piorbit/protocol";
import { bool } from "../args.js";
import type { Command } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { ago, plural, shortCwd } from "../format.js";
import { table } from "../output.js";
import { HostRpcError, describeRpcError, type HostRpc } from "../rpc.js";
import { listSessions } from "../session-ref.js";
import { connect } from "./host.js";

const VERBS = ["list", "add", "remove", "trust"] as const;
type Verb = (typeof VERBS)[number];

function verbOf(positionals: readonly string[]): { verb: Verb; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { verb: "list", rest: [] };
  if ((VERBS as readonly string[]).includes(first)) return { verb: first as Verb, rest };
  throw new CliError(`unknown projects verb ${JSON.stringify(first)}`, {
    exitCode: ExitCode.Usage,
    fix: `Use one of: ${VERBS.join(", ")}. \`${PRODUCT_NAME} projects\` on its own lists them.`,
  });
}

async function workersByCwd(rpc: HostRpc): Promise<Map<string, WorkerInfo>> {
  try {
    const { workers } = await rpc.request("pi/worker/list", {});
    return new Map(workers.map((worker) => [worker.cwd, worker]));
  } catch {
    return new Map();
  }
}

/** The registry, or a catalog-derived stand-in on a host that lacks it. */
async function readProjects(rpc: HostRpc): Promise<{ projects: ProjectInfo[]; derived: boolean }> {
  try {
    const { projects } = await rpc.request("pi/project/list", {});
    return { projects, derived: false };
  } catch (error) {
    if (!(error instanceof HostRpcError)) throw describeRpcError(error, "could not list projects");
    const sessions = await listSessions(rpc);
    const counts = new Map<string, { count: number; lastUsedAt: string }>();
    for (const session of sessions) {
      const current = counts.get(session.cwd);
      if (!current) counts.set(session.cwd, { count: 1, lastUsedAt: session.modifiedAt });
      else {
        current.count += 1;
        if (session.modifiedAt > current.lastUsedAt) current.lastUsedAt = session.modifiedAt;
      }
    }
    const projects: ProjectInfo[] = [...counts.entries()]
      .map(([cwd, { count, lastUsedAt }]) => ({
        cwd,
        name: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
        addedAt: lastUsedAt,
        lastUsedAt,
        trust: "unknown" as const,
        pinned: false,
        sessionCount: count,
      }))
      .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
    return { projects, derived: true };
  }
}

export const projectsCommand: Command = {
  name: "projects",
  group: "Projects",
  summary: "list, add and remove the projects the app shows",
  usage: `${PRODUCT_NAME} projects [list|add <dir>|remove <dir>|trust <dir> [--no]]`,
  description: `
A project is a directory ${PRODUCT_NAME} runs an agent in — one agent per directory,
never two. Adding one pins it so it stays in the sidebar even before it has any
sessions.

\`trust\` answers the project-trust question for a directory: whether the agent
may load that project's own configuration, extensions and skills. \`--no\`
declines.
`,
  positionals: [
    { name: "verb", description: "list (default), add, remove, trust", optional: true },
    { name: "dir", description: "Project directory", optional: true },
  ],
  flags: {
    no: { type: "boolean", description: "With `trust`: decline instead of trusting" },
    remember: { type: "boolean", default: true, description: "With `trust`: persist the answer" },
  },
  examples: [
    { note: "what the app shows", command: `${PRODUCT_NAME} projects` },
    { note: "pin this directory", command: `${PRODUCT_NAME} projects add .` },
    { note: "trust a project's own .pi resources", command: `${PRODUCT_NAME} projects trust ~/code/api` },
  ],
  async run({ term, paths, args }) {
    const { verb, rest } = verbOf(args.positionals);
    const rpc = await connect(paths);
    try {
      if (verb === "list") {
        const { projects, derived } = await readProjects(rpc);
        const workers = await workersByCwd(rpc);

        if (term.json) {
          term.data({ projects, workers: [...workers.values()], derived });
          return;
        }
        if (derived) {
          term.warn("this host has no project registry yet; showing the directories your sessions are in");
        }
        if (projects.length === 0) {
          term.note("no projects yet");
          term.note();
          term.note(`  Add one with ${term.err.bold(`${PRODUCT_NAME} projects add .`)}`);
          return;
        }
        for (const line of table(
          projects,
          [
            { header: "project", get: (project) => shortCwd(project.cwd) },
            { header: "sessions", get: (project) => String(project.sessionCount), align: "right" },
            { header: "worker", get: (project) => describeWorker(workers.get(project.cwd)) },
            { header: "trust", get: (project) => project.trust },
            { header: "last used", get: (project) => (project.lastUsedAt ? ago(project.lastUsedAt) : "—") },
          ],
          term.out,
        )) {
          term.print(line);
        }
        return;
      }

      const dir = rest[0];
      if (!dir) {
        throw new CliError(`\`projects ${verb}\` needs a directory`, {
          exitCode: ExitCode.Usage,
          fix: `Write it as \`${PRODUCT_NAME} projects ${verb} <dir>\` (\`.\` for the current one).`,
        });
      }
      const cwd = resolve(dir);

      if (verb === "add") {
        const { project } = await rpc.request("pi/project/add", { cwd }).catch((error: unknown) => {
          throw describeRpcError(error, `could not add ${cwd}`);
        });
        if (term.json) term.data({ project });
        else
          term.note(
            `${term.err.green("added")} ${shortCwd(project.cwd)} ${term.err.dim(`(${plural(project.sessionCount, "session")}, trust: ${project.trust})`)}`,
          );
        return;
      }
      if (verb === "remove") {
        await rpc.request("pi/project/remove", { cwd }).catch((error: unknown) => {
          throw describeRpcError(error, `could not remove ${cwd}`);
        });
        // Removing unpins; it never deletes. The list is pinned directories
        // unioned with every directory the session catalog has seen, so a
        // directory with sessions in it is still listed afterwards — and a bare
        // "removed" would read as a command that did not work.
        const { projects: after } = await rpc.request("pi/project/list", {}).catch(() => ({ projects: [] }));
        const still = after.find((project) => project.cwd === cwd);
        if (term.json) term.data({ removed: cwd, stillListed: still !== undefined, sessionCount: still?.sessionCount ?? 0 });
        else if (still) {
          term.note(
            `${term.err.green("removed")} ${shortCwd(cwd)} ${term.err.dim("(session files are untouched)")}\n` +
              `${term.err.dim(`still listed: ${plural(still.sessionCount, "session")} live there. Archive them to take the project off the list.`)}`,
          );
        } else term.note(`${term.err.green("removed")} ${shortCwd(cwd)} ${term.err.dim("(session files are untouched)")}`);
        return;
      }

      const trusted = !bool(args, "no");
      const { project } = await rpc
        .request("pi/project/trust", { cwd, trusted, remember: bool(args, "remember") })
        .catch((error: unknown) => {
          throw describeRpcError(error, `could not set trust for ${cwd}`);
        });
      if (term.json) term.data({ project });
      else
        term.note(
          `${term.err.green(trusted ? "trusted" : "declined")} ${shortCwd(project.cwd)}${
            project.trustReasons?.length ? term.err.dim(` — ${project.trustReasons.join(", ")}`) : ""
          }`,
        );
    } finally {
      rpc.close();
    }
  },
};

function describeWorker(worker: WorkerInfo | undefined): string {
  if (!worker) return "—";
  if (worker.status === "crashed" && worker.message) return `crashed (${worker.message})`;
  return worker.status;
}
