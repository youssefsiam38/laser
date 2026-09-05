/**
 * Where piorbit keeps things, and the environment it hands to a Pi child.
 *
 * One resolution order, used by every command so `piorbit doctor`, `piorbit up`
 * and `piorbit pi` can never disagree about which agent directory is in play:
 *
 *   agent dir          --agent-dir  ▸ PIORBIT_AGENT_DIR ▸ PI_CODING_AGENT_DIR ▸ ~/.pi/agent
 *   session dir        --session-dir ▸ PIORBIT_SESSION_DIR ▸ PI_CODING_AGENT_SESSION_DIR ▸ <agent>/sessions
 *   state dir          --state-dir ▸ PIORBIT_STATE_DIR ▸ ~/.piorbit, or <agent>/piorbit
 *                      when --agent-dir/PIORBIT_AGENT_DIR names a non-default agent
 *                      directory, so two agent directories never share one host
 *   subagents root     --subagents-temp-root ▸ PIORBIT_SUBAGENTS_TEMP_ROOT ▸ PI_SUBAGENTS_TEMP_ROOT ▸ <state>/subagents
 *   port               --port ▸ PIORBIT_PORT ▸ 41441
 *
 * `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are Pi 0.85's own
 * variable names (`config.js`: `ENV_AGENT_DIR`, `ENV_SESSION_DIR`), so a Pi we
 * spawn lands in exactly the directories the host is watching.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HOST_BIND_ADDRESS, HOST_DEFAULT_PORT, defaultStateDir } from "@piorbit/host";
import type { FlagSpecs, ParsedArgs } from "./args.js";
import { num, str } from "./args.js";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
export const PI_SUBAGENTS_TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT";

export interface PiorbitPaths {
  /** Pi's agent directory: settings.json, auth.json, sessions, missions. */
  agentDir: string;
  sessionDir: string;
  subagentsTempRoot: string;
  /**
   * piorbit's own state (host record, log, project list, attention). Shared
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
  /** True when the port came from a flag or PIORBIT_PORT, not the default. */
  portIsExplicit: boolean;
}

/** Flags that every command accepts, because every command resolves paths. */
export const PATH_FLAGS: FlagSpecs = {
  "agent-dir": { type: "string", description: "Pi agent directory (default ~/.pi/agent)", placeholder: "<dir>" },
  "session-dir": { type: "string", description: "Session storage directory (default <agent-dir>/sessions)", placeholder: "<dir>" },
  "state-dir": { type: "string", description: "piorbit's own state directory (default ~/.piorbit)", placeholder: "<dir>" },
  "subagents-temp-root": {
    type: "string",
    description: "pi-subagents temp root piorbit pins for its children",
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

export function resolvePaths(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): PiorbitPaths {
  const agentDirOverride = pick(str(parsed, "agent-dir"), env["PIORBIT_AGENT_DIR"], env[PI_AGENT_DIR_ENV]);
  const agentDir = expandPath(agentDirOverride ?? join(homedir(), ".pi", "agent"));
  const sessionDir = expandPath(
    pick(str(parsed, "session-dir"), env["PIORBIT_SESSION_DIR"], env[PI_SESSION_DIR_ENV]) ?? join(agentDir, "sessions"),
  );
  // An overridden agent dir means a sandbox: give it its own host record and
  // project list, so `piorbit up --agent-dir /tmp/x` cannot adopt or stop the
  // host serving the real one.
  const stateDir = expandPath(
    pick(str(parsed, "state-dir"), env["PIORBIT_STATE_DIR"]) ??
      (agentDirOverride ? join(agentDir, "piorbit") : defaultStateDir()),
  );
  const subagentsTempRoot = expandPath(
    pick(
      str(parsed, "subagents-temp-root"),
      env["PIORBIT_SUBAGENTS_TEMP_ROOT"],
      env[PI_SUBAGENTS_TEMP_ROOT_ENV],
    ) ?? join(stateDir, "subagents"),
  );
  const portFlag = num(parsed, "port");
  const portEnv = env["PIORBIT_PORT"] ? Number(env["PIORBIT_PORT"]) : undefined;
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
 * binary (`piorbit pi`) and, through the host, every worker. Pinning both
 * directories is what keeps a terminal-started subagent run visible in the app.
 */
export function piEnv(paths: PiorbitPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    [PI_AGENT_DIR_ENV]: paths.agentDir,
    [PI_SESSION_DIR_ENV]: paths.sessionDir,
    [PI_SUBAGENTS_TEMP_ROOT_ENV]: paths.subagentsTempRoot,
    PIORBIT: "1",
  };
}

export function hostUrl(paths: Pick<PiorbitPaths, "host" | "port">): string {
  return `http://${paths.host}:${paths.port}`;
}

export function wsUrl(paths: Pick<PiorbitPaths, "host" | "port">): string {
  return `ws://${paths.host}:${paths.port}/ws`;
}
