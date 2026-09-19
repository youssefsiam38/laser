import type {
  AgentRun,
  ChangeScope,
  ChangedFile as ProtocolChangedFile,
  ClientMethod,
  ClientRequests,
  FileSlice,
  GitActionExpect,
  ProjectChanges,
  ProjectChangesParams,
} from "@lasercode/protocol";
import { FILE_DIFF_MAX_BYTES } from "@lasercode/protocol";

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
  return { scope, repos };
}

export function mapFileSlice(slice: FileSlice, meta?: ChangedFile): FileDiffPage {
  const binary = slice.binary === true || meta?.status === "binary";
  return {
    repo: slice.repo,
    path: slice.path,
    status: binary ? "binary" : (meta?.status ?? "modified"),
    added: meta?.added ?? 0,
    removed: meta?.removed ?? 0,
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

export function mapAgentRunContext(run: AgentRun): AgentChangesContext {
  const tree = run.worktree;
  if (!tree) {
    return { runId: run.runId, checkout: "shared" };
  }
  // `removedAt` means the directory is gone. The branch name stays on the
  // record as history (AgentWorktree). That is the surviving-branch overlay
  // state — not `branchGone`. AgentWorktree has no field for a deleted git
  // branch, so this mapper never sets `branchGone`.
  return {
    runId: run.runId,
    checkout: "worktree",
    worktreePath: tree.path,
    branch: tree.branch,
    baseCommit: tree.baseCommit,
    ...(tree.removedAt ? { worktreeRemoved: true } : {}),
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

export function sourceRef(scope: ChangesScope, side: "old" | "new"): string | undefined {
  if (scope.kind === "range") return side === "old" ? scope.from : scope.to;
  if (side === "new") return "worktree";
  return undefined;
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
}): ChangesDataAdapter {
  const needSession = (): ChangesSessionContext => {
    const session = opts.session();
    if (!session) throw new Error(CHANGES_NEED_SESSION);
    return session;
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
    async getFileSource(scope, repo, path, side) {
      const session = withAgentWorkdir(needSession(), scope, opts.agentRun);
      const ref = sourceRef(scope, side);
      const slice = await opts.request("pi/project/file_source", {
        cwd: session.cwd,
        path: session.path,
        repo,
        file: path,
        ...(ref ? { ref } : {}),
        ...(session.workdir ? { workdir: session.workdir } : {}),
        offset: 0,
        limit: FILE_DIFF_MAX_BYTES,
      });
      if (slice.binary || slice.text === undefined) return null;
      return { repo: slice.repo, path: slice.path, ref: ref ?? side, contents: slice.text };
    },
    async getAgentContext(runId) {
      const run = opts.agentRun?.(runId);
      if (!run) {
        return { runId, checkout: "shared" };
      }
      return mapAgentRunContext(run);
    },
    async gitHosts(repos) {
      const session = needSession();
      return opts.request("pi/project/git/hosts", {
        cwd: session.cwd,
        ...(repos && repos.length ? { repos } : {}),
      });
    },
    async gitProse(params) {
      const session = needSession();
      return opts.request("pi/project/git/prose", {
        cwd: session.cwd,
        path: session.path,
        kind: params.kind,
        files: params.files,
        ...(params.repo ? { repo: params.repo } : {}),
        ...(params.summary ? { summary: params.summary } : {}),
      });
    },
    async gitCommit(params) {
      const session = needSession();
      return opts.request("pi/project/git/commit", {
        cwd: session.cwd,
        paths: params.paths,
        message: params.message,
        ...gitWriteFields(params),
      });
    },
    async gitPush(params) {
      const session = needSession();
      return opts.request("pi/project/git/push", {
        cwd: session.cwd,
        remote: params.remote,
        branch: params.branch,
        ...gitWriteFields(params),
      });
    },
    async gitBranch(params) {
      const session = needSession();
      return opts.request("pi/project/git/branch", {
        cwd: session.cwd,
        name: params.name,
        base: params.base,
        ...(params.checkout ? { checkout: true } : {}),
        ...gitWriteFields(params),
      });
    },
    async gitPrCreate(params) {
      const session = needSession();
      return opts.request("pi/project/pr/create", {
        cwd: session.cwd,
        title: params.title,
        body: params.body,
        base: params.base,
        head: params.head,
        ...gitWriteFields(params),
      });
    },
    async gitPrRead(params) {
      const session = needSession();
      return opts.request("pi/project/pr/read", {
        cwd: session.cwd,
        number: params.number,
        ...(params.repo ? { repo: params.repo } : {}),
      });
    },
    async gitPrCheckout(params) {
      const session = needSession();
      return opts.request("pi/project/pr/checkout", {
        cwd: session.cwd,
        number: params.number,
        ...gitWriteFields(params),
      });
    },
    async gitPrMerge(params) {
      const session = needSession();
      return opts.request("pi/project/pr/merge", {
        cwd: session.cwd,
        number: params.number,
        method: params.method,
        ...gitWriteFields(params),
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
