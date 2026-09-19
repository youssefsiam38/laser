import type { EmptyBody } from "./classify.js";
import type { FileDiffPage } from "./contract.js";
import type { OpenFile } from "./store.js";

export type ChangesBodyState =
  | { kind: "gone" }
  | { kind: "list-loading" }
  | { kind: "list-error"; message: string }
  | { kind: "empty" }
  | { kind: "pick" }
  | { kind: "repo-error"; repo: string; message: string }
  | { kind: "page-loading"; path: string }
  | { kind: "page-error"; message: string }
  | { kind: "empty-body"; body: EmptyBody }
  | { kind: "deleted"; path: string }
  | { kind: "large"; path: string; lines: number }
  | { kind: "diff"; page: FileDiffPage };

export function changesBodyState(input: {
  gone: boolean;
  listLoading: boolean;
  listError: string | null;
  hasContent: boolean;
  active: OpenFile | undefined;
  repoError: { repo: string; message: string } | undefined;
  pageLoading: boolean;
  pageError: string | null;
  emptyBody: EmptyBody | null;
  page: FileDiffPage | null;
  large: boolean;
  lineCount: number;
}): ChangesBodyState {
  if (input.gone) return { kind: "gone" };
  if (input.listLoading) return { kind: "list-loading" };
  if (input.listError) return { kind: "list-error", message: input.listError };
  if (!input.hasContent) return { kind: "empty" };
  if (!input.active) return { kind: "pick" };
  if (input.repoError) return { kind: "repo-error", repo: input.repoError.repo, message: input.repoError.message };
  if (input.pageLoading) return { kind: "page-loading", path: input.active.path };
  if (input.pageError) return { kind: "page-error", message: input.pageError };
  if (input.emptyBody) return { kind: "empty-body", body: input.emptyBody };
  if (input.page && input.page.status === "deleted" && !input.page.patch.trim()) {
    return { kind: "deleted", path: input.page.path };
  }
  if (input.large) return { kind: "large", path: input.active.path, lines: input.lineCount };
  if (input.page) return { kind: "diff", page: input.page };
  return { kind: "pick" };
}
