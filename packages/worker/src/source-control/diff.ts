import { ErrorCodes, FILE_DIFF_MAX_BYTES, ProtocolError, sliceUtf8RangeFrom, utf8ByteLength, type FileSlice } from "@lasercode/protocol";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ResolvedRange } from "./changes.js";
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
  if (range.pruned) {
    return emptySlice(repo.path, path, offset);
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
  if (diff.exitCode > 1) {
    throw new ProtocolError(ErrorCodes.InvalidParams, diff.stderr.trim() || "Could not read that diff.");
  }
  return pageText(repo.path, path, diff.stdout, offset, limit);
}

export async function fileSource(repo: RepoRef, file: string, ref: string | undefined, offset = 0, limit = FILE_DIFF_MAX_BYTES): Promise<FileSlice> {
  const path = assertRepoFile(repo.path, file);
  if (!ref || ref === "worktree") {
    return pageWorktree(repo.path, path, offset, limit);
  }
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("@{") || /[\s:~^?*\\\[]/.test(ref)) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That revision is not a usable git ref.");
  }
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
    if (looksBinary(buffer)) {
      return { repo, path, totalBytes: buffer.length, offset: 0, bytes: 0, truncated: buffer.length > 0, binary: true };
    }
    return pageText(repo, path, buffer.toString("utf8"), offset, limit);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in the working tree.");
  }
}

function pageText(repo: string, path: string, text: string, offset: number, limit: number): FileSlice {
  if (looksBinary(Buffer.from(text.slice(0, 8192)))) {
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

function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, 8192);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}
