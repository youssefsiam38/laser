import { describe, expect, it } from "vitest";
import type { CheckpointInfo, ProjectChanges, RestorePreview, RestoreRepoResult } from "@lasercode/protocol";

import { DIALOG_EXIT_FALLBACK_MS, dialogExitMs } from "../../src/components/thread/dialog-presence.js";
import {
  UNDO_ROWS_SHOWN,
  UNDO_TURN_FAILED,
  boundedRows,
  changesTurnForUndo,
  defaultRestoreTarget,
  fileRowDescription,
  fileStatusLabel,
  lostFileCount,
  lostWorkSentence,
  moreRowsLabel,
  previewHasWork,
  refusedRepos,
  repoLeafName,
  repoRefusalSentence,
  repoTotalLabel,
  reposAffectedByFiles,
  restoreErrorText,
  restoreTurnForPrompt,
  restoreWhatCopy,
  turnCheckpoint,
  undoRepoRows,
  undoSummaryLine,
  visibleRestoreTargets,
} from "../../src/components/thread/undo-turn.js";
import { requestProjectGitRefresh, subscribeProjectGitRefresh } from "../../src/components/thread/project-git.js";

const checkpoint = (turn: number, over: Partial<CheckpointInfo> = {}): CheckpointInfo => ({
  turn,
  ref: `refs/product/checkpoints/s/${turn}`,
  commit: `c${turn}`,
  createdAt: "2026-09-19T00:00:00.000Z",
  ...over,
});

describe("restoreTurnForPrompt", () => {
  it("maps the prompt ordinal onto that turn's checkpoint, including the baseline", () => {
    expect(restoreTurnForPrompt(0)).toBe(0);
    expect(restoreTurnForPrompt(3)).toBe(3);
  });
});

describe("turnCheckpoint", () => {
  it("returns a kept checkpoint and ignores a failed capture", () => {
    const rows = [checkpoint(0), checkpoint(1, { failed: true }), checkpoint(2)];
    expect(turnCheckpoint(rows, 0)?.turn).toBe(0);
    expect(turnCheckpoint(rows, 1)).toBeUndefined();
    expect(turnCheckpoint(rows, 2)?.turn).toBe(2);
    expect(turnCheckpoint(undefined, 0)).toBeUndefined();
  });
});

describe("visibleRestoreTargets", () => {
  it("hides a no-op target instead of disabling it, and hides both when either side is a no-op", () => {
    expect(visibleRestoreTargets([])).toEqual(["files", "conversation", "both"]);
    expect(visibleRestoreTargets(["conversation"])).toEqual(["files"]);
    expect(visibleRestoreTargets(["files"])).toEqual(["conversation"]);
    expect(visibleRestoreTargets(["files", "conversation"])).toEqual([]);
    expect(defaultRestoreTarget(visibleRestoreTargets([]))).toBe("both");
    expect(defaultRestoreTarget(visibleRestoreTargets(["conversation"]))).toBe("files");
  });
});

describe("preview copy", () => {
  const preview = (hidden: RestorePreview["hidden"] = []): RestorePreview => ({
    turn: 1,
    restore: "both",
    hidden,
    repos: [
      { repo: "/work/app", branch: "main", files: ["src/a.ts"], uncommittedLost: ["tmp.txt"] },
      { repo: "/work/lib", branch: "dev", files: [], uncommittedLost: ["noise.txt"] },
    ],
    conversation: { entryId: "leaf", turn: 1 },
    staging: "not_restored",
  });

  it("names only repositories that would actually change", () => {
    expect(reposAffectedByFiles(preview().repos).map((row) => row.repo)).toEqual(["/work/app"]);
    expect(repoLeafName("/work/app")).toBe("app");
    expect(repoLeafName("C:\\\\repos\\\\app\\\\")).toBe("app");
  });

  it("treats a files-only or conversation-only preview as work, and an empty one as nothing", () => {
    expect(previewHasWork(preview(), "both")).toBe(true);
    expect(previewHasWork(preview(["conversation"]), "files")).toBe(true);
    expect(previewHasWork({ ...preview(["files"]), conversation: undefined }, "conversation")).toBe(false);
    expect(restoreWhatCopy("both")).toContain("files");
    expect(restoreWhatCopy("both")).toContain("conversation");
  });
});

describe("refusals", () => {
  it("keeps an engine sentence and does not invent success", () => {
    const rows: RestoreRepoResult[] = [
      { repo: "/work/app", restored: true },
      { repo: "/work/lib", restored: false, detail: "That checkpoint is not in this repository, so its files were left unchanged." },
    ];
    expect(refusedRepos(rows)).toHaveLength(1);
    expect(repoRefusalSentence(rows[1]!)).toBe("That checkpoint is not in this repository, so its files were left unchanged.");
    expect(restoreErrorText(new Error("A turn is running, so this conversation cannot be restored until it finishes or is stopped."))).toMatch(/turn is running/);
    expect(restoreErrorText(new TypeError("x is not a function"))).toBe(UNDO_TURN_FAILED);
  });
});

describe("joining the preview with the change lists", () => {
  const preview: RestorePreview = {
    turn: 2,
    restore: "both",
    hidden: [],
    repos: [
      {
        repo: "/work/app",
        branch: "main",
        files: ["src/index.ts", "src/added.ts", "src/gone.ts", "src/unknown.ts"],
        uncommittedLost: ["logo.png", "src/index.ts"],
      },
      { repo: "/work/lib", branch: "dev", files: ["lib/one.ts"], uncommittedLost: [] },
      { repo: "/work/idle", branch: "main", files: [], uncommittedLost: ["noise.txt"] },
    ],
    staging: "not_restored",
  };
  const turnChanges: ProjectChanges = {
    scope: "turn",
    repos: [
      {
        repo: "/work/app",
        branch: "main",
        files: [
          { path: "src/index.ts", status: "modified", added: 12, removed: 3 },
          { path: "src/added.ts", status: "added", added: 30, removed: 0 },
          { path: "src/gone.ts", status: "deleted", added: 0, removed: 9 },
        ],
      },
      { repo: "/work/lib", branch: "dev", files: [{ path: "lib/one.ts", status: "modified", added: 1, removed: 1 }] },
    ],
  };
  const uncommitted: ProjectChanges = {
    scope: "uncommitted",
    repos: [
      {
        repo: "/work/app",
        branch: "main",
        files: [
          { path: "logo.png", status: "modified", added: null, removed: null },
          { path: "src/index.ts", status: "modified", added: 4, removed: 0 },
        ],
      },
    ],
  };

  it("asks for the turn whose work is being taken back, counting from one", () => {
    expect(changesTurnForUndo(0)).toBe(1);
    expect(changesTurnForUndo(7)).toBe(8);
  });

  it("carries each path's numbers, leaves an unmatched path bare, and never invents a zero", () => {
    const rows = undoRepoRows(preview, turnChanges, uncommitted);
    expect(rows.map((row) => row.repo)).toEqual(["/work/app", "/work/lib"]);
    const app = rows[0]!;
    expect(app.restored.map((row) => [row.path, row.status, row.added, row.removed])).toEqual([
      ["src/index.ts", "modified", 12, 3],
      ["src/added.ts", "added", 30, 0],
      ["src/gone.ts", "deleted", 0, 9],
      ["src/unknown.ts", undefined, undefined, undefined],
    ]);
    expect(fileStatusLabel(app.restored[3]!)).toBeUndefined();
    expect(fileRowDescription(app.restored[0]!)).toBe("src/index.ts, modified, 12 lines added, 3 lines removed, opens the diff");
    expect(fileRowDescription(app.restored[3]!)).toBe("src/unknown.ts, opens the diff");
  });

  it("says binary instead of showing numbers, and takes the lost work's numbers from the worktree", () => {
    const app = undoRepoRows(preview, turnChanges, uncommitted)[0]!;
    expect(app.lost.map((row) => row.path)).toEqual(["logo.png", "src/index.ts"]);
    expect(fileStatusLabel(app.lost[0]!)).toBe("binary");
    expect(fileRowDescription(app.lost[0]!)).toBe("logo.png, binary, opens the diff");
    // The worktree's count wins over the turn's for a path in both.
    expect(app.lost[1]!.added).toBe(4);
    expect(lostFileCount(undoRepoRows(preview, turnChanges, uncommitted))).toBe(2);
    expect(lostWorkSentence(2)).toBe("2 files with uncommitted changes are overwritten by the checkpoint's version.");
    expect(lostWorkSentence(1)).toMatch(/^1 file with uncommitted changes is/);
  });

  it("totals a repository from the numbers it has, and says only the count when it has none", () => {
    const rows = undoRepoRows(preview, turnChanges, uncommitted);
    expect(repoTotalLabel(rows[0]!.totals)).toBe("4 files · +42 −12");
    expect(repoTotalLabel(rows[1]!.totals)).toBe("1 file · +1 −1");
    expect(repoTotalLabel(undoRepoRows(preview)[0]!.totals)).toBe("4 files");
  });

  it("summarises the files, the repositories, the totals and which turn this is", () => {
    const rows = undoRepoRows(preview, turnChanges, uncommitted);
    const line = undoSummaryLine({ rows, files: true, turn: 2, at: "2026-09-19T12:30:00.000Z" });
    expect(line).toMatch(/^5 files in 2 repositories · \+43 −13 · turn 3, /);
    expect(undoSummaryLine({ rows, files: false, turn: 2 })).toBe("turn 3");
    expect(undoSummaryLine({ rows: undoRepoRows(preview), files: true, turn: 0 })).toBe("5 files in 2 repositories · turn 1");
  });

  it("bounds a long list and counts what it is holding back", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const bounded = boundedRows(many, false);
    expect(bounded.shown).toHaveLength(UNDO_ROWS_SHOWN);
    expect(bounded.hidden).toBe(30 - UNDO_ROWS_SHOWN);
    expect(moreRowsLabel(bounded.hidden)).toBe(`and ${30 - UNDO_ROWS_SHOWN} more`);
    expect(boundedRows(many, true).shown).toHaveLength(30);
    expect(boundedRows(many.slice(0, 3), false)).toEqual({ shown: many.slice(0, 3), hidden: 0 });
  });
});

describe("dialogExitMs", () => {
  it("reads the motion token and still leaves a window when motion is off", () => {
    expect(dialogExitMs("75ms")).toBeGreaterThan(75);
    expect(dialogExitMs("0ms")).toBeGreaterThan(0);
    expect(dialogExitMs(" 0.2s ")).toBeGreaterThan(200);
    expect(dialogExitMs(undefined)).toBe(DIALOG_EXIT_FALLBACK_MS);
    expect(dialogExitMs("")).toBe(DIALOG_EXIT_FALLBACK_MS);
    expect(dialogExitMs("nonsense")).toBe(DIALOG_EXIT_FALLBACK_MS);
  });
});

describe("project git refresh bus", () => {
  it("notifies subscribers once per request", () => {
    const seen: number[] = [];
    const stop = subscribeProjectGitRefresh(() => seen.push(1));
    requestProjectGitRefresh();
    requestProjectGitRefresh();
    stop();
    requestProjectGitRefresh();
    expect(seen).toEqual([1, 1]);
  });
});
