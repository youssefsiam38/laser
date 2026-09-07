/**
 * Dependency-free line diff for edit/write tool rows.
 *
 * Sources, in order of preference:
 * 1. A unified patch string Pi's edit tool returns in `details.patch` (real
 *    line numbers).
 * 2. `edits[].oldText/newText` from the edit tool's args (LCS line diff,
 *    relative line numbers).
 * 3. `content` from the write tool's args (every line is an addition).
 *
 * Shared display projection: search and the renderer must see the same lines.
 * Pure; no React or engine imports.
 */

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldNo?: number;
  readonly newNo?: number;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@` from a unified patch; synthesized for computed hunks. */
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffView {
  readonly path?: string;
  readonly hunks: readonly DiffHunk[];
  /** True when lines were dropped to keep the block bounded. */
  readonly truncated: boolean;
}

/** Above this many cells the LCS table is skipped for a replace-all diff. */
const MAX_LCS_CELLS = 4_000_000;
/** Cap on rendered lines per view. */
export const MAX_DIFF_LINES = 400;

const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

type Op = { kind: DiffLineKind; text: string };

/** Longest-common-subsequence line diff → ops in order. */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "add", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [...a.map((text): Op => ({ kind: "del", text })), ...b.map((text): Op => ({ kind: "add", text }))];
  }
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] ?? "" });
  while (j < m) ops.push({ kind: "add", text: b[j++] ?? "" });
  return ops;
}

/**
 * Diff two texts into hunks with `context` unchanged lines around each
 * change. Line numbers are 1-based within the inputs.
 */
export function diffLines(oldText: string, newText: string, context = 3): DiffHunk[] {
  const ops = lcsOps(splitLines(oldText), splitLines(newText));
  const numbered: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.kind === "ctx") numbered.push({ kind: "ctx", text: op.text, oldNo: oldNo++, newNo: newNo++ });
    else if (op.kind === "del") numbered.push({ kind: "del", text: op.text, oldNo: oldNo++ });
    else numbered.push({ kind: "add", text: op.text, newNo: newNo++ });
  }
  if (!numbered.some((l) => l.kind !== "ctx")) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let trailing = 0; // ctx lines emitted after the last change in `current`
  let pending: DiffLine[] = []; // ctx lines waiting for the next change

  const flush = () => {
    if (current.length === 0) return;
    hunks.push({ header: hunkHeader(current), lines: current });
    current = [];
    trailing = 0;
  };

  for (const line of numbered) {
    if (line.kind === "ctx") {
      if (current.length > 0) {
        if (trailing < context) {
          current.push(line);
          trailing++;
        } else {
          pending.push(line);
          if (pending.length > context) pending.shift();
        }
      } else {
        pending.push(line);
        if (pending.length > context) pending.shift();
      }
      continue;
    }
    if (current.length > 0 && trailing >= context && pending.length >= context) {
      // Gap between changes exceeds 2×context: close the hunk.
      flush();
    }
    if (current.length === 0) current.push(...pending);
    else if (pending.length > 0) current.push(...pending);
    pending = [];
    current.push(line);
    trailing = 0;
  }
  flush();
  return hunks;
}

function hunkHeader(lines: readonly DiffLine[]): string {
  const oldStart = lines.find((l) => l.oldNo !== undefined)?.oldNo ?? 0;
  const newStart = lines.find((l) => l.newNo !== undefined)?.newNo ?? 0;
  const oldCount = lines.filter((l) => l.kind !== "add").length;
  const newCount = lines.filter((l) => l.kind !== "del").length;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse a unified patch into hunks. Ignores file headers. */
export function parseUnifiedPatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let lines: DiffLine[] | undefined;
  let header = "";
  let oldNo = 0;
  let newNo = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  for (const raw of rows) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      if (lines) hunks.push({ header, lines });
      lines = [];
      header = raw;
      oldNo = Number.parseInt(m[1] ?? "1", 10);
      newNo = Number.parseInt(m[3] ?? "1", 10);
      continue;
    }
    if (!lines) continue; // file header
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") lines.push({ kind: "add", text, newNo: newNo++ });
    else if (mark === "-") lines.push({ kind: "del", text, oldNo: oldNo++ });
    else if (mark === " " || raw === "") lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  }
  if (lines) hunks.push({ header, lines });
  return hunks;
}

export function diffStats(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }
  return { added, removed };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function bounded(hunks: readonly DiffHunk[]): { hunks: DiffHunk[]; truncated: boolean } {
  let budget = MAX_DIFF_LINES;
  const out: DiffHunk[] = [];
  let truncated = false;
  for (const h of hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (h.lines.length <= budget) {
      out.push(h);
      budget -= h.lines.length;
    } else {
      out.push({ header: h.header, lines: h.lines.slice(0, budget) });
      budget = 0;
      truncated = true;
    }
  }
  return { hunks: out, truncated };
}

/** Build the diff view for an edit/write tool call, or `undefined` when nothing is derivable yet. */
export function diffViewForTool(
  kind: "edit" | "write",
  args: unknown,
  details: Record<string, unknown> | undefined,
): DiffView | undefined {
  const a = isRecord(args) ? args : {};
  const path = str(a["path"]) || undefined;

  if (kind === "edit") {
    const patch = str(details?.["patch"]);
    if (patch) {
      const { hunks, truncated } = bounded(parseUnifiedPatch(patch));
      if (hunks.length > 0) return { ...(path ? { path } : {}), hunks, truncated };
    }
    const edits = Array.isArray(a["edits"]) ? a["edits"] : [];
    const hunks: DiffHunk[] = [];
    for (const edit of edits) {
      if (!isRecord(edit)) continue;
      const oldText = str(edit["oldText"]);
      const newText = str(edit["newText"]);
      if (!oldText && !newText) continue;
      hunks.push(...diffLines(oldText, newText));
    }
    if (hunks.length === 0) return undefined;
    const b = bounded(hunks);
    return { ...(path ? { path } : {}), hunks: b.hunks, truncated: b.truncated };
  }

  const content = str(a["content"]);
  if (!content) return undefined;
  const lines = splitLines(content).map((text, i): DiffLine => ({ kind: "add", text, newNo: i + 1 }));
  const b = bounded([{ header: `@@ -0,0 +1,${lines.length} @@`, lines }]);
  return { ...(path ? { path } : {}), hunks: b.hunks, truncated: b.truncated };
}
