import { expect, it } from "vitest";
import { changesBodyState } from "../../src/source-control/overlay-state.js";
import type { FileDiffPage } from "../../src/source-control/contract.js";

const page: FileDiffPage = {
  repo: "app",
  path: "a.ts",
  status: "modified",
  added: 1,
  removed: 0,
  patch: "diff --git a/a.ts b/a.ts\n",
};

const base = {
  gone: false,
  listLoading: false,
  listError: null as string | null,
  hasContent: true,
  active: { repo: "app", path: "a.ts" } as const,
  repoError: undefined as { repo: string; message: string } | undefined,
  pageLoading: false,
  pageError: null as string | null,
  emptyBody: null,
  page,
  large: false,
  lineCount: 1,
};

it("walks designed states in priority order", () => {
  expect(changesBodyState({ ...base, gone: true }).kind).toBe("gone");
  expect(changesBodyState({ ...base, listLoading: true }).kind).toBe("list-loading");
  expect(changesBodyState({ ...base, listError: "Could not read the changes." }).kind).toBe("list-error");
  expect(changesBodyState({ ...base, hasContent: false }).kind).toBe("empty");
  expect(changesBodyState({ ...base, active: undefined }).kind).toBe("pick");
  expect(changesBodyState({ ...base, repoError: { repo: "app", message: "locked" } }).kind).toBe("repo-error");
  expect(changesBodyState({ ...base, pageLoading: true }).kind).toBe("page-loading");
  expect(changesBodyState({ ...base, pageError: "Could not read this file." }).kind).toBe("page-error");
  expect(
    changesBodyState({
      ...base,
      emptyBody: { kind: "binary", path: "a.bin" },
    }).kind,
  ).toBe("empty-body");
  expect(
    changesBodyState({
      ...base,
      page: { ...page, status: "deleted", patch: "" },
    }).kind,
  ).toBe("deleted");
  expect(changesBodyState({ ...base, large: true }).kind).toBe("large");
  expect(changesBodyState(base).kind).toBe("diff");
});
