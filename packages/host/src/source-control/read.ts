/**
 * Read-only git for the host (M21-T18).
 *
 * The worker owns writing checkpoints and running git actions; the host owns
 * the project-work record, and a record of what happened in a repository has
 * to be read from the repository. This module is the whole of what the host
 * reads: repositories, object ids, checkpoint refs, the files between two
 * commits and one file's bytes at one commit.
 *
 * Three rules it never bends:
 *
 * - **Nothing here writes.** No `update-ref`, no index, no checkout, no fetch.
 *   Every command is a plumbing read with a timeout and a bounded buffer, and
 *   a failure answers `undefined` rather than throwing a git error at a
 *   person.
 * - **An object id is identity, a ref is a name.** A ref is resolved once, at
 *   record time, and what is kept is the object id it pointed at. Asking again
 *   later may find nothing; it never finds something else and calls it the
 *   same thing.
 * - **Every argument is an argv element.** No shell, no interpolation, and a
 *   revision that does not look like one is refused before git sees it
 *   (`docs/source-control-leap.md` §G.4).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  CHECKPOINT_REF_NAMESPACE,
  listCheckpointRepositories,
  parseCheckpointRef,
  type FileChangeStatus,
} from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { gitEnv, runGit } from "@lasercode/protocol/git-run";
import { createWorkspaceResolver } from "../workspace.js";

const resolver = createWorkspaceResolver();

/** How long any one read may take. A hung git is an absent answer, not a stall. */
const READ_TIMEOUT_MS = 10_000;
/** The most one read may return before it is treated as too large to use. */
const READ_MAX_BYTES = 8 * 1024 * 1024;

/** One repository of a checkout's workspace shape, as this module reads it. */
export interface HostRepository {
  /** Work-tree root (`rev-parse --show-toplevel`). */
  path: string;
  /** Absolute git common dir; a linked worktree resolves to its owner's. */
  gitDir: string;
  /** The directory's own name. Display context only. */
  name: string;
}

/** One checkpoint ref as it stands right now. */
export interface CheckpointRefRow {
  sessionKey: string;
  turn: number;
  ref: string;
  commitObjectId: string;
  createdAt: string;
  failed: boolean;
}

/** One file between two commits, from `git diff`. */
export interface ChangedFileRow {
  path: string;
  status: FileChangeStatus;
  added: number | null;
  removed: number | null;
  /** The head-side blob object id, absent when the file was deleted. */
  blobObjectId?: string;
}

/** The exact change between two commits: its files, and the digest over them. */
export interface DiffFingerprint {
  digest: string;
  files: ChangedFileRow[];
}

export { checkpointSessionKey };

/**
 * The repositories a checkout belongs to, through the one workspace resolver
 * the harness and the checkpoint engine already share.
 *
 * A bare repository is excluded, exactly as checkpoint capture excludes it:
 * there is no work tree, so there is nothing an attempt could have changed.
 */
export async function workspaceRepositories(cwd: string, options: { rescan?: boolean } = {}): Promise<HostRepository[]> {
  // Recording an attempt rescans, as the session-delete cleanup does: a
  // repository may have been added since the shape was last resolved, and
  // leaving one out of the record would understate what the attempt changed.
  // Everything else takes the shared cached shape.
  const shape = await resolver.resolve(cwd, options.rescan === true ? { rescan: true } : {}).catch(() => undefined);
  if (!shape) return [];
  return listCheckpointRepositories(shape).map((tree) => ({
    path: tree.path,
    gitDir: tree.gitDir,
    name: basename(tree.path) || tree.path,
  }));
}

async function read(repo: HostRepository, args: readonly string[]): Promise<string | undefined> {
  const result = await runGit({ cwd: repo.path, args, timeoutMs: READ_TIMEOUT_MS, maxBuffer: READ_MAX_BYTES }).catch(() => undefined);
  if (!result || result.timedOut || result.overflow || result.exitCode !== 0) return undefined;
  return result.stdout;
}

/**
 * One read's **raw bytes**, bounded, with nothing decoded.
 *
 * `runGit` hands back a string, and a string is already a decision about what
 * the bytes were: Node's lossy UTF-8 decode turns an invalid sequence into
 * U+FFFD, which re-encodes to three bytes of its own. `f0 90 80` — a
 * truncated four-byte sequence — therefore comes back as something that
 * weighs exactly what the file weighed and says something else entirely, so
 * no comparison made after the decode can tell the two apart (review F9).
 * Anything that has to know what a file *is* reads it through here.
 *
 * Same rules as {@link read}: no shell, a timeout, a bounded buffer, and a
 * failure is an absent answer rather than a thrown git error.
 */
function readBytes(repo: HostRepository, args: readonly string[], maxBuffer: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd: repo.path, timeout: READ_TIMEOUT_MS, maxBuffer, encoding: "buffer", env: gitEnv() },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8"));
      },
    );
  });
}

/** `sha1` or `sha256`, as this repository declares it. */
export async function objectFormatOf(repo: HostRepository): Promise<"sha1" | "sha256"> {
  const value = (await read(repo, ["rev-parse", "--show-object-format"]))?.trim();
  return value === "sha256" ? "sha256" : "sha1";
}

/** The commit `HEAD` points at, or `undefined` in a repository with none. */
export async function headCommitOf(repo: HostRepository): Promise<string | undefined> {
  const value = (await read(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.trim();
  return value && isObjectId(value) ? value : undefined;
}

/**
 * The repository's first commit: the identity that survives cloning, moving
 * the checkout and opening it through a worktree (M21-T2's identity key).
 */
export async function rootCommitOf(repo: HostRepository): Promise<string | undefined> {
  const value = await read(repo, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
  const first = value?.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  return first && isObjectId(first) ? first : undefined;
}

/** The branch `HEAD` is on, or `undefined` when it is detached. Display only. */
export async function branchOf(repo: HostRepository): Promise<string | undefined> {
  const value = (await read(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
  return value || undefined;
}

/**
 * Is this exact commit still in this repository?
 *
 * The one question a link asks git, and the only honest answer to "where did
 * this go": a pruned checkpoint or a force-pushed head answers `false`, and
 * the link keeps saying what it always said instead of resolving to `HEAD`.
 */
export async function commitExists(repo: HostRepository, objectId: string): Promise<boolean> {
  if (!isObjectId(objectId)) return false;
  const result = await runGit({
    cwd: repo.path,
    args: ["cat-file", "-e", `${objectId}^{commit}`],
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => undefined);
  return result !== undefined && !result.timedOut && result.exitCode === 0;
}

const LIST_FORMAT = "%(refname)%00%(objectname)%00%(creatordate:iso-strict)%00%(trailers:key=Failed,valueonly)";

/**
 * Every checkpoint ref in this repository, or only one session's when the
 * caller knows which session it is asking about.
 *
 * The ref namespace is the worker's (`docs/source-control-leap.md` §E.1) and
 * the session key derivation is the shared one, so the host reads exactly what
 * the worker wrote and nothing else.
 */
export async function listCheckpointRefs(repo: HostRepository, sessionKey?: string): Promise<CheckpointRefRow[]> {
  const prefix = sessionKey ? `${CHECKPOINT_REF_NAMESPACE}/${sessionKey}` : CHECKPOINT_REF_NAMESPACE;
  const listed = await read(repo, ["for-each-ref", `--format=${LIST_FORMAT}`, prefix]);
  if (!listed) return [];
  const rows: CheckpointRefRow[] = [];
  for (const chunk of listed.split("\n")) {
    if (!chunk) continue;
    const [ref, commit, createdAt, failed] = chunk.split("\0");
    if (!ref || !commit || !isObjectId(commit)) continue;
    const parsed = parseCheckpointRef(ref);
    if (!parsed) continue;
    rows.push({
      sessionKey: parsed.sessionKey,
      turn: parsed.turn,
      ref,
      commitObjectId: commit,
      createdAt: createdAt ?? "",
      failed: (failed ?? "").trim() === "1",
    });
  }
  rows.sort((a, b) => (a.turn === b.turn ? a.ref.localeCompare(b.ref) : a.turn - b.turn));
  return rows;
}

/**
 * The files between two commits, and the digest that fences them.
 *
 * The digest is taken over git's own `--raw` listing — status, path and the
 * two blob object ids per file — rather than over the patch text. It is
 * therefore exact (two different contents can never share it), bounded by the
 * number of files rather than by their size, and stable across `diff.context`,
 * colour and whitespace settings, none of which change what was delivered.
 */
export async function diffBetween(repo: HostRepository, base: string, head: string): Promise<DiffFingerprint | undefined> {
  if (!isObjectId(base) || !isObjectId(head)) return undefined;
  const [raw, numstat] = await Promise.all([
    read(repo, ["diff", "--raw", "--no-renames", "--no-ext-diff", "-z", base, head, "--"]),
    read(repo, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "-z", base, head, "--"]),
  ]);
  if (raw === undefined || numstat === undefined) return undefined;
  const counts = parseNumstat(numstat);
  const files: ChangedFileRow[] = [];
  const lines: string[] = [];
  for (const entry of parseRaw(raw)) {
    const count = counts.get(entry.path);
    files.push({
      path: entry.path,
      status: entry.status,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
      ...(entry.dstBlob && !/^0+$/.test(entry.dstBlob) ? { blobObjectId: entry.dstBlob } : {}),
    });
    lines.push(`${entry.status}\t${entry.path}\t${entry.srcBlob}\t${entry.dstBlob}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  lines.sort();
  return { digest: createHash("sha256").update(lines.join("\n")).digest("hex"), files };
}

/** The commits `head` has that `base` does not, newest first, bounded. */
export async function commitsBetween(repo: HostRepository, base: string, head: string, max: number): Promise<string[]> {
  if (!isObjectId(base) || !isObjectId(head) || max <= 0) return [];
  const listed = await read(repo, ["rev-list", `--max-count=${String(max)}`, `${base}..${head}`]);
  if (!listed) return [];
  return listed.split("\n").map((line) => line.trim()).filter((line) => isObjectId(line));
}

/** One file's bytes at one commit, bounded, with the blob id they came from. */
/**
 * One commit's parents, oldest first. Empty for a parentless commit — which is
 * what every M20 checkpoint is (`commit-tree` with no `-p`), and the reason a
 * state capture cannot always be a difference (D-361).
 */
export async function parentsOf(repo: HostRepository, commit: string): Promise<string[]> {
  if (!isObjectId(commit)) return [];
  const line = (await read(repo, ["rev-list", "--parents", "-n", "1", commit]))?.trim();
  if (!line) return [];
  return line.split(/\s+/).slice(1).filter((value) => isObjectId(value));
}

/** One entry of a commit's tree: the identity a manifest records. */
export interface TreeEntryRow {
  path: string;
  mode: string;
  blobObjectId: string;
  /** The blob's true size in bytes, as git reports it. */
  bytes: number;
}

/** A row a listing found and cannot hand back as reviewable bytes. */
export interface TreeUnreadableRow {
  path: string;
  /** Another repository recorded inside this one; its contents are not here. */
  kind: "gitlink" | "other";
}

/** One bounded listing of a commit's tree, said honestly. */
export interface TreeListing {
  /** The blob rows, in git's order, at most `limit` of them. */
  rows: TreeEntryRow[];
  /** True when the tree holds more rows than `limit`; the count is not invented. */
  truncated: boolean;
  /**
   * Rows that are in the tree and are not readable bytes — a gitlink, or
   * anything else that is not a blob. Named rather than dropped: a set that
   * silently loses them claims to be complete and is not (M21-T19, review F1).
   */
  unreadable: TreeUnreadableRow[];
}

/**
 * List one commit's tree, bounded, **inside** an optional scope.
 *
 * The scope goes into git as a literal pathspec rather than being filtered out
 * of a whole-tree listing afterwards, which is the difference between two very
 * different answers: a scope that sorts entirely past the bound would
 * otherwise look absent, and a scope preceded by more unrelated files than the
 * bound would look like a prefix of itself and pass as complete (review F1).
 *
 * `:(literal)` is what keeps a path with `*`, `?` or `[` in it a path: the
 * scope is a repository-relative path a person named, never a glob.
 *
 * `undefined` when git could not list at all, which is a different answer from
 * an empty tree and is never read as one.
 */
export async function treeListing(
  repo: HostRepository,
  commit: string,
  limit: number,
  scopePath?: string,
): Promise<TreeListing | undefined> {
  if (!isObjectId(commit) || limit <= 0) return undefined;
  if (scopePath !== undefined && !isRepoPath(scopePath)) return undefined;
  const listed = await read(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    commit,
    "--",
    ...(scopePath !== undefined ? [`:(literal)${scopePath}`] : []),
  ]);
  if (listed === undefined) return undefined;
  const rows: TreeEntryRow[] = [];
  const unreadable: TreeUnreadableRow[] = [];
  let truncated = false;
  for (const chunk of listed.split("\0")) {
    if (!chunk) continue;
    // `<mode> <type> <object> <size>\t<path>`
    const tab = chunk.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object, size] = chunk.slice(0, tab).trim().split(/\s+/);
    const path = chunk.slice(tab + 1);
    if (!mode || !object || !path) continue;
    if (type !== "blob") {
      // `-r` already walked the trees, so what is left here is a gitlink or
      // something this reader does not understand. Either way it is a row of
      // the scope whose bytes are not in this commit.
      if (unreadable.length < limit) unreadable.push({ path, kind: type === "commit" ? "gitlink" : "other" });
      continue;
    }
    if (!isObjectId(object)) continue;
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push({ path, mode, blobObjectId: object, bytes: Number(size ?? "") || 0 });
  }
  return { rows, truncated, unreadable };
}

/**
 * The whole tree of one commit, bounded.
 *
 * This is what a capture of a **state** records: a parentless checkpoint
 * commit has no difference to describe, so what survives pruning is the paths,
 * their modes and their blob object ids — identity that stays true after gc
 * has reclaimed the objects themselves, exactly as a change capture's recorded
 * ids do.
 *
 * The same listing as {@link treeListing} with no scope, keeping the shape its
 * callers read: a bounded array of blob rows, or nothing when git could not
 * answer. One parser, two questions.
 */
export async function treeManifest(repo: HostRepository, commit: string, limit: number): Promise<TreeEntryRow[] | undefined> {
  const listing = await treeListing(repo, commit, limit);
  return listing?.rows;
}

/**
 * One file's bytes at one commit.
 *
 * The blob is read as **bytes** and only then decoded, strictly: a sequence
 * that is not valid UTF-8 is a decode failure here rather than a silent
 * U+FFFD, and a file that genuinely contains U+FFFD is valid UTF-8 and is
 * captured as the text it is. A byte-length comparison after a lossy decode
 * cannot tell those two apart — which is why the decision is made on the
 * bytes (review F9).
 *
 * `bytes` is always the file's **true** size, from git. A file that is not
 * UTF-8 text, or that carries a NUL, is reported as `binary: true`: its
 * identity and its size are the record, its bytes are not captured, and
 * nothing pretends they were text a person could review.
 */
export async function fileAt(
  repo: HostRepository,
  commit: string,
  path: string,
  limitBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean; binary: boolean; blobObjectId?: string } | undefined> {
  if (!isObjectId(commit) || !isRepoPath(path)) return undefined;
  const spec = `${commit}:${path}`;
  const size = await fileSizeAt(repo, commit, path);
  if (size === undefined) return undefined;
  const blobObjectId = (await read(repo, ["rev-parse", "--verify", "--quiet", spec]))?.trim();
  const whole = await readBytes(repo, ["cat-file", "blob", spec], Math.max(limitBytes * 2, 64 * 1024));
  if (!whole) return undefined;
  // Fewer bytes than git said the blob weighs is a read this process cannot
  // account for — not a fact about the file — so it answers nothing rather
  // than recording a partial file as if it were whole.
  if (whole.byteLength !== size) return undefined;
  const text = looksBinaryBytes(whole) ? undefined : decodeUtf8(whole);
  const binary = text === undefined;
  const truncated = !binary && whole.byteLength > limitBytes;
  // A prefix of valid UTF-8 cut on a character boundary is still valid UTF-8.
  const kept = truncated ? sliceOnCharacterBoundary(whole, limitBytes).toString("utf8") : (text ?? "");
  return {
    text: binary ? "" : kept,
    bytes: size,
    truncated,
    binary,
    ...(blobObjectId && isObjectId(blobObjectId) ? { blobObjectId } : {}),
  };
}

/**
 * What git says one file weighs at one commit, without reading its bytes.
 *
 * `undefined` means the path is not in that commit at all — the one question
 * that tells "this file was deleted here" apart from "this file is too big to
 * keep whole", which is the difference between two very different refusals
 * (M21-T19).
 */
export async function fileSizeAt(repo: HostRepository, commit: string, path: string): Promise<number | undefined> {
  if (!isObjectId(commit) || !isRepoPath(path)) return undefined;
  const size = Number((await read(repo, ["cat-file", "-s", `${commit}:${path}`]))?.trim() ?? Number.NaN);
  return Number.isFinite(size) ? size : undefined;
}

/** Bytes that look like text a person can review. Anything else is not captured. */
export function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

/** The same tell, asked of bytes: git's own heuristic is a NUL in the file. */
function looksBinaryBytes(bytes: Buffer): boolean {
  return bytes.includes(0);
}

/**
 * Strict UTF-8, or nothing — and exactly the file's own characters.
 *
 * `fatal` is the whole point: an invalid or truncated sequence throws instead
 * of becoming U+FFFD, so "this is text" is something this module establishes
 * rather than assumes. A file that really contains U+FFFD decodes cleanly and
 * is text like any other.
 *
 * `ignoreBOM` is the other half: by default a decoder *eats* a leading
 * byte-order mark, so a file that starts with one would be captured without
 * it, weigh less than git says it does and digest differently from its own
 * bytes. A BOM is a character of the file here, like any other.
 */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

/** A repository-relative path git may be handed as one argv element. */
function isRepoPath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("-") && !value.includes("\u0000");
}

function sliceOnCharacterBoundary(buffer: Buffer, limit: number): Buffer {
  let end = Math.min(limit, buffer.byteLength);
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buffer.subarray(0, end);
}

interface RawEntry {
  path: string;
  status: FileChangeStatus;
  srcBlob: string;
  dstBlob: string;
}

/**
 * `git diff --raw -z`: records of `:<srcmode> <dstmode> <srcblob> <dstblob> <status>`
 * followed by the path as its own NUL-terminated field.
 */
function parseRaw(text: string): RawEntry[] {
  const fields = text.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (!meta || !meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(" ");
    const code = parts[4] ?? "";
    const path = fields[i + 1];
    if (!path) continue;
    i += 1;
    entries.push({
      path,
      status: statusOf(code),
      srcBlob: parts[2] ?? "",
      dstBlob: parts[3] ?? "",
    });
  }
  return entries;
}

/**
 * A rename and a type change are a modification of the path git reports; the
 * three statuses the product speaks are the whole vocabulary a person reads
 * (`FileChangeStatus`), and a fourth here would have to be invented in the UI
 * as well.
 */
function statusOf(code: string): FileChangeStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      return "modified";
  }
}

/** `git diff --numstat -z`: `added\tremoved\tpath\0`. Binaries use `-`. */
function parseNumstat(text: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const record of text.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (!path) continue;
    counts.set(path, {
      added: added === "-" ? null : Number.parseInt(added, 10) || 0,
      removed: removed === "-" ? null : Number.parseInt(removed, 10) || 0,
    });
  }
  return counts;
}
