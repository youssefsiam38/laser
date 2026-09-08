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
import { homedir } from "node:os";
import { join, sep } from "node:path";

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
 * The directories the built-in projectless agents run in. They live beside
 * `agent/` and `state/` under the product's own data directory: they are not
 * projects (the registry never lists them), just a working directory Beam and
 * Chat sessions can be created in.
 */
export function beamWorkspaceDir(dataDir: string): string {
  return join(dataDir, "beam");
}

export function chatWorkspaceDir(dataDir: string): string {
  return join(dataDir, "chat");
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
