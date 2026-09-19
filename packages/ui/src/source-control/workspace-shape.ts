/**
 * One reader for `pi/project/workspace`. The overlay and the telemetry Files
 * section share this cache: one resolve per project, and again only on an
 * explicit rescan. Never per record, never per keystroke.
 */
import type { WorkspaceShape } from "@lasercode/protocol";

export type WorkspaceShapeRequest = (params: { cwd: string; rescan?: boolean }) => Promise<WorkspaceShape>;

export type WorkspaceEmptyKind = "no-git" | "untouched" | "unsupported" | "empty";

const inflight = new Map<string, Promise<WorkspaceShape>>();
const resolved = new Map<string, WorkspaceShape>();
let requestFn: WorkspaceShapeRequest | null = null;
let resolveCount = 0;

export function bindWorkspaceShapeRequest(next: WorkspaceShapeRequest | null): void {
  requestFn = next;
}

export function resetWorkspaceShapeReader(): void {
  inflight.clear();
  resolved.clear();
  requestFn = null;
  resolveCount = 0;
}

/** How many times the method has been issued since the last reset. Tests pin this. */
export function workspaceShapeRequestCount(): number {
  return resolveCount;
}

export function peekWorkspaceShape(cwd: string): WorkspaceShape | undefined {
  return resolved.get(cwd);
}

export function readWorkspaceShape(cwd: string, options?: { rescan?: boolean }): Promise<WorkspaceShape> {
  if (options?.rescan) {
    inflight.delete(cwd);
    resolved.delete(cwd);
  } else {
    const ready = resolved.get(cwd);
    if (ready) return Promise.resolve(ready);
    const pending = inflight.get(cwd);
    if (pending) return pending;
  }
  if (!requestFn) {
    return Promise.reject(new Error("Changes are not available in this view."));
  }
  const params = options?.rescan === true ? { cwd, rescan: true } : { cwd };
  resolveCount += 1;
  const pending = requestFn(params).then(
    (shape) => {
      resolved.set(cwd, shape);
      if (inflight.get(cwd) === pending) inflight.delete(cwd);
      return shape;
    },
    (error: unknown) => {
      if (inflight.get(cwd) === pending) inflight.delete(cwd);
      throw error;
    },
  );
  inflight.set(cwd, pending);
  return pending;
}

export function workspaceEmptyKind(shape: WorkspaceShape | undefined): WorkspaceEmptyKind {
  if (!shape) return "empty";
  switch (shape.kind) {
    case "no-git":
      return "no-git";
    case "bare-or-submodule":
      return "unsupported";
    case "workspace-of-repos":
    case "nested-repo":
      return "untouched";
    default:
      return "empty";
  }
}

export function overlayWorkspaceEmptyCopy(kind: Exclude<WorkspaceEmptyKind, "empty">): { title: string; body: string } {
  switch (kind) {
    case "no-git":
      return {
        title: "No repository here",
        body: "There is no repository here, so there is nothing to compare.",
      };
    case "untouched":
      return {
        title: "Nothing touched",
        body: "This workspace holds repositories, but this session has not changed any of them.",
      };
    case "unsupported":
      return {
        title: "Not in this release",
        body: "This is a bare repository or a submodule, which this release cannot show.",
      };
  }
}

export function filesWorkspaceEmptyText(kind: WorkspaceEmptyKind): string {
  switch (kind) {
    case "no-git":
      return "There is no repository here, so this session has no files to list.";
    case "untouched":
      return "This workspace holds repositories, but this session has not changed any of them.";
    case "unsupported":
      return "This is a bare repository or a submodule, which this release cannot show.";
    default:
      return "No changes in this workspace.";
  }
}

export function shouldShowRepoFilter(repoCount: number): boolean {
  return repoCount > 1;
}
