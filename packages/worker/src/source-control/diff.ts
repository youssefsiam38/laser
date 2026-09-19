import { ErrorCodes, FILE_DIFF_MAX_BYTES, ProtocolError, gitLooksBinary, sliceUtf8RangeFrom, utf8ByteLength, type FileSlice } from "@lasercode/protocol";
import { readFileSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { untrackedPaths, type ResolvedRange } from "./changes.js";
import { runGit } from "./git-run.js";
import type { RepoRef } from "./repositories.js";

export function assertRepoFile(repo: string, file: string): string {
  if (!file || file.includes("\0") || file.startsWith("/")) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That path is not a file in this repository.");
  }
  const target = resolve(repo, file);
  const rel = relative(repo, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That path is not a file in this repository.");
  }
  return rel.split(sep).join("/");
}

export async function fileDiff(repo: RepoRef, range: ResolvedRange, file: string, context = 3, offset = 0, limit = FILE_DIFF_MAX_BYTES): Promise<FileSlice> {
  const path = assertRepoFile(repo.path, file);
  if (range.pruned && range.pruned.oldestTurn === undefined) {
    return emptySlice(repo.path, path, offset);
  }
  // The uncommitted scope lists a new, unignored file as an addition with the
  // lines it has on disk. `git diff HEAD` has nothing to say about a path git
  // does not track, so the body would be empty under a rail row promising
  // `+N`. Both paths ask `untrackedPaths` the same question, and the patch is
  // git's own, against the empty file.
  if (range.porcelain && (await untrackedPaths(repo)).has(path)) {
    return pageText(repo.path, path, await untrackedPatch(repo, path, context), offset, limit);
  }
  const ends = range.to ? [range.from, range.to] : [range.from];
  const diff = await runGit({
    cwd: repo.path,
    args: [
      "diff",
      `--unified=${Math.max(0, Math.min(context, 100))}`,
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      ...ends,
      "--",
      `:(literal)${path}`,
    ],
    timeoutMs: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (diff.timedOut || diff.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Reading that diff took too long or the result was too large.");
  }
  if (diff.exitCode > 1) {
    throw new ProtocolError(ErrorCodes.InvalidParams, diff.stderr.trim() || "Could not read that diff.");
  }
  return pageText(repo.path, path, diff.stdout, offset, limit);
}

/**
 * The patch for a file that exists only on disk: git's own diff of the empty
 * file against it, so the `+` lines, the mode, the no-newline marker and the
 * "Binary files differ" line are all git's and not ours. Argument array, no
 * shell, and the path is the repository-relative one `assertRepoFile`
 * already contained — bare, because `./` would leak into the patch header.
 */
async function untrackedPatch(repo: RepoRef, path: string, context: number): Promise<string> {
  const diff = await runGit({
    cwd: repo.path,
    args: [
      "diff",
      "--no-index",
      `--unified=${Math.max(0, Math.min(context, 100))}`,
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      devNull,
      path,
    ],
    timeoutMs: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (diff.timedOut || diff.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Reading that diff took too long or the result was too large.");
  }
  // `--no-index` exits 1 when the two sides differ, which is the whole point.
  if (diff.exitCode > 1) {
    throw new ProtocolError(ErrorCodes.InvalidParams, diff.stderr.trim() || "Could not read that diff.");
  }
  return diff.stdout;
}

/**
 * A revision we are willing to concatenate into `<ref>:<path>`: no option, no
 * range, no reflog, no pathspec magic. Shared with the byte path (`blob.ts`)
 * so one file cannot be stricter than the other.
 */
export function assertGitRef(ref: string): string {
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("@{") || /[\s:~^?*\\\[]/.test(ref)) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That revision is not a usable git ref.");
  }
  return ref;
}

export async function fileSource(repo: RepoRef, file: string, ref: string | undefined, offset = 0, limit = FILE_DIFF_MAX_BYTES): Promise<FileSlice> {
  const path = assertRepoFile(repo.path, file);
  if (!ref || ref === "worktree") {
    return pageWorktree(repo.path, path, offset, limit);
  }
  assertGitRef(ref);
  const shown = await runGit({
    cwd: repo.path,
    args: ["cat-file", "-p", `${ref}:${path}`],
    timeoutMs: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (shown.exitCode !== 0) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in this revision.");
  }
  return pageText(repo.path, path, shown.stdout, offset, limit);
}

function pageWorktree(repo: string, path: string, offset: number, limit: number): FileSlice {
  try {
    const target = resolve(repo, path);
    const info = statSync(target);
    if (!info.isFile()) throw new ProtocolError(ErrorCodes.InvalidParams, "That path is not a file.");
    if (info.size > 8 * 1024 * 1024) {
      return { repo, path, totalBytes: info.size, offset: 0, bytes: 0, truncated: true, binary: true };
    }
    const buffer = readFileSync(target);
    if (gitLooksBinary(buffer)) {
      return { repo, path, totalBytes: buffer.length, offset: 0, bytes: 0, truncated: buffer.length > 0, binary: true };
    }
    return pageText(repo, path, buffer.toString("utf8"), offset, limit);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in the working tree.");
  }
}

function pageText(repo: string, path: string, text: string, offset: number, limit: number): FileSlice {
  if (gitLooksBinary(Buffer.from(text.slice(0, 8192)))) {
    const totalBytes = utf8ByteLength(text);
    return { repo, path, totalBytes, offset: 0, bytes: 0, truncated: totalBytes > 0, binary: true };
  }
  const totalBytes = utf8ByteLength(text);
  const asked = Math.min(Math.max(limit, 4), FILE_DIFF_MAX_BYTES);
  const slice = sliceUtf8RangeFrom(text, offset, asked, undefined, totalBytes);
  if (!slice) throw new ProtocolError(ErrorCodes.InvalidParams, "That byte range does not fall on a character boundary.");
  return {
    repo,
    path,
    totalBytes,
    offset: slice.offset,
    bytes: slice.bytes,
    ...(slice.next !== undefined ? { next: slice.next } : {}),
    truncated: slice.truncated,
    ...(slice.text ? { text: slice.text } : {}),
  };
}

function emptySlice(repo: string, path: string, offset: number): FileSlice {
  return { repo, path, totalBytes: 0, offset, bytes: 0, truncated: false };
}

