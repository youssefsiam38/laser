/**
 * Turning what a person typed into the session the host means.
 *
 * A Pi session's identity is its file path (ids are only unique per cwd, per
 * `docs/research/findings.md`), and nobody wants to type a path. So a reference
 * may be: the full path, the session id, a prefix of the id, or any suffix of
 * the path — and if it is ambiguous we say so and list the candidates rather
 * than guessing.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { basename, resolve } from "node:path";
import type { SessionSummary } from "@piorbit/protocol";
import { CliError, ExitCode } from "./errors.js";
import type { HostRpc } from "./rpc.js";
import { describeRpcError } from "./rpc.js";

export async function listSessions(rpc: HostRpc, cwd?: string): Promise<SessionSummary[]> {
  try {
    const { sessions } = await rpc.request("pi/session/list", cwd !== undefined ? { cwd } : {});
    return sessions;
  } catch (error) {
    throw describeRpcError(error, "could not list sessions");
  }
}

export interface ResolveOptions {
  /** Narrow to one project before matching. */
  cwd?: string;
  /** With no reference, fall back to the newest session in `cwd`. */
  allowLatest?: boolean;
}

export function matchSessions(sessions: readonly SessionSummary[], reference: string): SessionSummary[] {
  const exactPath = sessions.filter((session) => session.path === reference);
  if (exactPath.length > 0) return exactPath;

  const resolved = resolve(reference);
  const resolvedPath = sessions.filter((session) => session.path === resolved);
  if (resolvedPath.length > 0) return resolvedPath;

  const exactId = sessions.filter((session) => session.id === reference);
  if (exactId.length > 0) return exactId;

  const fuzzy = sessions.filter(
    (session) =>
      session.id.startsWith(reference) ||
      session.path.endsWith(reference) ||
      basename(session.path) === reference ||
      basename(session.path).startsWith(reference),
  );
  return fuzzy;
}

export async function resolveSession(
  rpc: HostRpc,
  reference: string | undefined,
  options: ResolveOptions = {},
): Promise<SessionSummary> {
  const sessions = await listSessions(rpc, options.cwd);

  if (reference === undefined) {
    if (!options.allowLatest) {
      throw new CliError("this command needs a session", {
        exitCode: ExitCode.Usage,
        fix: `Pass one: \`${PRODUCT_NAME} sessions\` lists them, and any unambiguous id or path suffix works.`,
      });
    }
    const latest = sessions[0];
    if (!latest) {
      throw new CliError(
        options.cwd ? `no sessions found in ${options.cwd}` : "no sessions found",
        {
          fix: options.cwd
            ? `Start one with \`${PRODUCT_NAME} new ${options.cwd}\`.`
            : `Start one with \`${PRODUCT_NAME} new\`, or point at a project with --project.`,
        },
      );
    }
    return latest;
  }

  const matches = matchSessions(sessions, reference);
  if (matches.length === 1) return matches[0] as SessionSummary;
  if (matches.length === 0) {
    throw new CliError(`no session matches ${JSON.stringify(reference)}`, {
      exitCode: ExitCode.HostError,
      fix: `Run \`${PRODUCT_NAME} sessions\` to see what the host knows about.`,
    });
  }
  throw new CliError(`${matches.length} sessions match ${JSON.stringify(reference)}`, {
    details: matches.slice(0, 8).map((session) => `${session.id}  ${session.path}`),
    exitCode: ExitCode.Usage,
    fix: "Use a longer id, or the full path.",
  });
}

/** `--project` value → absolute directory. `.` and relative paths work. */
export function resolveProject(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolve(value);
}
