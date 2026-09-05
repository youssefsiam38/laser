/**
 * Where laser keeps things, and the environment it hands to a Pi child.
 *
 * One resolution order, used by every command so `laser doctor`, `laser up`
 * and `laser pi` can never disagree about which agent directory is in play:
 *
 *   agent dir          --agent-dir  ▸ LASER_AGENT_DIR ▸ <data>/agent
 *   session dir        --session-dir ▸ LASER_SESSION_DIR ▸ <agent>/sessions
 *   state dir          --state-dir ▸ LASER_STATE_DIR ▸ <data>/state, or <agent>/laser
 *                      when --agent-dir/LASER_AGENT_DIR names a non-default agent
 *                      directory, so two agent directories never share one host
 *   subagents root     --subagents-temp-root ▸ LASER_SUBAGENTS_TEMP_ROOT ▸ <state>/subagents
 *   port               --port ▸ LASER_PORT ▸ 41441
 *
 * `<data>` is `laserDataDir()`: `$XDG_DATA_HOME/laser` on Linux and the
 * platform equivalents elsewhere. It is laser's own directory, not the
 * agent's — a person who already runs the underlying agent from a terminal
 * keeps their `~/.pi/agent` untouched, and the desktop app and this command
 * resolve to the same place so they can never show different sessions.
 *
 * `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are Pi 0.85's own
 * variable names (`config.js`: `ENV_AGENT_DIR`, `ENV_SESSION_DIR`). They are
 * *written* by `piEnv()` below, so a Pi we spawn lands in exactly the
 * directories the host is watching — and they are deliberately **not read**
 * here. In a desktop session those variables mean "the agent I use in my
 * shell", which is the one installation laser must never adopt: the app
 * strips them (`packages/desktop/src/agent-home.ts`), so a CLI that honoured
 * them would show a different agent directory, different settings and
 * different sessions from the window on the same machine — for exactly the
 * person who has both.
 */
import { DATA_DIR_NAME, ENV, ENV_PREFIX, PRODUCT_NAME } from "@lasercode/protocol";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HOST_BIND_ADDRESS, HOST_DEFAULT_PORT, defaultAgentDir, defaultStateDir, laserDataDir } from "@lasercode/host";
import type { FlagSpecs, ParsedArgs } from "./args.js";
import { num, str } from "./args.js";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
export const PI_SUBAGENTS_TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT";

export interface LaserPaths {
  /** Pi's agent directory: settings.json, auth.json, sessions, missions. */
  agentDir: string;
  sessionDir: string;
  subagentsTempRoot: string;
  /**
   * laser's own state (host record, log, project list, attention). Shared
   * with a host started any other way, unless the agent dir was overridden —
   * then it moves under the agent dir so sandboxes stay isolated.
   */
  stateDir: string;
  /** Pidfile + port file for the running host. */
  hostFile: string;
  /** Where a detached host's stdout/stderr goes. */
  logFile: string;
  host: string;
  port: number;
  /** True when the port came from a flag or LASER_PORT, not the default. */
  portIsExplicit: boolean;
}

/** Flags that every command accepts, because every command resolves paths. */
export const PATH_FLAGS: FlagSpecs = {
  "agent-dir": { type: "string", description: `Agent directory (default <${PRODUCT_NAME} data dir>/agent)`, placeholder: "<dir>" },
  "session-dir": { type: "string", description: "Session storage directory (default <agent-dir>/sessions)", placeholder: "<dir>" },
  "state-dir": { type: "string", description: `${PRODUCT_NAME}'s own state directory (default <${PRODUCT_NAME} data dir>/state)`, placeholder: "<dir>" },
  "subagents-temp-root": {
    type: "string",
    description: `Subagent temp root ${PRODUCT_NAME} pins for its children`,
    placeholder: "<dir>",
  },
};

export const PORT_FLAG: FlagSpecs = {
  port: { type: "number", short: "p", description: `Host port (default ${HOST_DEFAULT_PORT})`, placeholder: "<port>" },
};

/** Expand a leading `~` and make the path absolute against the cwd. */
export function expandPath(input: string, cwd = process.cwd()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  const expanded = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function pick(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) if (candidate !== undefined && candidate.trim() !== "") return candidate;
  return undefined;
}

export function resolvePaths(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): LaserPaths {
  const agentDirOverride = pick(str(parsed, "agent-dir"), env[ENV.agentDir]);
  const agentDir = expandPath(agentDirOverride ?? defaultAgentDir(env));
  const sessionDir = expandPath(
    pick(str(parsed, "session-dir"), env[ENV.sessionDir]) ?? join(agentDir, "sessions"),
  );
  // An overridden agent dir means a sandbox: give it its own host record and
  // project list, so `laser up --agent-dir /tmp/x` cannot adopt or stop the
  // host serving the real one.
  const stateDir = expandPath(
    pick(str(parsed, "state-dir"), env[ENV.stateDir]) ??
      (agentDirOverride ? join(agentDir, DATA_DIR_NAME) : defaultStateDir(env)),
  );
  const subagentsTempRoot = expandPath(
    pick(str(parsed, "subagents-temp-root"), env[ENV.subagentsTempRoot]) ?? join(stateDir, "subagents"),
  );
  const portFlag = num(parsed, "port");
  const portEnv = env[ENV.port] ? Number(env[ENV.port]) : undefined;
  const port = portFlag ?? (Number.isFinite(portEnv) ? (portEnv as number) : HOST_DEFAULT_PORT);

  return {
    agentDir,
    sessionDir,
    subagentsTempRoot,
    stateDir,
    hostFile: join(stateDir, "host.json"),
    logFile: join(stateDir, "host.log"),
    host: HOST_BIND_ADDRESS,
    port,
    portIsExplicit: portFlag !== undefined || portEnv !== undefined,
  };
}

/**
 * The environment for anything we spawn that will load Pi: the pinned Pi
 * binary (`laser pi`) and, through the host, every worker. Pinning both
 * directories is what keeps a terminal-started subagent run visible in the app.
 */
export function piEnv(paths: LaserPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    [PI_AGENT_DIR_ENV]: paths.agentDir,
    [PI_SESSION_DIR_ENV]: paths.sessionDir,
    [PI_SUBAGENTS_TEMP_ROOT_ENV]: paths.subagentsTempRoot,
    [ENV_PREFIX]: "1",
  };
}

export function hostUrl(paths: Pick<LaserPaths, "host" | "port">): string {
  return `http://${paths.host}:${paths.port}`;
}

export function wsUrl(paths: Pick<LaserPaths, "host" | "port">): string {
  return `ws://${paths.host}:${paths.port}/ws`;
}
