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
import { AGENT_RUN_STATUSES, isTerminalRunStatus, type AgentRun } from "@lasercode/protocol";
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
  private readonly children = new Map<string, Map<string, AgentRun>>();
  private readonly roots = new Map<string, Map<string, AgentRun>>();
  private readonly mentions = new Map<string, Map<string, AgentRun>>();
  private readonly terminals = new Map<string, Map<string, AgentRun>>();
  private readonly liveCounts = new Map<string, number>();
  private readonly order = new Map<string, number>();
  private nextOrder = 0;
  private pruneTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => Date;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AgentRunRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.load();
    this.schedulePrune();
  }

  /** Record what a worker reported. Newer `updatedAt` wins; an older report is ignored. */
  upsert(run: AgentRun): AgentRun {
    const existing = this.runs.get(run.runId);
    if (existing && existing.updatedAt > run.updatedAt && isTerminalRunStatus(existing.status)) return structuredClone(existing);
    const stored = structuredClone(run);
    this.put(stored);
    if (isTerminalRunStatus(stored.status)) this.pruneProject(stored.projectCwd);
    this.schedulePersist();
    return structuredClone(stored);
  }

  get(runId: string): AgentRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  /**
   * Every run, newest first; with `path`, the runs of the tree that session
   * belongs to (a child path resolves to its root through the runs it appears in).
   */
  /** True while any run of `projectCwd` has not ended; the idle sweep asks this. */
  hasLiveRun(projectCwd: string): boolean {
    return (this.liveCounts.get(projectCwd) ?? 0) > 0;
  }

  list(path?: string): AgentRun[] {
    const runs = path === undefined ? [...this.runs.values()] : [...(this.roots.get(this.rootOf(path))?.values() ?? [])];
    return structuredClone(runs.sort(newestFirst));
  }

  /** Runs executed in one child session, newest first. */
  byChildPath(sessionPath: string): AgentRun[] {
    return structuredClone([...(this.children.get(sessionPath)?.values() ?? [])].sort(newestFirst));
  }

  /** The run that stands for a child session, for sidebar attribution. */
  latestFor(sessionPath: string): AgentRun | undefined {
    const run = this.latestInternal(sessionPath);
    return run ? structuredClone(run) : undefined;
  }

  /** The standing run per child session, in one pass, for decorating a whole list. */
  latestByChildPath(): Map<string, AgentRun> {
    const latest = new Map<string, AgentRun>();
    for (const path of this.children.keys()) {
      const run = this.latestInternal(path);
      if (run) latest.set(path, structuredClone(run));
    }
    return latest;
  }

  /** The project a session belongs to, from any run that mentions it. */
  projectCwdOf(sessionPath: string): string | undefined {
    return this.firstIndexed(this.mentions.get(sessionPath))?.projectCwd;
  }

  /** The root session of the tree `path` is in: itself unless a run says otherwise. */
  rootOf(path: string): string {
    return this.firstIndexed(this.children.get(path))?.rootSessionPath ?? path;
  }

  /** The project's worker is gone: nothing in flight there can end on its own. */
  workerLost(cwd: string): AgentRun[] {
    const key = canonical(cwd);
    const at = this.now().toISOString();
    const changed: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status) || canonical(run.projectCwd) !== key) continue;
      const updated: AgentRun = { ...run, status: "failed", error: WORKER_LOST_MESSAGE,
        endedBy: { initiator: "harness", reason: WORKER_LOST_MESSAGE }, endedAt: at, updatedAt: at };
      this.put(updated);
      changed.push(structuredClone(updated));
    }
    if (changed.length > 0) {
      this.schedulePersist();
      for (const run of changed) this.options.onRun?.(run);
    }
    return changed;
  }

  /**
   * A worktree was taken away by a person, from the fleet or with a session
   * delete (M13-T42). Every run that owned that directory is stamped, so no
   * surface offers to remove it twice and none keeps showing a path that is
   * gone. The parent's own `remove_agent_worktree` stamps in the worker and
   * arrives here as an ordinary report.
   */
  worktreeRemoved(worktreePath: string): AgentRun[] {
    const key = canonical(worktreePath);
    const at = this.now().toISOString();
    const changed: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (!run.worktree || run.worktree.removedAt || canonical(run.worktree.path) !== key) continue;
      const updated = { ...run, worktree: { ...run.worktree, removedAt: at }, updatedAt: at };
      this.put(updated);
      changed.push(structuredClone(updated));
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
      const updated: AgentRun = { ...run, status: "cancelled", endedBy: { initiator: "user", reason: "The session was deleted." }, endedAt: at, updatedAt: at };
      this.put(updated);
      changed.push(structuredClone(updated));
    }
    if (changed.length > 0) {
      this.schedulePersist();
      for (const run of changed) this.options.onRun?.(run);
    }
    return changed;
  }

  close(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    this.prune();
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      this.persist();
    }
  }

  // -------------------------------------------------------------- internals

  private latestInternal(path: string): AgentRun | undefined {
    let latest: AgentRun | undefined;
    for (const run of this.children.get(path)?.values() ?? []) {
      if (!latest || liveFirst(run, latest) < 0) latest = run;
    }
    return latest;
  }

  private firstIndexed(runs: Map<string, AgentRun> | undefined): AgentRun | undefined {
    let first: AgentRun | undefined;
    for (const run of runs?.values() ?? []) {
      if (!first || this.order.get(run.runId)! < this.order.get(first.runId)!) first = run;
    }
    return first;
  }

  private index(run: AgentRun, remove: boolean): void {
    const update = (index: Map<string, Map<string, AgentRun>>, key: string) => {
      const bucket = index.get(key) ?? new Map<string, AgentRun>();
      if (remove) bucket.delete(run.runId); else bucket.set(run.runId, run);
      if (bucket.size) index.set(key, bucket); else index.delete(key);
    };
    update(this.children, run.sessionPath);
    update(this.roots, run.rootSessionPath);
    for (const path of new Set([run.sessionPath, run.rootSessionPath, ...(run.parent ? [run.parent.sessionPath] : [])])) update(this.mentions, path);
    if (isTerminalRunStatus(run.status)) update(this.terminals, run.projectCwd);
    else {
      const count = (this.liveCounts.get(run.projectCwd) ?? 0) + (remove ? -1 : 1);
      if (count) this.liveCounts.set(run.projectCwd, count); else this.liveCounts.delete(run.projectCwd);
    }
  }

  private put(run: AgentRun): void {
    const old = this.runs.get(run.runId);
    if (old) this.index(old, true);
    else this.order.set(run.runId, this.nextOrder++);
    this.runs.set(run.runId, run);
    this.index(run, false);
  }

  private remove(run: AgentRun): void {
    this.index(run, true);
    this.runs.delete(run.runId);
    this.order.delete(run.runId);
  }

  /** Age maintenance visits one terminal-project bucket per turn, not retained
   * history on every live activity update. Never prunes a live/question row. */
  private schedulePrune(): void {
    this.pruneTimer = setTimeout(() => {
      const projects = [...this.terminals.keys()];
      let index = 0;
      const step = () => {
        const project = projects[index++];
        if (project === undefined) { this.schedulePrune(); return; }
        const before = this.runs.size;
        this.pruneProject(project);
        if (this.runs.size !== before) this.schedulePersist();
        this.pruneTimer = setTimeout(step, 0);
        this.pruneTimer.unref?.();
      };
      step();
    }, 60_000);
    this.pruneTimer.unref?.();
  }

  private prune(): void {
    for (const project of this.terminals.keys()) this.pruneProject(project);
  }

  private pruneProject(project: string): void {
    const days = this.options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const perProject = this.options.retentionPerProject ?? DEFAULT_RETENTION_PER_PROJECT;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const retained: AgentRun[] = [];
    for (const run of this.terminals.get(project)?.values() ?? []) {
      if ((run.endedAt ?? run.updatedAt) < cutoff) {
        this.remove(run);
        continue;
      }
      retained.push(run);
    }
    if (retained.length > perProject) {
      retained.sort(newestFirst);
      for (const run of retained.slice(perProject)) this.remove(run);
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
        if (run) this.put(run);
      }
    } catch {
      /* first run, or a truncated file: start empty */
    }
    // No worker outlives the host process, so nothing loaded can still be running.
    const at = this.now().toISOString();
    let changed = false;
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status)) continue;
      this.put({ ...run, status: "failed", error: WORKER_LOST_MESSAGE,
        endedBy: { initiator: "harness", reason: WORKER_LOST_MESSAGE }, endedAt: at, updatedAt: at });
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

/** 1 for a run that can still act (`running`, `needs_input`), 0 for one that only waits or has ended. */
const liveness = (run: AgentRun): number => (run.status === "queued" || isTerminalRunStatus(run.status) ? 0 : 1);

/**
 * The run that stands for a session: one that can still act before one that
 * only waits behind it, then newest first. While a declared completion
 * unwinds, the old invocation can still write and the session's row must say
 * so (M13-T98); the worker's `sessionInfo`, its fleet and the UI's
 * `compareRunsNewestFirst` rank the same way, so every reader of a child's
 * standing run agrees.
 */
function liveFirst(a: AgentRun, b: AgentRun): number {
  return liveness(b) - liveness(a) || newestFirst(a, b);
}

/** Only what a worker could have written; a stale file is untrusted input. */
function readRun(raw: unknown): AgentRun | undefined {
  const run = raw as Partial<AgentRun> | null;
  if (!run || typeof run !== "object") return undefined;
  const strings = ["agentName", "subagentName", "sessionId", "runId", "sessionPath", "projectCwd", "rootSessionPath", "startedAt", "updatedAt"] as const;
  for (const key of strings) if (typeof run[key] !== "string") return undefined;
  // A status the current vocabulary does not have (a record written before
  // `timed_out` was removed, D-144) is not read back: dropping the row is
  // honest, and beta data is not migrated.
  if (typeof run.status !== "string" || !(AGENT_RUN_STATUSES as readonly string[]).includes(run.status)) return undefined;
  return structuredClone(run as AgentRun);
}
