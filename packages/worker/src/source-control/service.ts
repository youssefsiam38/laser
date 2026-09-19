import {
  ErrorCodes,
  FILE_DIFF_MAX_BYTES,
  ProtocolError,
  checkpointRetentionKeep,
  type AgentRun,
  type AgentScopeFacts,
  type CheckpointList,
  type FileSlice,
  type ProjectChanges,
  type ProjectChangesParams,
  type ProjectFileDiffParams,
  type ProjectFileSourceParams,
  type ProjectRestoreParams,
  type RestoreRepoResult,
  type RestoreResult,
} from "@lasercode/protocol";
import { resolve } from "node:path";
import { captureCheckpoint, publishFailedCheckpoint } from "./capture.js";
import {
  branchExists,
  filterTouched,
  headsRef,
  loadCheckpoints,
  repoChanges,
  resolveScopeRange,
  type ScopeQuery,
} from "./changes.js";
import { fileDiff, fileSource } from "./diff.js";
import { deleteAllCheckpointRefs, listSessionCheckpoints } from "./refs.js";
import { sessionRepositories, type RepoRef } from "./repositories.js";
import { pruneSessionCheckpoints } from "./retention.js";
import { checkpointForRepo, restoreFiles, restorePreview, verifyRestoreSource } from "./restore.js";
import { readCheckpointRetention, writeCheckpointRetention } from "./settings.js";

export interface SourceControlDeps {
  projectCwd: string;
  sessionWorkdir(path: string): string | undefined;
  sessionStreaming(path: string): boolean;
  agentRun(runId: string): AgentRun | undefined;
  navigate?(path: string, entryId: string): Promise<{ cancelled: boolean }>;
}

export class SourceControlService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly pendingBaseline = new Map<string, () => Promise<void>>();
  private readonly pendingTurn = new Map<string, () => Promise<void>>();
  private readonly nextTurn = new Map<string, number>();
  private readonly lastError = new Map<string, string>();

  constructor(private readonly deps: SourceControlDeps) {}

  workdir(path: string, explicit?: string): string {
    return explicit ?? this.deps.sessionWorkdir(path) ?? this.deps.projectCwd;
  }

  private restoreWorkdir(path: string, explicit?: string): string {
    const session = this.deps.sessionWorkdir(path) ?? this.deps.projectCwd;
    if (!explicit) return session;
    if (resolve(explicit) !== resolve(session)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "Restore can only change this conversation's working files.");
    }
    return session;
  }

  async captureBaseline(sessionPath: string, workdir: string, entryId?: string): Promise<void> {
    this.pendingBaseline.set(sessionPath, async () => {
      const repos = await sessionRepositories(workdir);
      if (repos.length === 0) return;
      const existing = await loadCheckpoints(repos, sessionPath);
      if (existing.length > 0) return;
      await this.captureTurn(sessionPath, 0, entryId, repos);
    });
    await this.kick(sessionPath);
  }

  async captureAfterTurn(sessionPath: string, workdir: string, entryId?: string): Promise<void> {
    this.pendingTurn.set(sessionPath, async () => {
      const repos = await sessionRepositories(workdir);
      if (repos.length === 0) return;
      const existing = await loadCheckpoints(repos, sessionPath);
      const turn = this.takeTurn(sessionPath, existing);
      await this.captureTurn(sessionPath, turn, entryId, repos);
    });
    await this.kick(sessionPath);
  }

  async changes(params: ProjectChangesParams): Promise<ProjectChanges> {
    const workdir = this.workdir(params.path, params.workdir);
    const resolved = await this.resolveScope(workdir, params);
    const out: ProjectChanges = { scope: params.scope, repos: [], ...(resolved.agent ? { agent: resolved.agent } : {}) };
    if (resolved.agent?.branchGone) return out;
    const rows = await Promise.all(
      resolved.repos.map(async (repo) => {
        const range = await resolveScopeRange(repo, resolved.query, await listSessionCheckpoints(repo, params.path));
        return { range, changes: await repoChanges(repo, range) };
      }),
    );
    let pruned = undefined as ProjectChanges["pruned"];
    for (const row of rows) {
      if (row.range.pruned) pruned = row.range.pruned;
      out.repos.push(row.changes);
    }
    if (pruned) out.pruned = pruned;
    return filterTouched(out);
  }

  async fileDiff(params: ProjectFileDiffParams): Promise<FileSlice> {
    const workdir = this.workdir(params.path, params.workdir);
    const resolved = await this.resolveScope(workdir, params);
    if (resolved.agent?.branchGone) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That agent's branch is gone, so its changes cannot be shown.");
    }
    const repo = resolved.repos.find((row) => row.path === params.repo);
    if (!repo) throw new ProtocolError(ErrorCodes.InvalidParams, "That repository is not part of this session.");
    const checkpoints = await listSessionCheckpoints(repo, params.path);
    const range = await resolveScopeRange(repo, resolved.query, checkpoints);
    return fileDiff(repo, range, params.file, params.context ?? 3, params.offset ?? 0, params.limit ?? FILE_DIFF_MAX_BYTES);
  }

  async fileSource(params: ProjectFileSourceParams): Promise<FileSlice> {
    const workdir = this.workdir(params.path, params.workdir);
    const resolved = await this.resolveScope(workdir, { ...params, scope: params.runId ? "agent" : "session" });
    if (resolved.agent?.branchGone) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That agent's branch is gone, so its changes cannot be shown.");
    }
    const repo = resolved.repos.find((row) => row.path === params.repo);
    if (!repo) throw new ProtocolError(ErrorCodes.InvalidParams, "That repository is not part of this session.");
    let ref = params.ref;
    if ((!ref || ref === "worktree") && resolved.agent?.worktreeRemoved && !resolved.agent.branchGone) {
      const run = params.runId ? this.deps.agentRun(params.runId) : undefined;
      const heads = run?.worktree ? headsRef(run.worktree.branch) : undefined;
      if (heads) ref = heads;
    }
    return fileSource(repo, params.file, ref, params.offset ?? 0, params.limit ?? FILE_DIFF_MAX_BYTES);
  }

  async list(path: string, cwd: string): Promise<CheckpointList> {
    const workdir = this.workdir(path);
    const repos = await sessionRepositories(workdir);
    const checkpoints = await loadCheckpoints(repos, path);
    const retention = readCheckpointRetention(cwd);
    const error = this.lastError.get(path);
    return {
      path,
      retention,
      checkpoints,
      ...(error ? { lastError: error } : {}),
    };
  }

  async applyRetention(sessionPath: string, retention: ReturnType<typeof readCheckpointRetention>): Promise<void> {
    writeCheckpointRetention(this.deps.projectCwd, retention);
    const workdir = this.workdir(sessionPath);
    const repos = await sessionRepositories(workdir);
    if (checkpointRetentionKeep(retention) === 0) {
      await Promise.all(repos.map((repo) => deleteAllCheckpointRefs(repo)));
      return;
    }
    await Promise.all(repos.map((repo) => pruneSessionCheckpoints(repo, sessionPath, retention)));
  }

  async restore(params: ProjectRestoreParams): Promise<RestoreResult> {
    if (this.deps.sessionStreaming(params.path)) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        "A turn is running, so this conversation cannot be restored until it finishes or is stopped.",
      );
    }
    const workdir = this.restoreWorkdir(params.path, params.workdir);
    const repos = await sessionRepositories(workdir);
    const preview = await restorePreview(repos, params.path, params.turn, params.restore);
    if (!params.confirm) return { preview };
    if (preview.hidden.includes(params.restore) || (params.restore === "both" && preview.hidden.includes("files") && preview.hidden.includes("conversation"))) {
      return { preview, restored: { files: false, conversation: false, repos: [] } };
    }
    let files = false;
    let conversation = false;
    const repoResults: RestoreRepoResult[] = [];
    if (params.restore !== "conversation" && !preview.hidden.includes("files")) {
      const plans = await Promise.all(
        repos.map(async (repo) => {
          const checkpoint = await checkpointForRepo(repo, params.path, params.turn);
          if (!checkpoint) {
            return { repo, commit: undefined, error: "That turn's checkpoint is not in this repository, so its files were left unchanged." };
          }
          const source = await verifyRestoreSource(repo, checkpoint.commit);
          if (!source.ok) return { repo, commit: undefined, error: source.error };
          return { repo, commit: checkpoint.commit, error: undefined };
        }),
      );
      for (const plan of plans) {
        if (!plan.commit || plan.error) {
          repoResults.push({ repo: plan.repo.path, restored: false, ...(plan.error ? { detail: plan.error } : {}) });
          continue;
        }
        try {
          await restoreFiles(plan.repo, plan.commit);
          repoResults.push({ repo: plan.repo.path, restored: true });
          files = true;
        } catch (error) {
          repoResults.push({
            repo: plan.repo.path,
            restored: false,
            detail: error instanceof Error ? error.message : "Could not restore those files.",
          });
        }
      }
    }
    const checkpoints = await loadCheckpoints(repos, params.path);
    const checkpoint = checkpoints.find((row) => row.turn === params.turn && !row.failed);
    if (params.restore !== "files" && checkpoint?.entryId && !preview.hidden.includes("conversation")) {
      if (!this.deps.navigate) {
        throw new ProtocolError(ErrorCodes.SessionNotFound, "Open this conversation to restore it.");
      }
      await this.deps.navigate(params.path, checkpoint.entryId);
      conversation = true;
    }
    return { preview, restored: { files, conversation, repos: repoResults } };
  }

  private takeTurn(sessionPath: string, existing: { turn: number }[]): number {
    const fromRefs = existing.length === 0 ? 0 : existing[existing.length - 1]!.turn + 1;
    const fromMem = this.nextTurn.get(sessionPath) ?? 0;
    const turn = Math.max(fromRefs, fromMem);
    this.nextTurn.set(sessionPath, turn + 1);
    return turn;
  }

  private async captureTurn(
    sessionPath: string,
    turn: number,
    entryId: string | undefined,
    repos: RepoRef[],
  ): Promise<void> {
    this.nextTurn.set(sessionPath, Math.max(this.nextTurn.get(sessionPath) ?? 0, turn + 1));
    const retention = readCheckpointRetention(this.deps.projectCwd);
    if (checkpointRetentionKeep(retention) === 0) {
      await Promise.all(repos.map((repo) => pruneSessionCheckpoints(repo, sessionPath, retention)));
      return;
    }
    const errors: string[] = [];
    await Promise.all(
      repos.map(async (repo) => {
        const previous = (await listSessionCheckpoints(repo, sessionPath)).filter((row) => !row.failed).at(-1);
        const result = await captureCheckpoint({
          repo,
          sessionPath,
          turn,
          ...(entryId ? { entryId } : {}),
        });
        if (!result.ok) {
          errors.push(result.error);
          await publishFailedCheckpoint(
            { repo, sessionPath, turn, ...(entryId ? { entryId } : {}) },
            previous?.commit,
          );
          return;
        }
        await pruneSessionCheckpoints(repo, sessionPath, retention);
      }),
    );
    if (errors.length > 0) this.lastError.set(sessionPath, errors[0]!);
    else this.lastError.delete(sessionPath);
  }

  private baseScopeQuery(
    params: Pick<ProjectChangesParams, "scope" | "path" | "turn" | "fromRef" | "toRef">,
    checkpoints: { turn: number }[],
  ): ScopeQuery {
    const query: ScopeQuery = { scope: params.scope, sessionPath: params.path };
    if (params.turn !== undefined) query.turn = params.turn;
    else if (params.scope === "turn" && checkpoints.length > 0) query.turn = checkpoints[checkpoints.length - 1]!.turn;
    if (params.fromRef) query.fromRef = params.fromRef;
    if (params.toRef) query.toRef = params.toRef;
    return query;
  }

  private async resolveScope(
    workdir: string,
    params: {
      path: string;
      scope?: ProjectChangesParams["scope"];
      runId?: string;
      turn?: number;
      fromRef?: string;
      toRef?: string;
    },
  ): Promise<{ repos: RepoRef[]; query: ScopeQuery; agent?: AgentScopeFacts }> {
    if (params.runId && (params.scope === "agent" || params.scope === undefined)) {
      return this.resolveAgentScope(workdir, params.path, params.runId);
    }
    const repos = await sessionRepositories(workdir);
    const checkpoints = await loadCheckpoints(repos, params.path);
    const scope = params.scope ?? "session";
    return { repos, query: this.baseScopeQuery({ ...params, scope, path: params.path }, checkpoints) };
  }

  private async resolveAgentScope(
    workdir: string,
    sessionPath: string,
    runId: string,
  ): Promise<{ repos: RepoRef[]; query: ScopeQuery; agent: AgentScopeFacts }> {
    const run = this.deps.agentRun(runId);
    if (!run) throw new ProtocolError(ErrorCodes.InvalidParams, "That agent run is not known.");
    const agent: AgentScopeFacts = { runId };
    if (!run.worktree) {
      const repos = await sessionRepositories(workdir);
      const checkpoints = await loadCheckpoints(repos, sessionPath);
      return {
        repos,
        query: this.baseScopeQuery({ scope: "session", path: sessionPath }, checkpoints),
        agent,
      };
    }
    if (!run.worktree.removedAt) {
      const live = await sessionRepositories(run.worktree.path);
      if (live.length > 0) {
        return {
          repos: live,
          query: { scope: "agent", sessionPath, baseCommit: run.worktree.baseCommit },
          agent,
        };
      }
    }
    agent.worktreeRemoved = true;
    const parent = run.worktree.environment?.parentCheckout ?? run.projectCwd ?? workdir;
    const repos = await sessionRepositories(parent);
    const heads = headsRef(run.worktree.branch);
    const exists = Boolean(heads) && repos.length > 0 && (await branchExists(repos[0]!, run.worktree.branch));
    if (!heads || !exists) {
      agent.branchGone = true;
      return {
        repos: [],
        query: { scope: "agent", sessionPath, baseCommit: run.worktree.baseCommit },
        agent,
      };
    }
    return {
      repos,
      query: {
        scope: "agent",
        sessionPath,
        baseCommit: run.worktree.baseCommit,
        toRef: heads,
      },
      agent,
    };
  }

  private async kick(sessionPath: string): Promise<void> {
    const existing = this.inflight.get(sessionPath);
    if (existing) return existing;
    const run = (async () => {
      try {
        while (this.pendingBaseline.has(sessionPath) || this.pendingTurn.has(sessionPath)) {
          const baseline = this.pendingBaseline.get(sessionPath);
          if (baseline) {
            this.pendingBaseline.delete(sessionPath);
            await baseline();
            continue;
          }
          const turn = this.pendingTurn.get(sessionPath);
          if (!turn) break;
          this.pendingTurn.delete(sessionPath);
          await turn();
        }
      } catch (error: unknown) {
        this.lastError.set(sessionPath, error instanceof Error ? error.message : String(error));
      } finally {
        this.inflight.delete(sessionPath);
        if (this.pendingBaseline.has(sessionPath) || this.pendingTurn.has(sessionPath)) {
          void this.kick(sessionPath);
        }
      }
    })();
    this.inflight.set(sessionPath, run);
    return run;
  }
}
