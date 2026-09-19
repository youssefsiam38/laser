import {
  ErrorCodes,
  FILE_DIFF_MAX_BYTES,
  ProtocolError,
  checkpointRetentionKeep,
  type AgentRun,
  type CheckpointList,
  type FileSlice,
  type ProjectChanges,
  type ProjectChangesParams,
  type ProjectFileDiffParams,
  type ProjectFileSourceParams,
  type ProjectRestoreParams,
  type RestoreResult,
} from "@lasercode/protocol";
import { captureCheckpoint } from "./capture.js";
import {
  filterTouched,
  loadCheckpoints,
  repoChanges,
  resolveScopeRange,
  type ScopeQuery,
} from "./changes.js";
import { fileDiff, fileSource } from "./diff.js";
import { listSessionCheckpoints } from "./refs.js";
import { sessionRepositories, type RepoRef } from "./repositories.js";
import { pruneSessionCheckpoints } from "./retention.js";
import { restoreFiles, restorePreview } from "./restore.js";
import { readCheckpointRetention } from "./settings.js";

export interface SourceControlDeps {
  projectCwd: string;
  sessionWorkdir(path: string): string | undefined;
  sessionStreaming(path: string): boolean;
  agentRun(runId: string): AgentRun | undefined;
  navigate?(path: string, entryId: string): Promise<{ cancelled: boolean }>;
}

export class SourceControlService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastError = new Map<string, string>();

  constructor(private readonly deps: SourceControlDeps) {}

  workdir(path: string, explicit?: string): string {
    return explicit ?? this.deps.sessionWorkdir(path) ?? this.deps.projectCwd;
  }

  async captureBaseline(sessionPath: string, workdir: string, entryId?: string): Promise<void> {
    await this.enqueue(sessionPath, async () => {
      const repos = await sessionRepositories(workdir);
      if (repos.length === 0) return;
      const existing = await loadCheckpoints(repos, sessionPath);
      if (existing.length > 0) return;
      await this.captureTurn(sessionPath, 0, entryId, repos);
    });
  }

  async captureAfterTurn(sessionPath: string, workdir: string, entryId?: string): Promise<void> {
    await this.enqueue(sessionPath, async () => {
      const repos = await sessionRepositories(workdir);
      if (repos.length === 0) return;
      const existing = await loadCheckpoints(repos, sessionPath);
      const turn = existing.length === 0 ? 0 : existing[existing.length - 1]!.turn + 1;
      await this.captureTurn(sessionPath, turn, entryId, repos);
    });
  }

  async changes(params: ProjectChangesParams): Promise<ProjectChanges> {
    const workdir = this.workdir(params.path, params.workdir);
    const repos = await this.reposFor(workdir, params);
    const checkpoints = await loadCheckpoints(repos, params.path);
    const query = this.scopeQuery(params, checkpoints);
    let pruned = undefined as ProjectChanges["pruned"];
    const out: ProjectChanges = { scope: params.scope, repos: [] };
    for (const repo of repos) {
      const range = await resolveScopeRange(repo, query, await listSessionCheckpoints(repo, params.path));
      if (range.pruned) pruned = range.pruned;
      out.repos.push(await repoChanges(repo, range));
    }
    if (pruned) out.pruned = pruned;
    return filterTouched(out);
  }

  async fileDiff(params: ProjectFileDiffParams): Promise<FileSlice> {
    const repo = await this.repoNamed(params);
    const checkpoints = await listSessionCheckpoints(repo, params.path);
    const range = await resolveScopeRange(repo, this.scopeQuery(params, checkpoints), checkpoints);
    return fileDiff(repo, range, params.file, params.context ?? 3, params.offset ?? 0, params.limit ?? FILE_DIFF_MAX_BYTES);
  }

  async fileSource(params: ProjectFileSourceParams): Promise<FileSlice> {
    const repo = await this.repoNamed(params);
    return fileSource(repo, params.file, params.ref, params.offset ?? 0, params.limit ?? FILE_DIFF_MAX_BYTES);
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

  async restore(params: ProjectRestoreParams): Promise<RestoreResult> {
    if (this.deps.sessionStreaming(params.path)) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        "A turn is running, so this conversation cannot be restored until it finishes or is stopped.",
      );
    }
    const workdir = this.workdir(params.path, params.workdir);
    const repos = await sessionRepositories(workdir);
    const checkpoints = await loadCheckpoints(repos, params.path);
    const preview = await restorePreview(repos, checkpoints, params.turn, params.restore);
    if (!params.confirm) return { preview };
    if (preview.hidden.includes(params.restore) || (params.restore === "both" && preview.hidden.includes("files") && preview.hidden.includes("conversation"))) {
      return { preview, restored: { files: false, conversation: false } };
    }
    const checkpoint = checkpoints.find((row) => row.turn === params.turn);
    if (!checkpoint) throw new ProtocolError(ErrorCodes.InvalidParams, "That turn's checkpoint is no longer kept.");
    let files = false;
    let conversation = false;
    if (params.restore !== "conversation" && !preview.hidden.includes("files")) {
      for (const repo of repos) await restoreFiles(repo, checkpoint.commit);
      files = true;
    }
    if (params.restore !== "files" && checkpoint.entryId && !preview.hidden.includes("conversation")) {
      if (!this.deps.navigate) {
        throw new ProtocolError(ErrorCodes.SessionNotFound, "Open this conversation to restore it.");
      }
      await this.deps.navigate(params.path, checkpoint.entryId);
      conversation = true;
    }
    return { preview, restored: { files, conversation } };
  }

  private async captureTurn(
    sessionPath: string,
    turn: number,
    entryId: string | undefined,
    repos: RepoRef[],
  ): Promise<void> {
    const retention = readCheckpointRetention(this.deps.projectCwd);
    if (checkpointRetentionKeep(retention) === 0) {
      for (const repo of repos) await pruneSessionCheckpoints(repo, sessionPath, retention);
      return;
    }
    const errors: string[] = [];
    for (const repo of repos) {
      const result = await captureCheckpoint({
        repo,
        sessionPath,
        turn,
        ...(entryId ? { entryId } : {}),
      });
      if (!result.ok) errors.push(result.error);
      else await pruneSessionCheckpoints(repo, sessionPath, retention);
    }
    if (errors.length > 0) this.lastError.set(sessionPath, errors[0]!);
    else this.lastError.delete(sessionPath);
  }

  private scopeQuery(params: ProjectChangesParams | ProjectFileDiffParams, checkpoints: { turn: number }[]): ScopeQuery {
    const query: ScopeQuery = { scope: params.scope, sessionPath: params.path };
    if (params.turn !== undefined) query.turn = params.turn;
    else if (params.scope === "turn" && checkpoints.length > 0) query.turn = checkpoints[checkpoints.length - 1]!.turn;
    if (params.fromRef) query.fromRef = params.fromRef;
    if (params.toRef) query.toRef = params.toRef;
    if (params.runId) {
      const run = this.deps.agentRun(params.runId);
      if (!run) throw new ProtocolError(ErrorCodes.InvalidParams, "That agent run is not known.");
      if (!run.worktree) {
        // Shared checkout: agent scope is this session's checkpoints.
        query.scope = "session";
      } else if (run.worktree.removedAt) {
        throw new ProtocolError(ErrorCodes.InvalidParams, "That agent's worktree is gone, so its changes cannot be shown.");
      } else {
        query.baseCommit = run.worktree.baseCommit;
      }
    }
    return query;
  }

  private async reposFor(workdir: string, params: ProjectChangesParams): Promise<RepoRef[]> {
    if (params.scope === "agent" && params.runId) {
      const run = this.deps.agentRun(params.runId);
      if (run?.worktree && !run.worktree.removedAt) {
        const repos = await sessionRepositories(run.worktree.path);
        if (repos.length === 0) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That agent's worktree is gone, so its changes cannot be shown.");
        }
        return repos;
      }
    }
    return sessionRepositories(workdir);
  }

  private async repoNamed(params: { cwd: string; path: string; repo: string; workdir?: string; runId?: string; scope?: string }): Promise<RepoRef> {
    const workdir = this.workdir(params.path, params.workdir);
    const repos = await sessionRepositories(workdir);
    const match = repos.find((repo) => repo.path === params.repo);
    if (!match) throw new ProtocolError(ErrorCodes.InvalidParams, "That repository is not part of this session.");
    return match;
  }

  private enqueue(sessionPath: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionPath) ?? Promise.resolve();
    const next = previous.then(work, work).catch((error: unknown) => {
      this.lastError.set(sessionPath, error instanceof Error ? error.message : String(error));
    });
    this.queues.set(sessionPath, next);
    return next;
  }
}
