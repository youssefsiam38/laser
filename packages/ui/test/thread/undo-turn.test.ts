import { describe, expect, it } from "vitest";
import type { CheckpointInfo, RestorePreview, RestoreRepoResult } from "@lasercode/protocol";

import {
  UNDO_TURN_FAILED,
  defaultRestoreTarget,
  previewHasWork,
  refusedRepos,
  repoLeafName,
  repoRefusalSentence,
  reposAffectedByFiles,
  restoreErrorText,
  restoreTurnForPrompt,
  restoreWhatCopy,
  turnCheckpoint,
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
