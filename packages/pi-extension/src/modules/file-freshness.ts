/**
 * file-freshness — the match is the proof; this module only explains.
 *
 * An agent reads a file, thinks for three tool calls, then edits it. If the
 * person, another agent, or a formatter the agent itself ran through `bash`
 * changed that file in between, the edit is aimed at a file the agent has not
 * seen. The question is what to do about it.
 *
 * The rule is **content-based, not clock-based** (M13-T36, replacing the
 * refusal recorded as D-151). Pi's `edit` replaces exact text: it matches
 * every `edits[].oldText`
 * against the file *as it is on disk right now*, refuses a match it cannot
 * find and refuses a match that occurs more than once
 * (`core/tools/edit-diff.js`). That match **is** the freshness proof. An edit
 * whose old text still matches, uniquely, in the current file is safe to
 * apply no matter how old the agent's reading of the file is.
 *
 * So this module blocks nothing. It has no `tool_call` handler, and the hook
 * it does use — `tool_execution_start` — has no result type at all, so it is
 * structurally incapable of stopping a call. A wrong record can no longer cost
 * the agent a turn; the worst it can do is add a sentence that was not needed.
 *
 * What it does instead, both through the tool result's `content`:
 *
 *   1. An `edit` that **failed to match** on a file our record says changed
 *      since the agent read it: the engine says the text was not found. We add
 *      why — the file moved under you — and what to do. The engine's own text
 *      is kept; we only append.
 *   2. An `edit` that **succeeded** on such a file: a short note that the file
 *      carries changes the agent has not seen, so it re-reads before an edit
 *      that depends on the surrounding lines. This is the whole reason the
 *      content rule is safe, said out loud.
 *
 * Everything else is silent.
 *
 * Why the older mtime-refusal is gone: an agent's own edit advances the mtime,
 * and any gap between "the file changed" and "the file changed in a way that
 * matters" is a turn spent on a re-read that changed nothing. That failure
 * mode is well documented in the wild (anthropics/claude-code #3513, #7443,
 * #10437, #11463, #48390 — all reporting a refusal on a file nobody else
 * touched). A guard that takes a turn away is worse than the problem it
 * prevents.
 *
 * Two engine hooks and a per-session map are the whole mechanism.
 * `tool_execution_start` fires before a tool runs, which is the only moment at
 * which "did this file change *before* the edit?" can be asked — by the time
 * `tool_result` fires, a successful `edit` has already moved the mtime itself.
 * `tool_result` fires after, with `isError`, so what is recorded is what
 * actually happened. Overriding `read`/`write`/`edit` would inherit a
 * maintenance burden on every engine bump for no extra power
 * (`background-work`'s `bash` override exists only because it genuinely
 * replaces execution).
 *
 * A record is file metadata and nothing else — `mtimeMs` and `size`. Never the
 * contents, never a snapshot, never a hash of the bytes: a session that reads a
 * thousand files must cost a thousand small structs, not a thousand file
 * bodies. The maps themselves are bounded too (see `RECORD_LIMIT`).
 *
 * The module never throws. The engine catches a `tool_result` throw and turns
 * it into an extension error, but a failure to annotate must leave the
 * engine's own result exactly as it was, so both handlers are wrapped anyway.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ExtensionContext,
  ToolExecutionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { LaserModule, ModuleContext } from "./index.js";

/**
 * What a `tool_result` handler may return.
 *
 * The engine declares this type but does not export it from the package root
 * (`ToolCallEventResult` is exported; its sibling is not), and the root export
 * list is the supported surface — reaching past it into `dist/core` would bind
 * this module to a file layout no version promises. Only `content` is used
 * here: this module rewrites the text of a result and never its error state,
 * its details or its usage.
 */
interface ToolResultAnnotation {
  content?: ToolResultEvent["content"];
}

/**
 * How many files one session remembers having seen.
 *
 * The store is memory, so it is bounded: least-recently-touched records are
 * evicted first. At roughly a path string plus two numbers per entry this is
 * tens of kilobytes for a session that has touched more distinct files than
 * any real turn does. Evicting a record means the module has nothing to say
 * about that file, which is the correct failure direction now that saying
 * nothing is the only thing it can get wrong.
 */
const RECORD_LIMIT = 2048;

/**
 * How many in-flight `edit` calls carry an observation.
 *
 * One assistant message's tool batch is a handful of calls, and every entry is
 * deleted when its result arrives. The bound only covers calls whose result
 * never comes — an abort mid-batch — so it is small on purpose.
 */
const PENDING_LIMIT = 256;

/** Tools whose success means "the agent has seen this file as it is now". */
const RECORDING_TOOLS = new Set(["read", "write", "edit"]);

/**
 * The engine's own words for "your old text is not what the file says".
 *
 * Pinned to Pi 0.85's `core/tools/edit-diff.js`, which throws a plain `Error`
 * for each of these; the agent loop flattens it to a text block, so text is
 * all there is to match on. The three cases are the ones a file changing under
 * the agent actually produces:
 *
 *   - `Could not find the exact text in <path>.` / `Could not find edits[i] in
 *     <path>.` — the old text is gone.
 *   - `Found N occurrences of the text in <path>.` — it became ambiguous, and
 *     the engine refuses rather than replacing the first one.
 *   - `... produced identical content.` — the change is already there, usually
 *     because somebody else made it.
 *
 * Everything else an `edit` can fail with — an unreadable path, an empty
 * `oldText`, overlapping edits, an abort — has nothing to do with freshness
 * and gets no explanation from us. `test/file-freshness.test.ts` provokes each
 * one through the real engine tool, so an engine bump that rewords them fails
 * a test rather than quietly annotating everything or nothing.
 */
const MATCH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Could not find (?:the exact text|edits\[\d+\]) in /,
  /Found \d+ occurrences? of /,
  /produced identical content/,
];

/**
 * What is remembered about a file. Metadata only, by decision: no content, no
 * snapshot, no digest.
 *
 * Precision: `mtimeMs` is whatever the filesystem stores — sub-millisecond on
 * ext4 and APFS, but only whole seconds on HFS+ and some network mounts. Two
 * changes inside one timestamp tick that also leave the byte count identical
 * are therefore invisible here. That gap costs a note that is not written, not
 * a wrong edit, because the engine's match is what keeps the edit honest.
 */
interface FileRecord {
  mtimeMs: number;
  size: number;
}

interface State {
  /** Insertion-ordered, oldest first: a plain Map is the LRU. */
  records: Map<string, FileRecord>;
  /**
   * Tool call id → the paths that had already moved when the call started.
   * Written before the tool runs, read when its result arrives, and never
   * consulted for anything but wording.
   */
  pending: Map<string, string[]>;
  hooked: boolean;
  disposed: boolean;
}

/**
 * Per session, never per process. One worker runs many sessions and a child
 * agent works in its own worktree, so two sessions must never share records.
 * The key is the module context the extension factory builds once per session
 * runtime — the same shape `background-work` uses — and a `WeakMap` means a
 * finished session's records go with it.
 */
const states = new WeakMap<ModuleContext, State>();

/**
 * The identity of a file, as opposed to how it was spelled.
 *
 * `./src/a.ts`, `src/a.ts` and `/abs/src/a.ts` are one file, so paths resolve
 * against the session's cwd. Symlinks are resolved as well: a repository with
 * a symlinked directory must not end up with two independent records for one
 * file, and the engine keys its own file mutation queue by `realpath` for the
 * same reason (`core/tools/file-mutation-queue.js`). `realpath` throws for a
 * path that does not exist yet — a `write` creating a new file — so the parent
 * directory is resolved instead, which still collapses a new file created
 * inside a symlinked directory onto one key.
 */
export function fileKey(rawPath: string, cwd: string): string | undefined {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return undefined;
  try {
    const expanded = rawPath === "~" ? homedir() : rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
    const absolute = resolve(cwd || process.cwd(), expanded);
    try {
      return realpathSync(absolute);
    } catch {
      // Not there (yet), or unreadable: fall through to the parent.
    }
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  } catch {
    return undefined;
  }
}

/**
 * The file as it is on disk right now, or `undefined` when there is nothing to
 * compare against — it does not exist, it is a directory, or the stat failed
 * for any reason at all. Every one of those means we say nothing: the tool
 * reports its own errors, and this module must not invent one.
 */
function statOf(key: string): FileRecord | undefined {
  try {
    const stats = statSync(key);
    if (!stats.isFile()) return undefined;
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

/**
 * The paths one tool call touches, in the order they were spelled.
 *
 * In pinned Pi 0.85 both `EditToolInput` and `WriteToolInput` carry exactly one
 * `path` (`edits[]` holds `oldText`/`newText` only), so this normally returns a
 * single entry. It reads the plural shapes as well so that an engine bump which
 * lets one call touch several files is explained rather than silently skipped.
 */
export function pathsOf(input: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    if (value.trim().length === 0) return;
    if (!out.includes(value)) out.push(value);
  };
  if (!input || typeof input !== "object") return out;
  const record = input as Record<string, unknown>;
  push(record["path"]);
  const many = record["paths"];
  if (Array.isArray(many)) for (const value of many) push(value);
  const edits = record["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>)["path"]);
    }
  }
  return out;
}

/**
 * Said after an `edit` failed to match on a file that had moved. The engine has
 * already said the text was not found; this says why, and the recovery has to
 * be one step, because the friction case (read, run a formatter, edit) is real.
 */
export function staleEditFailureNote(paths: string[]): string {
  const list = paths.join(", ");
  const one = paths.length === 1;
  return (
    `${list} changed on disk after you last read ${one ? "it" : "them"}, ` +
    `so the text you asked to replace is no longer what the file holds. ` +
    `Read ${one ? list : "each of them"} again, then redo this edit against what is there now.`
  );
}

/**
 * Said after an `edit` succeeded on a file that had moved. The edit is right —
 * it matched the current text — so this is not a complaint; it is the one
 * thing the agent needs to know before its *next* edit to the same file.
 */
export function staleEditAppliedNote(paths: string[]): string {
  const list = paths.join(", ");
  const one = paths.length === 1;
  return (
    `This edit matched the file's current text and was applied. ` +
    `${list} changed on disk after you last read ${one ? "it" : "them"}, ` +
    `so ${one ? "it carries" : "they carry"} changes you have not seen. ` +
    `Read ${one ? list : "each of them"} again before any further edit that depends on the surrounding lines.`
  );
}

/** The text the engine put in a tool result, flattened for matching. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = (block as Record<string, unknown>)["text"];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join("\n");
}

/**
 * True when a failed `edit` failed *because the file's text is not what the
 * agent thought*, rather than for a reason freshness cannot explain.
 */
export function isEditMatchFailure(content: unknown): boolean {
  const text = textOf(content);
  if (text.length === 0) return false;
  return MATCH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function bound<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function remember(state: State, key: string, record: FileRecord): void {
  // Delete-then-set keeps the Map's insertion order as recency order.
  state.records.delete(key);
  state.records.set(key, record);
  bound(state.records, RECORD_LIMIT);
}

function touch(state: State, key: string): FileRecord | undefined {
  const record = state.records.get(key);
  if (!record) return undefined;
  state.records.delete(key);
  state.records.set(key, record);
  return record;
}

/**
 * `tool_execution_start`: the observation, taken before the tool runs.
 *
 * This is the only moment the question can be asked. A successful `edit`
 * rewrites the file, so by `tool_result` the mtime has moved for a reason that
 * has nothing to do with anybody else. Nothing is decided here and nothing can
 * be blocked — `ToolExecutionStartEvent` has no result type — the verdict is
 * only parked under the call's id for the wording later.
 *
 * A `read` immediately followed by an `edit` observes nothing, because a
 * record is modification time and size — never access time — and the
 * re-recording after a successful `edit` or `write` is why an agent's own
 * change can never be reported back to it as somebody else's.
 */
function observe(state: State, event: ToolExecutionStartEvent, cwd: string): void {
  if (state.disposed) return;
  if (event.toolName !== "edit") return;
  const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (id.length === 0) return;
  const moved: string[] = [];
  for (const spelled of pathsOf(event.args)) {
    const key = fileKey(spelled, cwd);
    if (!key) continue;
    const record = touch(state, key);
    if (!record) continue; // Never read or written here: nothing to compare, nothing to say.
    const current = statOf(key);
    if (!current) continue; // Missing, a directory, or an unreadable stat: the tool reports its own error.
    if (current.mtimeMs === record.mtimeMs && current.size === record.size) continue;
    moved.push(spelled);
  }
  state.pending.delete(id);
  if (moved.length === 0) return;
  state.pending.set(id, moved);
  bound(state.pending, PENDING_LIMIT);
}

/**
 * `tool_result`: record what actually happened, and say the one thing worth
 * saying about it.
 *
 * A failed call changed nothing worth remembering, and re-recording after a
 * *successful* `write` or `edit` is the single most important detail in this
 * module: it is what stops five edits in a row to one file from producing four
 * notes about the agent's own work.
 */
function settle(state: State, event: ToolResultEvent, cwd: string): ToolResultAnnotation | undefined {
  if (state.disposed) return undefined;
  const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const moved = id.length > 0 ? state.pending.get(id) : undefined;
  if (id.length > 0) state.pending.delete(id);

  if (!event.isError && RECORDING_TOOLS.has(event.toolName)) {
    for (const spelled of pathsOf(event.input)) {
      const key = fileKey(spelled, cwd);
      if (!key) continue;
      const current = statOf(key);
      if (!current) continue;
      remember(state, key, current);
    }
  }

  if (event.toolName !== "edit") return undefined;
  if (!moved || moved.length === 0) return undefined;
  if (!Array.isArray(event.content)) return undefined;
  if (event.isError && !isEditMatchFailure(event.content)) return undefined;
  const note = event.isError ? staleEditFailureNote(moved) : staleEditAppliedNote(moved);
  // Append: the engine's own words are never replaced or hidden.
  return { content: [...event.content, { type: "text", text: note }] };
}

export const fileFreshnessModule: LaserModule = {
  name: "file-freshness",

  // Laser's own, like `subagents` and `background-work`: there is no package to
  // probe for and nothing to configure, so it is on wherever the module list is.
  detect: () => true,

  activate(ctx) {
    const state: State =
      states.get(ctx) ?? { records: new Map(), pending: new Map(), hooked: false, disposed: false };
    state.disposed = false;
    states.set(ctx, state);
    // Pi has no `off` for `pi.on`, so a second activation on the same context
    // would leave two handlers running against one map. Arm once.
    if (!state.hooked) {
      state.hooked = true;
      ctx.pi.on("tool_execution_start", (event: ToolExecutionStartEvent, toolCtx: ExtensionContext) => {
        try {
          observe(state, event, toolCtx?.cwd ?? "");
        } catch {
          // An observation we could not take is a sentence we will not write.
        }
      });
      ctx.pi.on("tool_result", (event: ToolResultEvent, toolCtx: ExtensionContext) => {
        try {
          return settle(state, event, toolCtx?.cwd ?? "");
        } catch {
          // Leave the engine's result exactly as it was.
          return undefined;
        }
      });
    }
    return () => {
      state.disposed = true;
      state.records.clear();
      state.pending.clear();
    };
  },
};
