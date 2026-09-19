import type {
  AgentRun,
  ChangeScope,
  ChangedFile as ProtocolChangedFile,
  CheckpointInfo,
  ClientMethod,
  ClientRequests,
  FileSlice,
  GitActionExpect,
  ProjectChanges,
  ProjectChangesParams,
} from "@lasercode/protocol";
import { FILE_BLOB_PAGE_MAX_BYTES, FILE_DIFF_MAX_BYTES } from "@lasercode/protocol";

import type { AppState } from "@/store";

import type {
  AgentChangesContext,
  ChangedFile,
  ChangedRepo,
  ChangesList,
  ChangesScope,
  FileDiffPage,
} from "./contract.js";
import type { ChangesDataAdapter } from "./data.js";
import { CHANGES_NEED_SESSION } from "./errors.js";
import { bindWorkspaceShapeRequest, readWorkspaceShape } from "./workspace-shape.js";

export type ChangesHostRequest = <M extends ClientMethod>(
  method: M,
  params: ClientRequests[M]["params"],
) => Promise<ClientRequests[M]["result"]>;

export type ChangesSessionContext = {
  cwd: string;
  path: string;
  workdir?: string;
};

export function resolveChangesSession(
  state: Pick<AppState, "open" | "sessions" | "current">,
  sessionKey: string,
): ChangesSessionContext | null {
  const key = sessionKey && sessionKey !== "default" ? sessionKey : state.current;
  if (!key) return null;
  const view = state.open[key];
  const summary = state.sessions.find((row) => row.path === key);
  const cwd = view?.state.cwd ?? summary?.cwd;
  const path = view?.path ?? summary?.path ?? key;
  if (!cwd || !path) return null;
  return { cwd, path };
}

export function mapChangedFile(file: ProtocolChangedFile): ChangedFile {
  const binary = file.added === null || file.removed === null;
  return {
    path: file.path,
    status: binary ? "binary" : file.status,
    // Kept whether or not `status` collapsed: without it an added picture and
    // a deleted one are indistinguishable, and neither can be drawn.
    change: file.status,
    added: file.added ?? 0,
    removed: file.removed ?? 0,
  };
}

export function mapProjectChanges(result: ProjectChanges, scope: ChangesScope): ChangesList {
  const repos: ChangedRepo[] = result.repos.map((repo) => ({
    repo: repo.repo,
    branch: repo.branch,
    files: repo.files.map(mapChangedFile),
  }));
  return { scope, repos, ...(result.agent ? { agent: result.agent } : {}) };
}

export function mapFileSlice(slice: FileSlice, meta?: ChangedFile): FileDiffPage {
  const binary = slice.binary === true || meta?.status === "binary";
  return {
    repo: slice.repo,
    path: slice.path,
    status: binary ? "binary" : (meta?.status ?? "modified"),
    added: meta?.added ?? 0,
    removed: meta?.removed ?? 0,
    ...(meta?.change !== undefined ? { change: meta.change } : {}),
    ...(meta?.oldPath !== undefined ? { oldPath: meta.oldPath } : {}),
    ...(meta?.mode !== undefined ? { mode: meta.mode } : {}),
    ...(meta?.prevMode !== undefined ? { prevMode: meta.prevMode } : {}),
    ...(meta?.size !== undefined ? { size: meta.size } : {}),
    ...(meta?.oldSize !== undefined ? { oldSize: meta.oldSize } : {}),
    patch: slice.text ?? "",
    offset: slice.offset,
    bytes: slice.bytes,
    ...(slice.next !== undefined ? { nextOffset: slice.next } : {}),
    truncated: slice.truncated,
  };
}

export function mapAgentRunContext(run: AgentRun, facts?: ProjectChanges["agent"]): AgentChangesContext {
  const tree = run.worktree;
  if (!tree) {
    return { runId: run.runId, checkout: "shared", ...(facts?.branchGone ? { branchGone: true } : {}) };
  }
  // `removedAt` is the directory. `facts.branchGone` is computed from git on
  // `pi/project/changes` — never guessed from an error string or from missing counts.
  return {
    runId: run.runId,
    checkout: "worktree",
    worktreePath: tree.path,
    branch: tree.branch,
    baseCommit: tree.baseCommit,
    ...(tree.removedAt || facts?.worktreeRemoved ? { worktreeRemoved: true } : {}),
    ...(facts?.branchGone ? { branchGone: true } : {}),
  };
}

export function projectChangesParams(scope: ChangesScope, session: ChangesSessionContext): ProjectChangesParams {
  const params: ProjectChangesParams = {
    cwd: session.cwd,
    path: session.path,
    scope: scope.kind as ChangeScope,
    ...(session.workdir ? { workdir: session.workdir } : {}),
  };
  if (scope.kind === "turn") {
    const turn = Number.parseInt(scope.turnId, 10);
    if (Number.isInteger(turn) && turn >= 0) params.turn = turn;
  } else if (scope.kind === "range") {
    params.fromRef = scope.from;
    params.toRef = scope.to;
  } else if (scope.kind === "agent") {
    params.runId = scope.runId;
  }
  return params;
}

/**
 * One end of the range a scope's patch actually spans.
 *
 * `ref` is something the engine can resolve on its own — a commit, a branch
 * ref, or the literal `"worktree"`, which is how `pi/project/file_source`
 * names the files on disk. `checkpoint` is a hidden session checkpoint whose
 * commit only the checkpoint list knows, per repository.
 */
export type SourceEnd = { kind: "ref"; ref: string } | { kind: "checkpoint"; turn: number | "first" };

/** What the overlay knows about an agent run when it asks for a side. */
export type AgentEnds = { isolated: boolean; baseCommit?: string };

/**
 * The two ends of each scope, matched line for line against what the worker
 * diffs (`packages/worker/src/source-control/changes.ts`, `resolveScopeRange`):
 *
 * | scope | old (`from`) | new (`to`) |
 * | --- | --- | --- |
 * | session | first checkpoint that was kept and did not fail | the working tree (the worker diffs a write-tree snapshot of it) |
 * | turn N | checkpoint N−1 | checkpoint N |
 * | uncommitted | `HEAD` | the working tree |
 * | range | `from` | `to` |
 * | agent, isolated | the run's base commit | the run's working tree (the engine substitutes the branch head when the worktree is gone) |
 * | agent, shared checkout | first checkpoint — the worker falls back to the session range for a run with no worktree | the working tree |
 *
 * Before this, every scope but `range` asked for `undefined` on the old side,
 * and the engine reads `undefined` as the working tree — so both sides came
 * back as the file on disk. Hydrating a patch with two identical sides makes
 * the renderer count one more trailing line on one side than on the other,
 * and it throws mid-render (`trailing context mismatch`).
 */
export function scopeSourceEnds(
  scope: ChangesScope,
  agent?: AgentEnds,
): { old: SourceEnd | undefined; new: SourceEnd | undefined } {
  const worktree: SourceEnd = { kind: "ref", ref: "worktree" };
  switch (scope.kind) {
    case "session":
      return { old: { kind: "checkpoint", turn: "first" }, new: worktree };
    case "turn": {
      const turn = Number.parseInt(scope.turnId, 10);
      // Turn 0 is the open-time baseline, which the worker refuses as a range.
      if (!Number.isInteger(turn) || turn < 1) return { old: undefined, new: undefined };
      return { old: { kind: "checkpoint", turn: turn - 1 }, new: { kind: "checkpoint", turn } };
    }
    case "uncommitted":
      return { old: { kind: "ref", ref: "HEAD" }, new: worktree };
    case "range":
      return { old: { kind: "ref", ref: scope.from }, new: { kind: "ref", ref: scope.to } };
    case "agent": {
      if (agent && !agent.isolated) return { old: { kind: "checkpoint", turn: "first" }, new: worktree };
      return {
        old: agent?.baseCommit ? { kind: "ref", ref: agent.baseCommit } : undefined,
        new: worktree,
      };
    }
  }
}

/**
 * The checkpoint commit for one repository. A session spanning two
 * repositories has one ref name and two different commits, so `commit` alone
 * is only right when the list is from a source that never carried the
 * per-repository rows.
 */
export function checkpointCommitFor(row: CheckpointInfo, repo: string): string | undefined {
  if (!row.repos || row.repos.length === 0) return row.commit;
  return row.repos.find((item) => item.repo === repo)?.commit;
}

function withAgentWorkdir(
  session: ChangesSessionContext,
  scope: ChangesScope,
  agentRun: ((runId: string) => AgentRun | undefined) | undefined,
): ChangesSessionContext {
  if (scope.kind !== "agent") return session;
  const run = agentRun?.(scope.runId);
  const workdir = run?.cwd ?? run?.worktree?.path;
  if (!workdir) return session;
  return { ...session, workdir };
}

export function createHostChangesAdapter(opts: {
  request: ChangesHostRequest;
  session: () => ChangesSessionContext | null;
  agentRun?: (runId: string) => AgentRun | undefined;
  scope?: () => ChangesScope;
}): ChangesDataAdapter {
  const needSession = (): ChangesSessionContext => {
    const session = opts.session();
    if (!session) throw new Error(CHANGES_NEED_SESSION);
    return session;
  };
  // One checkpoint list per burst of requests: the overlay asks for both
  // sides of a file at once, and they need the same answer. Not cached beyond
  // that — a turn captured while the overlay is open must be visible to the
  // next file that is opened.
  let inflightCheckpoints: Promise<readonly CheckpointInfo[]> | undefined;
  const checkpoints = async (session: ChangesSessionContext): Promise<readonly CheckpointInfo[]> => {
    if (!inflightCheckpoints) {
      inflightCheckpoints = opts
        .request("pi/project/checkpoint/list", { cwd: session.cwd, path: session.path })
        .then((result) => result.checkpoints ?? [])
        .catch(() => [] as readonly CheckpointInfo[])
        .finally(() => {
          inflightCheckpoints = undefined;
        });
    }
    return inflightCheckpoints;
  };
  const resolveEnd = async (
    end: SourceEnd | undefined,
    session: ChangesSessionContext,
    repo: string,
  ): Promise<string | undefined> => {
    if (!end) return undefined;
    if (end.kind === "ref") return end.ref;
    const kept = (await checkpoints(session)).filter((row) => row.failed !== true);
    const row = end.turn === "first" ? kept[0] : kept.find((item) => item.turn === end.turn);
    if (!row) return undefined;
    return checkpointCommitFor(row, repo);
  };
  const gitTarget = (): { cwd: string; runId?: string } => {
    const session = needSession();
    const scope = opts.scope?.();
    return {
      cwd: session.cwd,
      ...(scope?.kind === "agent" ? { runId: scope.runId } : {}),
    };
  };

  return {
    async listChanges(scope) {
      const session = withAgentWorkdir(needSession(), scope, opts.agentRun);
      const result = await opts.request("pi/project/changes", projectChangesParams(scope, session));
      return mapProjectChanges(result, scope);
    },
    async getFileDiff(scope, repo, path, options) {
      const session = withAgentWorkdir(needSession(), scope, opts.agentRun);
      const params = {
        ...projectChangesParams(scope, session),
        repo,
        file: path,
        offset: options?.offset ?? 0,
        limit: FILE_DIFF_MAX_BYTES,
      };
      const slice = await opts.request("pi/project/file_diff", params);
      return mapFileSlice(slice);
    },
    async getWorkspace(options) {
      const session = needSession();
      bindWorkspaceShapeRequest((params) => opts.request("pi/project/workspace", params));
      return readWorkspaceShape(session.cwd, options);
    },
    async getFileSource(scope, repo, path, side) {
      const session = withAgentWorkdir(needSession(), scope, opts.agentRun);
      const run = scope.kind === "agent" ? opts.agentRun?.(scope.runId) : undefined;
      const agent: AgentEnds | undefined =
        scope.kind === "agent"
          ? {
              isolated: Boolean(run?.worktree),
              ...(run?.worktree?.baseCommit ? { baseCommit: run.worktree.baseCommit } : {}),
            }
          : undefined;
      const ref = await resolveEnd(scopeSourceEnds(scope, agent)[side], session, repo);
      // No ref means we cannot name this end, and the engine reads a missing
      // ref as the working tree — which would be the wrong side. Refuse
      // instead: the file opens at its hunks and says why.
      if (!ref) return null;
      const slice = await opts.request("pi/project/file_source", {
        cwd: session.cwd,
        path: session.path,
        repo,
        file: path,
        ref,
        // The agent scope's own end: with the run named, the engine answers
        // `worktree` from the run's branch head once its worktree is gone,
        // which is the side its patch was computed against.
        ...(scope.kind === "agent" ? { runId: scope.runId } : {}),
        ...(session.workdir ? { workdir: session.workdir } : {}),
        offset: 0,
        limit: FILE_DIFF_MAX_BYTES,
      });
      if (slice.binary || slice.text === undefined) return null;
      return {
        repo: slice.repo,
        path: slice.path,
        ref,
        contents: slice.text,
        ...(slice.truncated === true ? { truncated: true } : {}),
      };
    },
    /**
     * One page of one side's bytes, for a file with no textual diff. The side
     * is resolved exactly as `getFileSource` resolves it — same table, same
     * refusal when we cannot name an end — so the picture a person sees is
     * the one the patch was computed from, never the working tree standing in
     * for a ref.
     */
    async getFileBytes(scope, repo, path, side, options) {
      const session = withAgentWorkdir(needSession(), scope, opts.agentRun);
      const run = scope.kind === "agent" ? opts.agentRun?.(scope.runId) : undefined;
      const agent: AgentEnds | undefined =
        scope.kind === "agent"
          ? {
              isolated: Boolean(run?.worktree),
              ...(run?.worktree?.baseCommit ? { baseCommit: run.worktree.baseCommit } : {}),
            }
          : undefined;
      const ref = await resolveEnd(scopeSourceEnds(scope, agent)[side], session, repo);
      if (!ref) return null;
      return opts.request("pi/project/file_blob", {
        cwd: session.cwd,
        path: session.path,
        repo,
        file: path,
        ref,
        ...(scope.kind === "agent" ? { runId: scope.runId } : {}),
        ...(session.workdir ? { workdir: session.workdir } : {}),
        offset: options?.offset ?? 0,
        limit: FILE_BLOB_PAGE_MAX_BYTES,
      });
    },
    async getAgentContext(runId) {
      const run = opts.agentRun?.(runId);
      if (!run) {
        return { runId, checkout: "shared" };
      }
      return mapAgentRunContext(run);
    },
    async gitHosts(repos) {
      return opts.request("pi/project/git/hosts", {
        ...gitTarget(),
        ...(repos && repos.length ? { repos } : {}),
      });
    },
    async gitProse(params) {
      const session = needSession();
      return opts.request("pi/project/git/prose", {
        ...gitTarget(),
        path: session.path,
        kind: params.kind,
        files: params.files,
        ...(params.repo ? { repo: params.repo } : {}),
        ...(params.summary ? { summary: params.summary } : {}),
      });
    },
    async gitCommit(params) {
      return opts.request("pi/project/git/commit", {
        ...gitTarget(),
        paths: params.paths,
        message: params.message,
        ...gitWriteFields(params),
      });
    },
    async gitPush(params) {
      return opts.request("pi/project/git/push", {
        ...gitTarget(),
        remote: params.remote,
        branch: params.branch,
        ...gitWriteFields(params),
      });
    },
    async gitBranch(params) {
      return opts.request("pi/project/git/branch", {
        ...gitTarget(),
        name: params.name,
        base: params.base,
        ...(params.checkout ? { checkout: true } : {}),
        ...gitWriteFields(params),
      });
    },
    async gitPrCreate(params) {
      return opts.request("pi/project/pr/create", {
        ...gitTarget(),
        title: params.title,
        body: params.body,
        base: params.base,
        head: params.head,
        ...gitWriteFields(params),
      });
    },
    async gitPrRead(params) {
      return opts.request("pi/project/pr/read", {
        ...gitTarget(),
        number: params.number,
        ...(params.repo ? { repo: params.repo } : {}),
      });
    },
    async gitPrCheckout(params) {
      return opts.request("pi/project/pr/checkout", {
        ...gitTarget(),
        number: params.number,
        ...gitWriteFields(params),
      });
    },
    async gitPrMerge(params) {
      return opts.request("pi/project/pr/merge", {
        ...gitTarget(),
        number: params.number,
        method: params.method,
        ...gitWriteFields(params),
      });
    },
    async gitPrViewed(params) {
      return opts.request("pi/project/pr/viewed", {
        ...gitTarget(),
        number: params.number,
        path: params.path,
        viewed: params.viewed,
        ...(params.repo ? { repo: params.repo } : {}),
      });
    },
  };
}

function gitWriteFields(params: { repo?: string; confirm?: boolean; expect?: GitActionExpect }): {
  repo?: string;
  confirm?: true;
  expect?: GitActionExpect;
} {
  return {
    ...(params.repo ? { repo: params.repo } : {}),
    ...(params.confirm === true ? { confirm: true as const } : {}),
    ...(params.expect ? { expect: params.expect } : {}),
  };
}
