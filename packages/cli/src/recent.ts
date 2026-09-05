/**
 * "The session I just made", per project.
 *
 * Pi creates a session file lazily — `session/new` returns a path that does not
 * exist on disk until the first message is persisted — so the host's catalog,
 * which is a scan of session *files*, cannot see a brand new session. Without
 * this note, `laser new && laser send "…"` would fail to find the session it
 * had just created.
 *
 * It is a cache, never a source of truth: every read is verified by loading the
 * session from the host, and a stale entry is simply ignored.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface RecentFile {
  /** Absolute project directory → session file path. */
  [cwd: string]: string;
}

function pathFor(stateDir: string): string {
  return join(stateDir, "cli-recent-sessions.json");
}

function read(stateDir: string): RecentFile {
  try {
    const parsed = JSON.parse(readFileSync(pathFor(stateDir), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
    ) as RecentFile;
  } catch {
    return {};
  }
}

export function rememberSession(stateDir: string, cwd: string, sessionPath: string): void {
  const file = pathFor(stateDir);
  const next: RecentFile = { ...read(stateDir), [resolve(cwd)]: sessionPath };
  // Keep it small; this is a convenience, not a history.
  const entries = Object.entries(next).slice(-64);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.recent.${process.pid}.json`);
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // A read-only state dir costs a convenience, not a command.
  }
}

export function recentSession(stateDir: string, cwd: string): string | undefined {
  return read(stateDir)[resolve(cwd)];
}
