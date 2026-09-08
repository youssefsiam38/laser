/**
 * AgentRunRegistry — every agent run the host has heard of, in
 * `<stateDir>/agent-runs.json`.
 *
 * Workers own runs while they live (they start the child, watch the timeout,
 * write the child's session); the host keeps the record so that the live map,
 * the sidebar and `agents/runs/list` can answer after the worker is gone, and
 * so that a child session path can be routed to its project's worker without
 * opening the file. It is fed by `agents/run` notifications, which the server
 * intercepts before broadcasting.
 *
 * A run that is still `queued`/`running` when its worker dies can never end on
 * its own, so `workerLost` fails it with a reason a person can read. The same
 * is applied on load: nothing survives a host restart with a worker attached.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTerminalRunStatus, type AgentRun } from "@lasercode/protocol";
import { canonical } from "../trust.js";

export interface AgentRunRegistryOptions {
  storePath?: string;
  /** Called for every run the registry changes itself (never for an `upsert`). */
  onRun?: (run: AgentRun) => void;
  now?: () => Date;
  /** Terminal runs older than this leave the file. */
  retentionDays?: number;
  /** At most this many terminal runs are kept per project, newest first. */
  retentionPerProject?: number;
}

const WORKER_LOST_MESSAGE = "The project's worker stopped before this run ended.";
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_PER_PROJECT = 500;

export class AgentRunRegistry {
  private readonly runs = new Map<string, AgentRun>();
  private readonly now: () => Date;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AgentRunRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** Record what a worker reported. Newer `updatedAt` wins; an older report is ignored. */
  upsert(run: AgentRun): AgentRun {
    const existing = this.runs.get(run.runId);
    if (existing && existing.updatedAt > run.updatedAt && isTerminalRunStatus(existing.status)) return existing;
    const stored = structuredClone(run);
    this.runs.set(stored.runId, stored);
    this.prune();
    this.schedulePersist();
    return stored;
  }

  get(runId: string): AgentRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  /**
   * Every run, newest first; with `path`, the runs of the tree that session
   * belongs to (a child path resolves to its root through the runs it appears in).
   */
  list(path?: string): AgentRun[] {
    let runs = [...this.runs.values()];
    if (path !== undefined) {
      const root = this.rootOf(path);
      runs = runs.filter((run) => run.rootSessionPath === root);
    }
    return structuredClone(runs.sort(newestFirst));
  }

  /** Runs executed in one child session, newest first. */
  byChildPath(sessionPath: string): AgentRun[] {
    return structuredClone([...this.runs.values()].filter((run) => run.sessionPath === sessionPath).sort(newestFirst));
  }

  /** The most recent run of a child session, for sidebar attribution. */
  latestFor(sessionPath: string): AgentRun | undefined {
    return this.byChildPath(sessionPath)[0];
  }

  /** The latest run per child session, in one pass, for decorating a whole list. */
  latestByChildPath(): Map<string, AgentRun> {
    const latest = new Map<string, AgentRun>();
    for (const run of this.runs.values()) {
      const current = latest.get(run.sessionPath);
      if (!current || newestFirst(run, current) < 0) latest.set(run.sessionPath, run);
    }
    return new Map([...latest].map(([path, run]) => [path, structuredClone(run)]));
  }

  /** The project a session belongs to, from any run that mentions it. */
  projectCwdOf(sessionPath: string): string | undefined {
    for (const run of this.runs.values()) {
      if (run.sessionPath === sessionPath || run.rootSessionPath === sessionPath || run.parent?.sessionPath === sessionPath) {
        return run.projectCwd;
      }
    }
    return undefined;
  }

  /** The root session of the tree `path` is in: itself unless a run says otherwise. */
  rootOf(path: string): string {
    for (const run of this.runs.values()) {
      if (run.sessionPath === path) return run.rootSessionPath;
    }
    return path;
  }

  /** The project's worker is gone: nothing in flight there can end on its own. */
  workerLost(cwd: string): AgentRun[] {
    const key = canonical(cwd);
    const at = this.now().toISOString();
    const changed: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status) || canonical(run.projectCwd) !== key) continue;
      run.status = "failed";
      run.error = WORKER_LOST_MESSAGE;
      run.endedBy = { initiator: "harness", reason: WORKER_LOST_MESSAGE };
      run.endedAt = at;
      run.updatedAt = at;
      changed.push(structuredClone(run));
    }
    if (changed.length > 0) {
      this.schedulePersist();
      for (const run of changed) this.options.onRun?.(run);
    }
    return changed;
  }

  /** A session was deleted: its runs cannot go on. History stays until retention takes it. */
  forgetSession(sessionPath: string): AgentRun[] {
    const at = this.now().toISOString();
    const changed: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.sessionPath !== sessionPath || isTerminalRunStatus(run.status)) continue;
      run.status = "cancelled";
      run.endedBy = { initiator: "user", reason: "The session was deleted." };
      run.endedAt = at;
      run.updatedAt = at;
      changed.push(structuredClone(run));
    }
    if (changed.length > 0) {
      this.schedulePersist();
      for (const run of changed) this.options.onRun?.(run);
    }
    return changed;
  }

  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      this.persist();
    }
  }

  // -------------------------------------------------------------- internals

  private prune(): void {
    const days = this.options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const perProject = this.options.retentionPerProject ?? DEFAULT_RETENTION_PER_PROJECT;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const terminalByProject = new Map<string, AgentRun[]>();
    for (const run of this.runs.values()) {
      if (!isTerminalRunStatus(run.status)) continue;
      if ((run.endedAt ?? run.updatedAt) < cutoff) {
        this.runs.delete(run.runId);
        continue;
      }
      const list = terminalByProject.get(run.projectCwd) ?? [];
      list.push(run);
      terminalByProject.set(run.projectCwd, list);
    }
    for (const list of terminalByProject.values()) {
      if (list.length <= perProject) continue;
      list.sort(newestFirst);
      for (const run of list.slice(perProject)) this.runs.delete(run.runId);
    }
  }

  private load(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: unknown };
      if (!Array.isArray(parsed.runs)) return;
      for (const raw of parsed.runs) {
        const run = readRun(raw);
        if (run) this.runs.set(run.runId, run);
      }
    } catch {
      /* first run, or a truncated file: start empty */
    }
    // No worker outlives the host process, so nothing loaded can still be running.
    const at = this.now().toISOString();
    let changed = false;
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status)) continue;
      run.status = "failed";
      run.error = WORKER_LOST_MESSAGE;
      run.endedBy = { initiator: "harness", reason: WORKER_LOST_MESSAGE };
      run.endedAt = at;
      run.updatedAt = at;
      changed = true;
    }
    this.prune();
    if (changed) this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.options.storePath || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.persist();
    }, 300);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${process.pid}.agent-runs.tmp`);
      writeFileSync(tmp, JSON.stringify({ version: 1, runs: [...this.runs.values()].sort(newestFirst) }, null, 2));
      renameSync(tmp, file);
    } catch {
      /* read-only home, full disk: the registry still serves this run */
    }
  }
}

function newestFirst(a: AgentRun, b: AgentRun): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId.localeCompare(b.runId);
}

/** Only what a worker could have written; a stale file is untrusted input. */
function readRun(raw: unknown): AgentRun | undefined {
  const run = raw as Partial<AgentRun> | null;
  if (!run || typeof run !== "object") return undefined;
  const strings = ["agentName", "subagentName", "sessionId", "runId", "sessionPath", "projectCwd", "rootSessionPath", "startedAt", "updatedAt"] as const;
  for (const key of strings) if (typeof run[key] !== "string") return undefined;
  if (typeof run.status !== "string") return undefined;
  return structuredClone(run as AgentRun);
}
