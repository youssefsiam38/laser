/**
 * pi-subagents file layer (M3-T2, M3-T3, M3-T4). Lives in the host, not the
 * extension, so sessions started from a terminal (no worker, no extension) are
 * still visible. Parses JSON only; imports nothing from Pi or pi-subagents.
 *
 * On-disk layout (pi-subagents 0.65):
 *   <root>/async-subagent-runs/<runId>/status.json        atomic, ≤100 ms stale
 *   <root>/async-subagent-runs/<runId>/events.jsonl       append-only, no text deltas
 *   <root>/async-subagent-runs/<runId>/control/{steer-requests,stop-requests}/*.json, interrupt.json
 *   <root>/async-subagent-runs/.active-runs/<runId>
 *   <root>/async-subagent-runs/.terminal-runs/<sha256(sessionId)>/<endedAt>-<runId>.json
 *   ~/.pi/agent/sessions/<slug>/subagent-artifacts/{runId}_{agent}_{n}_transcript.jsonl   (foreground)
 *   ~/.pi/agent/missions/{index,projects}/**                                             (missions)
 */
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Roots to scan. PI_SUBAGENTS_TEMP_ROOT first, then the uid-scoped default. */
export function subagentsTempRoots(): string[] {
  const roots = new Set<string>();
  const env = process.env["PI_SUBAGENTS_TEMP_ROOT"];
  if (env) roots.add(env);
  if (process.platform !== "win32") roots.add(join(tmpdir(), `pi-subagents-uid-${userInfo().uid}`));
  return [...roots];
}

export function asyncRunsDir(root: string): string {
  return join(root, "async-subagent-runs");
}

export function missionsDir(agentDir = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "missions");
}

// TODO(M3-T2): watchAsyncRuns(root): AsyncIterable<{ runId, status, event? }>
// TODO(M3-T3): watchForegroundTranscripts(sessionsDir)
// TODO(M3-T4): requestStop / requestSteer / requestInterrupt (control inbox JSON files)
