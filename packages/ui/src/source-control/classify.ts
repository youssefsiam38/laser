import type { ChangedFile, ChangedRepo, ChangesScopeKind, FileChangeStatus, FileDiffPage } from "./contract.js";

/**
 * A file whose Pierre body would be blank. We draw our own row instead.
 * Pierre types (`rename-pure`, `mode`/`prevMode`, `hunks.length === 0`) map
 * onto this; the overlay prefers the authority's status when both exist.
 */
export type EmptyBodyKind = "binary" | "mode" | "rename-pure";

export type EmptyBody = {
  kind: EmptyBodyKind;
  path: string;
  oldPath?: string;
  size?: number;
  oldSize?: number;
  mode?: string;
  prevMode?: string;
};

/** Changed plus context lines above this open collapsed, with an explicit control. */
export const LARGE_DIFF_LINE_LIMIT = 2000;

/** Two columns of at least 20ch plus an 8ch gutter, in the code size. */
export const SPLIT_MIN_COLUMNS_CH = 20 * 2 + 8;

/** Tailwind `sm` is 40rem. Phone chrome below that. */
export const OVERLAY_PHONE_MAX_REM = 40;

/**
 * Two columns of code, each at least 20ch of the code size, plus an 8ch gutter.
 * A width we have not measured yet keeps the person's remembered preference.
 */
export function splitColumnsFit(widthPx: number, codeSizePx: number): boolean {
  if (!(widthPx > 0) || !(codeSizePx > 0)) return true;
  return widthPx >= codeSizePx * SPLIT_MIN_COLUMNS_CH;
}

/**
 * Phone chrome: a single column, tree as a sheet.
 * An unmeasured box stays desktop so tests and the first frame do not flash.
 */
export function overlayChromeLayout(widthPx: number, rootFontPx: number): "phone" | "desktop" {
  if (!(widthPx > 0) || !(rootFontPx > 0)) return "desktop";
  return widthPx < OVERLAY_PHONE_MAX_REM * rootFontPx ? "phone" : "desktop";
}

/** Prefer `--text-code`; fall back to the root size when the token is missing. */
export function codeSizeFromTheme(codeTokenPx: number, rootFontPx: number): number {
  return codeTokenPx > 0 ? codeTokenPx : rootFontPx;
}

export function fileLineCount(file: Pick<ChangedFile, "added" | "removed">): number {
  return file.added + file.removed;
}

export function shouldBoundExpansion(lineCount: number): boolean {
  return lineCount > LARGE_DIFF_LINE_LIMIT;
}

export function classifyEmptyBody(file: {
  status: FileChangeStatus;
  added: number;
  removed: number;
  path: string;
  oldPath?: string;
  size?: number;
  oldSize?: number;
  mode?: string;
  prevMode?: string;
  pierreType?: string;
  hunkCount?: number;
}): EmptyBody | null {
  const hunks = file.hunkCount;
  const noHunks = hunks === 0 || hunks === undefined && file.added === 0 && file.removed === 0;
  if (file.status === "binary" || file.pierreType === "binary") {
    return { kind: "binary", path: file.path, ...(file.size !== undefined ? { size: file.size } : {}), ...(file.oldSize !== undefined ? { oldSize: file.oldSize } : {}) };
  }
  if (file.pierreType === "rename-pure" || (file.status === "renamed" && file.added === 0 && file.removed === 0 && (hunks === 0 || hunks === undefined))) {
    return { kind: "rename-pure", path: file.path, ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}) };
  }
  const modeChanged = Boolean(file.mode && file.prevMode && file.mode !== file.prevMode);
  if (file.status === "mode" || (modeChanged && noHunks && file.added === 0 && file.removed === 0 && file.status !== "renamed")) {
    return { kind: "mode", path: file.path, ...(file.mode !== undefined ? { mode: file.mode } : {}), ...(file.prevMode !== undefined ? { prevMode: file.prevMode } : {}) };
  }
  return null;
}

export function classifyDiffPage(page: FileDiffPage, pierre?: { type?: string; hunks?: number }): EmptyBody | null {
  return classifyEmptyBody({
    status: page.status,
    added: page.added,
    removed: page.removed,
    path: page.path,
    ...(page.oldPath !== undefined ? { oldPath: page.oldPath } : {}),
    ...(page.size !== undefined ? { size: page.size } : {}),
    ...(page.oldSize !== undefined ? { oldSize: page.oldSize } : {}),
    ...(page.mode !== undefined ? { mode: page.mode } : {}),
    ...(page.prevMode !== undefined ? { prevMode: page.prevMode } : {}),
    ...(pierre?.type !== undefined ? { pierreType: pierre.type } : {}),
    ...(pierre?.hunks !== undefined ? { hunkCount: pierre.hunks } : page.patch.trim() ? {} : { hunkCount: 0 }),
  });
}

export function modeWords(prevMode?: string, mode?: string): string {
  const exec = (value?: string) => Boolean(value && /(?:755|111)$/.test(value));
  if (!exec(prevMode) && exec(mode)) return "executable";
  if (exec(prevMode) && !exec(mode)) return "not executable";
  return "its file mode";
}

export function repoTotals(repo: ChangedRepo): { added: number; removed: number } {
  return repo.files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 },
  );
}

export function listTotals(repos: readonly ChangedRepo[]): { added: number; removed: number; files: number } {
  return repos.reduce(
    (sum, repo) => {
      const next = repoTotals(repo);
      return { added: sum.added + next.added, removed: sum.removed + next.removed, files: sum.files + repo.files.length };
    },
    { added: 0, removed: 0, files: 0 },
  );
}

export function fileKey(repo: string, path: string): string {
  return `${repo}\0${path}`;
}

export function statusMark(status: FileChangeStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "binary":
      return "B";
    case "mode":
      return "X";
    default:
      return "M";
  }
}

export function statusLabel(status: FileChangeStatus): string {
  switch (status) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "binary":
      return "binary";
    case "mode":
      return "mode change";
    default:
      return "modified";
  }
}

export function scopeLabel(kind: ChangesScopeKind): string {
  switch (kind) {
    case "session":
      return "This session";
    case "turn":
      return "This turn";
    case "uncommitted":
      return "Uncommitted";
    case "range":
      return "Commit range";
    case "agent":
      return "This agent";
  }
}

export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Matches inside a unified patch, skipping hunk headers and `diff --git` chrome. */
export function patchValueMatches(patch: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("Binary ")) {
      continue;
    }
    const value = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line;
    let from = 0;
    const haystack = value.toLowerCase();
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
  }
  return count;
}
