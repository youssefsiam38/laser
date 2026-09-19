import { expect, it, vi } from "vitest";
import type { WorkspaceShape, WorkspaceShapeKind } from "@lasercode/protocol";

import {
  bindWorkspaceShapeRequest,
  filesWorkspaceEmptyText,
  overlayWorkspaceEmptyCopy,
  readWorkspaceShape,
  resetWorkspaceShapeReader,
  shouldShowRepoFilter,
  workspaceEmptyKind,
  workspaceShapeRequestCount,
} from "../../src/source-control/workspace-shape.js";

function fakeShape(kind: WorkspaceShapeKind, roots: string[]): WorkspaceShape {
  return {
    cwd: "/p",
    kind,
    repositories: roots.map((root, index) => ({
      root,
      name: root.split("/").pop() || root,
      projectRoot: index === 0,
      gitDir: `${root}/.git`,
      insideWorkTree: kind !== "bare-or-submodule",
    })),
    hasCommit: kind === "repo" || kind === "nested-repo",
    truncated: false,
  };
}

it("issues pi/project/workspace once per cwd and again only on rescan", async () => {
  resetWorkspaceShapeReader();
  const shape = fakeShape("repo", ["/p"]);
  const request = vi.fn(async () => shape);
  bindWorkspaceShapeRequest(request);
  await expect(readWorkspaceShape("/p")).resolves.toEqual(shape);
  await expect(readWorkspaceShape("/p")).resolves.toEqual(shape);
  await expect(Promise.all([readWorkspaceShape("/p"), readWorkspaceShape("/p")])).resolves.toEqual([shape, shape]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ cwd: "/p" });
  expect(workspaceShapeRequestCount()).toBe(1);
  await readWorkspaceShape("/p", { rescan: true });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith({ cwd: "/p", rescan: true });
  await readWorkspaceShape("/other");
  expect(request).toHaveBeenCalledTimes(3);
  resetWorkspaceShapeReader();
});

it("maps each shape onto the copy the viewer owes the person", () => {
  expect(workspaceEmptyKind(fakeShape("repo", ["/p"]))).toBe("empty");
  expect(workspaceEmptyKind(fakeShape("no-git", []))).toBe("no-git");
  expect(workspaceEmptyKind(fakeShape("workspace-of-repos", ["/p/a", "/p/b"]))).toBe("untouched");
  expect(workspaceEmptyKind(fakeShape("nested-repo", ["/p", "/p/nested"]))).toBe("untouched");
  expect(workspaceEmptyKind(fakeShape("bare-or-submodule", ["/p"]))).toBe("unsupported");
  expect(workspaceEmptyKind(undefined)).toBe("empty");
  expect(filesWorkspaceEmptyText("empty")).toBe("No changes in this workspace.");
  expect(filesWorkspaceEmptyText("no-git")).toMatch(/no repository here/i);
  expect(overlayWorkspaceEmptyCopy("no-git").title).toBe("No repository here");
  expect(shouldShowRepoFilter(1)).toBe(false);
  expect(shouldShowRepoFilter(2)).toBe(true);
});

