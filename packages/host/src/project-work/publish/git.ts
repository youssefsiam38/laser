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
