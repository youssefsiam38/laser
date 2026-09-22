/**
 * The little bit of git publication needs, read-only (M21-T21).
 *
 * Publication has to know three things exactly: which repository the export
 * landed in, what its object format is, and whether the committed bytes at a
 * path are the exported bytes. All three are questions, not changes — every
 * command here reads, none writes, and the commit itself is taken through
 * M20's own git action with its preview and typed confirmation.
 *
 * Nothing shells out: `git` is executed with an argument array, with optional
 * locks disabled so reading cannot disturb a person's working copy, a timeout
 * and a bounded buffer. A command that fails is `undefined`, never a throw
 * carrying git's stderr into a person's screen.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CHECKPOINT_REF_NAMESPACE, parseCheckpointRef } from "@lasercode/protocol";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** One read of git, or `undefined` when it could not answer. */
export function gitRead(cwd: string, args: readonly string[]): string | undefined {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return typeof stdout === "string" ? stdout : undefined;
  } catch {
    return undefined;
  }
}

export interface GitRepository {
  /** The working tree root the export sits in. */
  toplevel: string;
  /** The common directory; a worktree's is its owner's, which is its identity. */
  commonDir: string;
  objectFormat: "sha1" | "sha256";
  /** The first commit, when the repository has one: the identity that survives a move. */
  rootCommitId?: string;
  head?: string;
  branch?: string;
}

/** The repository a directory belongs to, or nothing when it is not in one. */
export function repositoryAt(cwd: string): GitRepository | undefined {
  const toplevel = gitRead(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!toplevel) return undefined;
  const commonRaw = gitRead(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  const commonDir = commonRaw && commonRaw !== "" ? commonRaw : `${toplevel}/.git`;
  const format = gitRead(cwd, ["rev-parse", "--show-object-format"])?.trim();
  const head = gitRead(cwd, ["rev-parse", "HEAD"])?.trim();
  const branch = gitRead(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  // The root commit is the last line of the first-parent history.
  const roots = gitRead(cwd, ["rev-list", "--max-parents=0", "HEAD"])?.trim();
  const rootCommitId = roots ? roots.split(/\r?\n/).filter((line) => line !== "").pop() : undefined;
  return {
    toplevel,
    commonDir,
    objectFormat: format === "sha256" ? "sha256" : "sha1",
    ...(rootCommitId ? { rootCommitId } : {}),
    ...(head && /^[0-9a-f]{7,64}$/.test(head) ? { head } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
  };
}

/** A commit id a caller named, resolved and proved to exist. `undefined` if not. */
export function resolveCommit(cwd: string, commit: string): string | undefined {
  const resolved = gitRead(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])?.trim();
  return resolved && /^[0-9a-f]{7,64}$/.test(resolved) ? resolved : undefined;
}

/**
 * A checkpoint a caller named, resolved to the commit object it points at.
 *
 * Three things are proved before publication may use it, and any one of them
 * failing is `undefined`:
 *
 * - it is an **M20 checkpoint ref** — the worker's own namespace and layout
 *   (`parseCheckpointRef`), not an arbitrary ref name, not a branch, not a
 *   free-text id a caller invented;
 * - that ref is **in this repository right now, under exactly that name**.
 *   `for-each-ref` takes its argument as a *pattern*, and a pattern matches
 *   whole path components: `…/checkpoints/<key>` would answer for every turn
 *   under it. So the name is read back with the object id and compared, and
 *   anything but one exact match — a descendant, several refs, a different
 *   name — is no checkpoint at all;
 * - what it points at is a **commit object**, which is what a checkpoint is
 *   and what a state may be recorded against.
 */
export function checkpointCommit(cwd: string, checkpointId: string): { ref: string; commitObjectId: string } | undefined {
  if (!parseCheckpointRef(checkpointId)) return undefined;
  const listed = gitRead(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", checkpointId]);
  const lines = (listed ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) return undefined;
  const [refname, objectname] = lines[0]!.split("\0");
  if (refname !== checkpointId) return undefined;
  const objectId = (objectname ?? "").trim();
  if (!/^[0-9a-f]{7,64}$/.test(objectId)) return undefined;
  const commitObjectId = resolveCommit(cwd, objectId);
  return commitObjectId ? { ref: checkpointId, commitObjectId } : undefined;
}

/** One checkpoint this repository still has, resolved. */
export interface CheckpointRow {
  ref: string;
  commitObjectId: string;
  /** The turn it was taken at, from the ref itself. Display only. */
  turn: number;
}

/**
 * The checkpoints this repository still has, newest first, bounded.
 *
 * Discovery for a publication's source list, and nothing more: one read-only
 * `for-each-ref` over the worker's own namespace, capped at `max` rows, every
 * row parsed with the shared `parseCheckpointRef` and proved to point at a
 * commit object. A ref outside the namespace, a malformed id or an object that
 * is not a commit is dropped rather than offered.
 *
 * No worker is started and nothing is written; a checkpoint a caller actually
 * names is still proved by {@link checkpointCommit}, which this never replaces.
 */
export function listCheckpoints(cwd: string, max: number): CheckpointRow[] {
  const listed = gitRead(cwd, [
    "for-each-ref",
    `--count=${String(Math.max(1, Math.trunc(max)))}`,
    "--sort=-creatordate",
    "--format=%(refname)%00%(objectname)",
    CHECKPOINT_REF_NAMESPACE,
  ]);
  const rows: CheckpointRow[] = [];
  for (const line of (listed ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [refname, objectname] = line.split("\0");
    if (refname === undefined) continue;
    const parsed = parseCheckpointRef(refname);
    if (!parsed) continue;
    const objectId = (objectname ?? "").trim();
    if (!/^[0-9a-f]{7,64}$/.test(objectId)) continue;
    const commitObjectId = resolveCommit(cwd, objectId);
    if (!commitObjectId) continue;
    rows.push({ ref: refname, commitObjectId, turn: parsed.turn });
  }
  return rows;
}

/**
 * Every blob under one path at one commit, as `path → object id`.
 *
 * One `ls-tree` rather than one read per file: a publication of a few hundred
 * documents must not be a few hundred processes.
 */
export function treeAt(cwd: string, commit: string, pathPrefix: string): Map<string, string> {
  const out = new Map<string, string>();
  const listed = gitRead(cwd, ["ls-tree", "-r", "-z", commit, "--", pathPrefix === "" ? "." : pathPrefix]);
  if (listed === undefined) return out;
  for (const entry of listed.split("\0")) {
    if (entry === "") continue;
    // `<mode> <type> <object>\t<path>`
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(/\s+/);
    const objectId = meta[2];
    const path = entry.slice(tab + 1);
    if (meta[1] !== "blob" || !objectId) continue;
    out.set(path, objectId);
  }
  return out;
}

/**
 * The object id git would give these exact bytes.
 *
 * Computing it here rather than reading each committed blob back is what keeps
 * "is the committed file the exported file?" one command for the whole
 * export — and it is exact: a git blob is the hash of `blob <length>\0` plus
 * the content, in the repository's own object format.
 */
export function blobObjectId(objectFormat: "sha1" | "sha256", contents: string): string {
  const bytes = Buffer.from(contents, "utf8");
  const hash = createHash(objectFormat === "sha256" ? "sha256" : "sha1");
  hash.update(`blob ${String(bytes.byteLength)}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}
