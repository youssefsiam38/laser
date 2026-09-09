/**
 * laser's own home on disk, and the reason it is not the agent's (M10-T3).
 *
 * A person installs laser. They may never learn which agent runs underneath,
 * and they certainly did not agree to laser reading, rewriting or locking a
 * configuration directory some other program owns. So the desktop app keeps
 * **everything** — settings, credentials, sessions, installed extensions, its
 * own state — inside one directory that belongs to laser:
 *
 *   Linux    $XDG_DATA_HOME/laser, or ~/.local/share/laser
 *   macOS    ~/Library/Application Support/laser
 *   Windows  %LOCALAPPDATA%\laser
 *
 * Two consequences, both deliberate:
 *
 * - **A global agent install is invisible.** If the person already runs the
 *   underlying agent from a terminal, its directory is never opened and never
 *   written. `PI_CODING_AGENT_DIR` and its siblings are *removed* from the
 *   environment the app inherits rather than honoured, because in a desktop
 *   session those variables mean "the agent I use in my shell" — the one thing
 *   laser must not adopt. Uninstalling laser cannot damage it, and laser
 *   cannot be broken by it.
 * - **`LASER_AGENT_DIR` still wins.** That is the deliberate lever: advanced
 *   settings write it, and a person who genuinely wants both to share one
 *   directory sets it and gets exactly that.
 */
import { ENV } from "@lasercode/protocol";
import { join } from "node:path";
import { laserDataDir } from "@lasercode/cli";

/** Pi's own variable names. In a GUI they describe the *other* installation. */
const AGENT_ENV_VARS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;

export interface AgentHome {
  /** The one directory laser owns. Everything below it is laser's. */
  dataDir: string;
  /** The agent directory laser gives the host and every worker. */
  agentDir: string;
  /** laser's own state: host record, logs, project list, attention. */
  stateDir: string;
  /** True when the person pointed laser somewhere else on purpose. */
  chosenByPerson: boolean;
  /**
   * Variables that were present and are being ignored, so the log can say so.
   * Silence here is how a person ends up debugging the wrong agent directory.
   */
  ignored: string[];
}

/**
 * `$XDG_DATA_HOME/laser` and the platform equivalents.
 *
 * Re-exported rather than defined here: `@lasercode/host` owns the answer, and
 * the CLI resolves its own paths from the same function, so the window, a
 * terminal `laser sessions` and the host they both talk to cannot disagree.
 */
export { laserDataDir };

export function agentHome(env: NodeJS.ProcessEnv = process.env): AgentHome {
  const dataDir = laserDataDir(env);
  const chosen = (env[ENV.agentDir] ?? "").trim();
  return {
    dataDir,
    agentDir: chosen !== "" ? chosen : join(dataDir, "agent"),
    stateDir: (env[ENV.stateDir] ?? "").trim() || join(dataDir, "state"),
    chosenByPerson: chosen !== "",
    ignored: AGENT_ENV_VARS.filter((name) => (env[name] ?? "").trim() !== ""),
  };
}

/**
 * The environment the app resolves its paths from, and hands to the host it
 * spawns. Same function for both, so the window and the host process can never
 * disagree about which directory the agent is living in.
 */
export function desktopEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = agentHome(env);
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of AGENT_ENV_VARS) delete next[name];
  next[ENV.agentDir] = home.agentDir;
  next[ENV.stateDir] = home.stateDir;
  return next;
}
