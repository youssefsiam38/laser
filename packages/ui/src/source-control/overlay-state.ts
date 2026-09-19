import type { EmptyBody } from "./classify.js";
import type { FileDiffPage } from "./contract.js";
import type { BinaryFileView } from "./image-diff.js";
import type { OpenFile } from "./store.js";
import type { WorkspaceEmptyKind } from "./workspace-shape.js";

export type ChangesBodyState =
  | { kind: "gone" }
  | { kind: "list-loading" }
  | { kind: "list-error"; message: string }
  | { kind: "no-git" }
  | { kind: "untouched" }
  | { kind: "unsupported" }
  | { kind: "empty" }
  | { kind: "pick" }
  | { kind: "repo-error"; repo: string; message: string }
  | { kind: "page-loading"; path: string }
  | { kind: "page-error"; message: string }
  | { kind: "empty-body"; body: EmptyBody }
  /** A file with no textual diff: an image is drawn, anything else is stated. */
  | { kind: "binary"; view: BinaryFileView }
  | { kind: "deleted"; path: string }
  | { kind: "large"; path: string; lines: number }
  | { kind: "diff"; page: FileDiffPage };

export function changesBodyState(input: {
  gone: boolean;
  listLoading: boolean;
  listError: string | null;
  hasContent: boolean;
  filtered: boolean;
  shapeLoading: boolean;
  emptyKind: WorkspaceEmptyKind;
  active: OpenFile | undefined;
  repoError: { repo: string; message: string } | undefined;
  pageLoading: boolean;
  pageError: string | null;
  emptyBody: EmptyBody | null;
  /** Present when the active file is binary; it owns the body instead of a patch. */
  binary: BinaryFileView | null;
  page: FileDiffPage | null;
  large: boolean;
  lineCount: number;
}): ChangesBodyState {
  if (input.gone) return { kind: "gone" };
  if (input.listLoading) return { kind: "list-loading" };
  if (input.listError) return { kind: "list-error", message: input.listError };
  if (!input.hasContent) {
    if (input.shapeLoading) return { kind: "list-loading" };
    if (!input.filtered && input.emptyKind !== "empty") return { kind: input.emptyKind };
    return { kind: "empty" };
  }
  if (!input.active) return { kind: "pick" };
  if (input.repoError) return { kind: "repo-error", repo: input.repoError.repo, message: input.repoError.message };
  if (input.pageLoading) return { kind: "page-loading", path: input.active.path };
  if (input.pageError) return { kind: "page-error", message: input.pageError };
  // Before the empty-body notice: a picture is the thing a person came to
  // see, and "Binary file" is what we used to say instead of showing it.
  if (input.binary) return { kind: "binary", view: input.binary };
  if (input.emptyBody) return { kind: "empty-body", body: input.emptyBody };
  if (input.page && input.page.status === "deleted" && !input.page.patch.trim()) {
    return { kind: "deleted", path: input.page.path };
  }
  if (input.large) return { kind: "large", path: input.active.path, lines: input.lineCount };
  if (input.page) return { kind: "diff", page: input.page };
  return { kind: "pick" };
}
