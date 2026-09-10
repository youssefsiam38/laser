/**
 * The one directory laser owns, and everything under it (M10-T3).
 *
 * A person installs laser. They may never learn which agent runs underneath,
 * and they certainly did not agree to laser reading, rewriting or locking a
 * configuration directory some other program owns. So laser keeps
 * **everything** — settings, credentials, sessions, installed extensions, its
 * own state — inside one directory that belongs to laser:
 *
 *   Linux    $XDG_DATA_HOME/laser, or ~/.local/share/laser
 *   macOS    ~/Library/Application Support/laser
 *   Windows  %LOCALAPPDATA%\laser
 *
 * This lives in the host rather than in the desktop shell or the CLI because
 * all three have to agree: the app, a terminal `laser sessions`, and the host
 * they both talk to. When they disagree the person sees an empty session list
 * in one place and a full one in the other, with nothing on screen explaining
 * why. One function, one answer.
 *
 * A global agent installation is therefore invisible to laser: its directory
 * is never opened and never written, uninstalling laser cannot damage it, and
 * it cannot break laser. `LASER_AGENT_DIR` (or `--agent-dir`) is the
 * deliberate lever for a person who genuinely wants both to share one
 * directory.
 */
import { DATA_DIR_NAME, WORKTREES_DIR_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { canonical } from "./trust.js";

/** Directory containment, not a string prefix; existing aliases resolve to the same place. */
export function isWithinDirectory(cwd: string, root: string): boolean {
  const resolved = (path: string): string => {
    const key = canonical(path);
    try { return realpathSync(key); } catch { return key; }
  };
  const path = relative(resolved(root), resolved(cwd));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function workspaceAgentFor(cwd: string, workspaces: { beam: string; chat: string }): "beam" | "chat" | undefined {
  if (isWithinDirectory(cwd, workspaces.beam)) return "beam";
  if (isWithinDirectory(cwd, workspaces.chat)) return "chat";
  return undefined;
}

/** `$XDG_DATA_HOME/laser` and the platform equivalents. */
export function laserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] ?? homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", DATA_DIR_NAME);
  if (process.platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? env["APPDATA"];
    return base ? join(base, DATA_DIR_NAME) : join(home, "AppData", "Local", DATA_DIR_NAME);
  }
  const xdg = env["XDG_DATA_HOME"];
  return xdg && xdg.trim() !== "" ? join(xdg, DATA_DIR_NAME) : join(home, ".local", "share", DATA_DIR_NAME);
}

/** The agent directory laser gives the host and every worker. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(laserDataDir(env), "agent");
}

/** laser's own state: host record, log, project list, attention, prefs. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(laserDataDir(env), "state");
}

/**
 * The directories the built-in projectless agents run in. They live under the
 * host's own state directory (`<stateDir>/workspaces/beam`, `…/chat`): the
 * host creates and owns that directory in every layout, so a workspace is
 * never derived from a path some other layer chose. They are not projects
 * (the registry never lists them), just containers for the persistent private
 * working directory allocated to each Beam and Chat session.
 */
export function workspacesDir(stateDir: string): string {
  return join(stateDir, "workspaces");
}

export function beamWorkspaceDir(stateDir: string): string {
  return join(workspacesDir(stateDir), "beam");
}

export function chatWorkspaceDir(stateDir: string): string {
  return join(workspacesDir(stateDir), "chat");
}

/**
 * Give one Beam or Chat conversation a durable private working directory. `mkdtemp`
 * supplies collision-free naming, but the directory lives under the product
 * state and is deliberately not temporary or cleaned up when the process ends.
 */
export function createPrivateSessionWorkspace(workspaceRoot: string): string {
  const problem = ensureWorkspace(workspaceRoot);
  if (problem) throw new Error(problem);
  return mkdtempSync(join(workspaceRoot, "session-"));
}

/**
 * Make sure a workspace directory exists. Returns the reason it could not be
 * created, in words a person can act on, or undefined when it is there.
 */
export function ensureWorkspace(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) return `${dir} exists but is not a directory`;
    return undefined;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const why = code === "EACCES" || code === "EPERM" ? "permission denied" : code === "ENOTDIR" ? "a parent of that path is a file" : code === "EROFS" ? "the file system is read-only" : error instanceof Error ? error.message : String(error);
    return why;
  }
}

/**
 * The project a session directory belongs to. A child agent runs in a worktree
 * under `<project>/.worktrees/<name>`; its session header records the
 * worktree, but its worker, its project row and its sidebar group are the
 * project's. Any other directory is its own project.
 */
export function projectRootOf(cwd: string): string {
  const marker = `${sep}${WORKTREES_DIR_NAME}${sep}`;
  const at = cwd.indexOf(marker);
  return at > 0 ? cwd.slice(0, at) : cwd;
}
