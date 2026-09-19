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

/** The same five scopes with the shared word dropped, for a narrow toolbar. */
export function scopeShortLabel(kind: ChangesScopeKind): string {
  switch (kind) {
    case "session":
      return "Session";
    case "turn":
      return "Turn";
    case "uncommitted":
      return "Uncommitted";
    case "range":
      return "Range";
    case "agent":
      return "Agent";
  }
}

export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * The longest suffix worth pinning past an ellipsis. An extension is short by
 * nature; a collapsed folder chain's last folder is allowed more, because it
 * is the part of the chain a reader is actually looking for. Beyond these,
 * nothing is pinned and the label truncates at its end like any other.
 */
const KEPT_TAIL_CHARS = { file: 10, path: 16 } as const;

/**
 * Split a label so CSS truncates its *middle*: the head ellipsizes, the tail
 * always shows. A file name keeps its extension (`transcript-viewp….tsx`), a
 * collapsed folder chain keeps its last folder (`packages/…/source-control`).
 *
 * The floor says truncate, never condense, and the thing a reader looks for in
 * a changed-file list is the name and the kind of file — never the first half
 * of a directory it already knows.
 */
export function truncatableParts(label: string, kind: "file" | "path"): { head: string; tail: string } {
  const at = kind === "file" ? label.lastIndexOf(".") : label.lastIndexOf("/");
  if (at <= 0 || at >= label.length - 1) return { head: label, tail: "" };
  const tail = label.slice(at);
  if (tail.length > KEPT_TAIL_CHARS[kind]) return { head: label, tail: "" };
  return { head: label.slice(0, at), tail };
}

/** A count in the toolbar and the rail: grouped, with a space that never wraps. */
export function changeCount(value: number): string {
  return value.toLocaleString().replace(/[,\u202f\u2009]/g, "\u00a0");
}

/* -------------------------------------------------------------------------
 * The toolbar's degradation plan
 * ---------------------------------------------------------------------- */

/** The narrowest content width the toolbar is drawn for: the sessions column. */
export const OVERLAY_TOOLBAR_MIN_PX = 288;

/**
 * What each control costs the row, in CSS px at the default text scale: the
 * control's own box plus its chevron, measured from the `sm` button (h-7,
 * `px-2`, 12px text) and the 12px tabular mono the totals are set in.
 *
 * These are layout arithmetic, not style: nothing here is painted. They exist
 * so the plan below can be *proved* to fit 288px instead of hoped to.
 */
export const OVERLAY_TOOLBAR_COST = {
  gap: 4,
  padding: 16,
  title: 72,
  treeIcon: 28,
  treeLabel: 56,
  scopeShort: 84,
  scopeLong: 120,
  repoShort: 88,
  repoLong: 144,
  totals: 88,
  split: 28,
  commit: 64,
  gitIcon: 28,
  gitLabel: 60,
  esc: 34,
  close: 28,
} as const;

export type OverlayToolbarTier = "tight" | "compact" | "medium" | "wide";

export type OverlayToolbarPlan = {
  tier: OverlayToolbarTier;
  /** The word "Changes". First thing to go: the window says it already. */
  title: boolean;
  /** The file-tree control, which only exists while the tree is a sheet. */
  tree: "hidden" | "icon" | "label";
  scope: "short" | "long";
  repo: "short" | "long";
  /** Totals never disappear; under 30rem they take the row below. */
  totals: "row" | "second-row";
  /** The split/unified toggle. Below 40rem the body cannot hold two columns. */
  split: boolean;
  /** The standalone Commit button. It is always in the Git menu as well. */
  commit: boolean;
  git: "icon" | "label";
  esc: boolean;
};

const TOOLBAR_COMPACT_MIN_REM = 30;
/** The same threshold as the chrome: the tree is a sheet below it, so the
 *  toolbar carries the control that opens it and the header cannot disagree
 *  with the layout about which width it is on. */
const TOOLBAR_MEDIUM_MIN_REM = OVERLAY_PHONE_MAX_REM;
const TOOLBAR_WIDE_MIN_REM = 64;

/**
 * Which content the toolbar can carry at this width. It sheds labels first
 * ("This session" → "Session", "Git ⌄" → the icon), then secondary controls
 * into the Git menu (Commit) or out of a row that cannot hold them (the
 * totals drop to a second line). Type size is never part of the answer.
 *
 * An unmeasured box plans for the widest tier, so the first frame is the
 * finished toolbar rather than a phone one that re-draws.
 */
export function overlayToolbarPlan(widthPx: number, rootFontPx: number): OverlayToolbarPlan {
  const rem = widthPx > 0 && rootFontPx > 0 ? widthPx / rootFontPx : Number.POSITIVE_INFINITY;
  const tier: OverlayToolbarTier =
    rem >= TOOLBAR_WIDE_MIN_REM
      ? "wide"
      : rem >= TOOLBAR_MEDIUM_MIN_REM
        ? "medium"
        : rem >= TOOLBAR_COMPACT_MIN_REM
          ? "compact"
          : "tight";
  switch (tier) {
    case "wide":
      return { tier, title: true, tree: "hidden", scope: "long", repo: "long", totals: "row", split: true, commit: true, git: "label", esc: true };
    case "medium":
      return { tier, title: true, tree: "hidden", scope: "long", repo: "long", totals: "row", split: true, commit: false, git: "label", esc: false };
    case "compact":
      return { tier, title: false, tree: "label", scope: "short", repo: "short", totals: "row", split: false, commit: false, git: "label", esc: false };
    case "tight":
      return { tier, title: false, tree: "icon", scope: "short", repo: "short", totals: "second-row", split: false, commit: false, git: "icon", esc: false };
  }
}

/**
 * What the planned row actually costs, so a test can hold the plan to the
 * width it claims. `repos` says whether the repository filter is drawn at all
 * (one repository hides it), `git` whether the host offers git actions.
 */
export function overlayToolbarCost(
  plan: OverlayToolbarPlan,
  { repos, git }: { repos: boolean; git: boolean },
): { row: number; secondRow: number } {
  const c = OVERLAY_TOOLBAR_COST;
  const row: number[] = [];
  const second: number[] = [];
  if (plan.title) row.push(c.title);
  if (plan.tree === "icon") row.push(c.treeIcon);
  if (plan.tree === "label") row.push(c.treeLabel);
  row.push(plan.scope === "long" ? c.scopeLong : c.scopeShort);
  if (repos) (plan.totals === "second-row" ? second : row).push(plan.repo === "long" ? c.repoLong : c.repoShort);
  (plan.totals === "second-row" ? second : row).push(c.totals);
  if (plan.split) row.push(c.split);
  if (git && plan.commit) row.push(c.commit);
  if (git) row.push(plan.git === "label" ? c.gitLabel : c.gitIcon);
  if (plan.esc) row.push(c.esc);
  row.push(c.close);
  const sum = (items: number[]) =>
    items.length ? items.reduce((total, item) => total + item, 0) + (items.length - 1) * c.gap + c.padding : 0;
  return { row: sum(row), secondRow: sum(second) };
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
