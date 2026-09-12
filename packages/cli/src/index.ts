/**
 * @lasercode/cli — the `laser` command.
 *
 * Exported so other packages (the Electron shell, tests) can reuse the pieces
 * without shelling out. This package speaks @lasercode/protocol and never imports
 * Pi; it only resolves the path of the Pi that @lasercode/worker pins.
 */
export { COMMANDS, run } from "./cli.js";
export { parseArgs, bool, str, num, list, distance, type FlagSpec, type FlagSpecs, type ParsedArgs } from "./args.js";
export { findCommand, type Command, type CommandContext, type CommandGroup } from "./command.js";
export { laserDataDir, defaultAgentDir, defaultStateDir, migrateFormerIdentities } from "@lasercode/host";
export {
  appAddress,
  appUrl,
  expandPath,
  hostUrl,
  piEnv,
  resolvePaths,
  wsUrl,
  PATH_FLAGS,
  PORT_FLAG,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  type AppAddress,
  type LaserPaths,
} from "./config.js";
export { runDaemon, type DaemonOptions } from "./daemon.js";
export { CliError, ExitCode, messageOf, usageError, type ExitCodeValue } from "./errors.js";
export { GLOBAL_FLAGS, colorMode, flagsFor } from "./flags.js";
export { TOPICS, findTopic, renderCommandHelp, renderRootHelp, type Topic } from "./help.js";
export {
  cliEntry,
  unpacked,
  daemonArgs,
  logTail,
  openBrowser,
  refreshHostEnvironment,
  startHost,
  stopHost,
  type StartResult,
  type StopResult,
} from "./host-control.js";
export {
  clearHostFile,
  inspectHost,
  isProcessAlive,
  isRecordedProcess,
  portInUse,
  processIdentity,
  probeHealth,
  readHostFile,
  writeHostFile,
  type HostRecord,
  type HostStatus,
} from "./hostfile.js";
export { Terminal, painterFor, sanitize, table, width, type ColorMode, type Painter } from "./output.js";
export {
  exitLikeChild,
  resolveGlobalPi,
  resolvePinnedPi,
  runPi,
  which,
  type PiResolution,
  type PiRunResult,
} from "./pi.js";
export { TailRenderer, firstLine, formatDuration, summarizeArgs, summarizeResult } from "./render.js";
export { HostRpc, HostRpcError, describeRpcError, type NotificationHandler } from "./rpc.js";
export { listSessions, matchSessions, resolveSession, resolveProject } from "./session-ref.js";
export { sessionFragment } from "./commands/session.js";
export { CLI_VERSION } from "./version.js";
