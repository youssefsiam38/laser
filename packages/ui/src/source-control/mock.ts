import type {
  GitActionConfirmation,
  GitActionExpect,
  GitActionResult,
  GitHostStatus,
  GitProseKind,
} from "@lasercode/protocol";

import type {
  AgentChangesContext,
  ChangesList,
  ChangesScope,
  ChangedFile,
  FileDiffPage,
  FileSource,
} from "./contract.js";
import type { ChangesDataAdapter } from "./data.js";

const MODIFIED_PATCH = `diff --git a/src/body-range.ts b/src/body-range.ts
index 1111111..2222222 100644
--- a/src/body-range.ts
+++ b/src/body-range.ts
@@ -1,6 +1,9 @@
 export function greet(name: string): string {
-  return "hi " + name;
+  const bytes = utf8ByteLength(name);
+  recordBytes.set(name, bytes);
+  return "hi " + name;
 }
`;

const DELETED_PATCH = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const leftover = true;
-export function doomed() {
-}
`;

const ADDED_PATCH = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,4 @@
+export function created() {
+  return 1;
+}
+
`;

const CONNECTING_PATCH = `diff --git a/lib/client.ts b/lib/client.ts
index 1111111..2222222 100644
--- a/lib/client.ts
+++ b/lib/client.ts
@@ -1,3 +1,4 @@
 export const version = 1;
+export const ready = true;
`;

const VIEWPORT_PATCH = `diff --git a/src/transcript-viewport.tsx b/src/transcript-viewport.tsx
index 1111111..2222222 100644
--- a/src/transcript-viewport.tsx
+++ b/src/transcript-viewport.tsx
@@ -10,6 +10,8 @@
   const follow = true;
+  const bytes = utf8ByteLength(entry);
+  recordBytes.set(entry, bytes);
   return follow;
`;

function hugePatch(): string {
  const lines = ["diff --git a/src/huge.ts b/src/huge.ts", "index 1111111..2222222 100644", "--- a/src/huge.ts", "+++ b/src/huge.ts", "@@ -1,1 +1,21 @@", " export const start = 1;"];
  for (let i = 0; i < 20; i += 1) lines.push(`+export const n${i} = ${i};`);
  return `${lines.join("\n")}\n`;
}

const FILES: Record<string, ChangedFile> = {
  "src/body-range.ts": { path: "src/body-range.ts", status: "modified", added: 12, removed: 3 },
  "src/transcript-viewport.tsx": { path: "src/transcript-viewport.tsx", status: "modified", added: 40, removed: 8 },
  "src/logo.png": { path: "src/logo.png", status: "binary", added: 0, removed: 0, size: 24_576 },
  "src/script.sh": { path: "src/script.sh", status: "mode", added: 0, removed: 0, mode: "100755", prevMode: "100644" },
  "src/moved.ts": { path: "src/moved.ts", status: "renamed", added: 0, removed: 0, oldPath: "src/old.ts" },
  "src/gone.ts": { path: "src/gone.ts", status: "deleted", added: 0, removed: 18 },
  "src/new.ts": { path: "src/new.ts", status: "added", added: 20, removed: 0 },
  "src/huge.ts": { path: "src/huge.ts", status: "modified", added: 5000, removed: 20 },
};

const PATCHES: Record<string, string> = {
  "src/body-range.ts": MODIFIED_PATCH,
  "src/transcript-viewport.tsx": VIEWPORT_PATCH,
  "src/gone.ts": DELETED_PATCH,
  "src/new.ts": ADDED_PATCH,
  "src/huge.ts": hugePatch(),
  "lib/client.ts": CONNECTING_PATCH,
};

const SOURCES: Record<string, { old: string; next: string }> = {
  "src/body-range.ts": {
    old: `export function greet(name: string): string {\n  return "hi " + name;\n}\n`,
    next: `export function greet(name: string): string {\n  const bytes = utf8ByteLength(name);\n  recordBytes.set(name, bytes);\n  return "hi " + name;\n}\n`,
  },
};

function sessionList(): ChangesList {
  return {
    scope: { kind: "session" },
    repos: [
      {
        repo: "app",
        branch: "main",
        files: Object.values(FILES),
      },
      {
        repo: "connecting",
        branch: "agents/review",
        files: [{ path: "lib/client.ts", status: "modified", added: 4, removed: 1 }],
      },
      {
        repo: "broken",
        branch: "",
        files: [],
        error: "Could not read this repository. It may be missing or locked.",
      },
    ],
  };
}

function listFor(scope: ChangesScope): ChangesList {
  if (scope.kind === "turn") {
    return {
      scope,
      repos: [{ repo: "app", branch: "main", files: [FILES["src/body-range.ts"]!] }],
    };
  }
  if (scope.kind === "uncommitted") {
    return {
      scope,
      repos: [
        {
          repo: "app",
          branch: "main",
          files: [FILES["src/body-range.ts"]!, FILES["src/new.ts"]!],
        },
      ],
    };
  }
  if (scope.kind === "range") {
    if (scope.from === scope.to) {
      return { scope, repos: [] };
    }
    return {
      scope,
      repos: [{ repo: "app", branch: "main", files: [FILES["src/transcript-viewport.tsx"]!] }],
    };
  }
  if (scope.kind === "agent") {
    return {
      scope,
      repos: [{ repo: "app", branch: "agents/review", files: [FILES["src/body-range.ts"]!, FILES["src/new.ts"]!] }],
    };
  }
  return { ...sessionList(), scope };
}

function pageFor(scope: ChangesScope, repo: string, path: string): FileDiffPage {
  const list = listFor(scope);
  const found = list.repos.flatMap((item) => item.files.map((file) => ({ repo: item.repo, file }))).find((row) => row.repo === repo && row.file.path === path);
  if (!found) {
    throw new Error(`No such file ${repo}:${path}`);
  }
  const file = found.file;
  return {
    repo,
    path: file.path,
    status: file.status,
    added: file.added,
    removed: file.removed,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    ...(file.mode !== undefined ? { mode: file.mode } : {}),
    ...(file.prevMode !== undefined ? { prevMode: file.prevMode } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.oldSize !== undefined ? { oldSize: file.oldSize } : {}),
    patch: PATCHES[path] ?? "",
  };
}

const AGENTS: Record<string, AgentChangesContext> = {
  "run-worktree": {
    runId: "run-worktree",
    checkout: "worktree",
    worktreePath: ".worktrees/review",
    branch: "agents/review",
    baseCommit: "abc1234",
  },
  "run-shared": {
    runId: "run-shared",
    checkout: "shared",
    branch: "main",
    baseCommit: "abc1234",
  },
  "run-removed": {
    runId: "run-removed",
    checkout: "worktree",
    worktreePath: ".worktrees/review",
    branch: "agents/review",
    baseCommit: "abc1234",
    worktreeRemoved: true,
  },
  "run-gone": {
    runId: "run-gone",
    checkout: "worktree",
    worktreePath: ".worktrees/review",
    branch: "agents/review",
    baseCommit: "abc1234",
    branchGone: true,
  },
};

function mockHost(repo: string, branch: string): GitHostStatus {
  return {
    repo,
    host: "github",
    remote: "origin",
    remoteUrl: `https://github.com/example/${repo}`,
    defaultBranch: "main",
    branch,
    cli: "gh",
    cliPresent: true,
    signedIn: true,
    usable: true,
  };
}

function mockConfirmation(repo: string, files?: string[]): GitActionConfirmation {
  return {
    repo,
    branch: repo === "connecting" ? "agents/review" : "main",
    remote: "origin",
    ...(files ? { files } : {}),
    summary: files?.length
      ? `Commit ${files.length} files on ${repo === "connecting" ? "agents/review" : "main"}.`
      : `Push ${repo === "connecting" ? "agents/review" : "main"} to origin.`,
  };
}

function mockExpect(files?: string[]): GitActionExpect {
  return { branch: "main", ...(files ? { files } : {}), head: "abc1234" };
}

function mockPreview(confirmation: GitActionConfirmation, argv: string[], extra?: Partial<GitActionResult>): GitActionResult {
  return {
    outcome: "preview",
    confirmation,
    expect: mockExpect(confirmation.files),
    copyable: { argv, cwd: "/p" },
    ...extra,
  };
}

const MOCK_PROSE: Record<GitProseKind, string> = {
  commit: "Fix the overlay toolbar.\n\nThe commit set is chosen in Changes.",
  pr_title: "Fix the overlay toolbar",
  pr_description: "The overlay can commit, push and open a pull request from its toolbar.\n",
};

export function createMockAdapter(): ChangesDataAdapter {
  return {
    async listChanges(scope) {
      return listFor(scope);
    },
    async getFileDiff(scope, repo, path) {
      return pageFor(scope, repo, path);
    },
    async getFileSource(_scope, repo, path, ref) {
      const pair = SOURCES[path];
      if (!pair) return null;
      return { repo, path, ref, contents: ref === "old" ? pair.old : pair.next };
    },
    async getAgentContext(runId) {
      return AGENTS[runId] ?? {
        runId,
        checkout: "worktree",
        worktreePath: `.worktrees/${runId}`,
        branch: `agents/${runId}`,
        baseCommit: "abc1234",
      };
    },
    async gitHosts(repos) {
      const names = repos?.length ? repos : ["app", "connecting"];
      return {
        hosts: names.map((repo) => mockHost(repo, repo === "connecting" ? "agents/review" : "main")),
      };
    },
    async gitProse(params) {
      return { kind: params.kind, text: MOCK_PROSE[params.kind], model: { provider: "test", id: "session-model" } };
    },
    async gitCommit(params) {
      const confirmation = mockConfirmation(params.repo ?? "app", params.paths);
      if (params.confirm !== true) {
        return { ...mockPreview(confirmation, ["git", "commit", "-m", params.message, "--", ...params.paths]) };
      }
      return {
        outcome: "done",
        confirmation,
        commit: { hash: "def5678", subject: params.message.split("\n")[0] ?? params.message },
      };
    },
    async gitPush(params) {
      const confirmation = mockConfirmation(params.repo ?? "app");
      confirmation.branch = params.branch;
      confirmation.remote = params.remote;
      confirmation.summary = `Push ${params.branch} to ${params.remote}.`;
      if (params.confirm !== true) {
        return { ...mockPreview(confirmation, ["git", "push", params.remote, params.branch]) };
      }
      return { outcome: "done", confirmation, pushed: { remote: params.remote, branch: params.branch } };
    },
    async gitBranch(params) {
      const confirmation: GitActionConfirmation = {
        repo: params.repo ?? "app",
        branch: params.name,
        summary: `Create ${params.name} from ${params.base}.`,
      };
      if (params.confirm !== true) {
        return { ...mockPreview(confirmation, ["git", "switch", "-c", params.name, params.base]) };
      }
      return {
        outcome: "done",
        confirmation,
        created: { name: params.name, base: params.base, checkedOut: params.checkout === true },
      };
    },
    async gitPrCreate(params) {
      const confirmation: GitActionConfirmation = {
        repo: params.repo ?? "app",
        branch: params.head,
        remote: "origin",
        summary: `Open a pull request from ${params.head} into ${params.base}.`,
      };
      if (params.confirm !== true) {
        return { ...mockPreview(confirmation, ["gh", "pr", "create", "--title", params.title]) };
      }
      return {
        outcome: "done",
        confirmation,
        pullRequest: { host: "github", number: 12, url: "https://github.com/example/app/pull/12", title: params.title },
      };
    },
    async gitPrRead(params) {
      const confirmation: GitActionConfirmation = {
        repo: params.repo ?? "app",
        branch: "feature",
        summary: `Read pull request ${params.number}.`,
      };
      return {
        outcome: "done",
        confirmation,
        pullRequest: {
          host: "github",
          number: params.number,
          title: "Fix the overlay toolbar",
          body: "The overlay can commit from its toolbar.",
          url: `https://github.com/example/app/pull/${params.number}`,
          state: "open",
          base: "main",
          head: "feature",
          comments: [{ id: "1", author: "reviewer", body: "Looks good." }],
          checks: [{ name: "tests", status: "success" }],
          files: [{ path: "src/body-range.ts", viewed: false }],
        },
      };
    },
    async gitPrCheckout(params) {
      const confirmation: GitActionConfirmation = {
        repo: params.repo ?? "app",
        branch: "feature",
        summary: `Check out pull request ${params.number}.`,
      };
      if (params.confirm !== true) return { ...mockPreview(confirmation, ["gh", "pr", "checkout", String(params.number)]) };
      return { outcome: "done", confirmation, checkedOut: { branch: "feature" } };
    },
    async gitPrMerge(params) {
      const confirmation: GitActionConfirmation = {
        repo: params.repo ?? "app",
        branch: "feature",
        summary: `Merge pull request ${params.number} with ${params.method}.`,
      };
      if (params.confirm !== true) {
        return { ...mockPreview(confirmation, ["gh", "pr", "merge", String(params.number), `--${params.method}`]) };
      }
      return { outcome: "done", confirmation, merged: { number: params.number, method: params.method } };
    },
  };
}
