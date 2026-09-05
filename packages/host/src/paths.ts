/**
 * The one directory piorbit owns, and everything under it (M10-T3).
 *
 * A person installs piorbit. They may never learn which agent runs underneath,
 * and they certainly did not agree to piorbit reading, rewriting or locking a
 * configuration directory some other program owns. So piorbit keeps
 * **everything** — settings, credentials, sessions, installed extensions, its
 * own state — inside one directory that belongs to piorbit:
 *
 *   Linux    $XDG_DATA_HOME/piorbit, or ~/.local/share/piorbit
 *   macOS    ~/Library/Application Support/piorbit
 *   Windows  %LOCALAPPDATA%\piorbit
 *
 * This lives in the host rather than in the desktop shell or the CLI because
 * all three have to agree: the app, a terminal `piorbit sessions`, and the host
 * they both talk to. When they disagree the person sees an empty session list
 * in one place and a full one in the other, with nothing on screen explaining
 * why. One function, one answer.
 *
 * A global agent installation is therefore invisible to piorbit: its directory
 * is never opened and never written, uninstalling piorbit cannot damage it, and
 * it cannot break piorbit. `PIORBIT_AGENT_DIR` (or `--agent-dir`) is the
 * deliberate lever for a person who genuinely wants both to share one
 * directory.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** `$XDG_DATA_HOME/piorbit` and the platform equivalents. */
export function piorbitDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] ?? homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "piorbit");
  if (process.platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? env["APPDATA"];
    return base ? join(base, "piorbit") : join(home, "AppData", "Local", "piorbit");
  }
  const xdg = env["XDG_DATA_HOME"];
  return xdg && xdg.trim() !== "" ? join(xdg, "piorbit") : join(home, ".local", "share", "piorbit");
}

/** The agent directory piorbit gives the host and every worker. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(piorbitDataDir(env), "agent");
}

/** piorbit's own state: host record, log, project list, attention, prefs. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(piorbitDataDir(env), "state");
}
