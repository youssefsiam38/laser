/**
 * One side's raw bytes, for a file git has no lines to diff (M20-T5).
 *
 * A person reviewing a change to a picture wants to see the picture. `git
 * diff` answers "Binary files differ", so the overlay reads the two ends
 * itself — the same ends its patch spans, never the working tree substituted
 * for a ref — and draws them.
 *
 * Three bounds, all of them here rather than in the caller:
 *
 *  - **Only what a browser paints.** Bytes are served for a media type in
 *    `IMAGE_MEDIA_TYPES` and for nothing else. An archive, a font or a `.wasm`
 *    is answered with its size, which is all the overlay shows for it, and a
 *    caller cannot turn this into a general file-download method.
 *  - **Only under `FILE_BLOB_MAX_BYTES`.** For a git ref the size is read with
 *    `cat-file -s` first, so an oversized blob is never even loaded.
 *  - **Only one page at a time**, `FILE_BLOB_PAGE_MAX_BYTES` of raw bytes,
 *    base64 on the wire.
 *
 * Git is spawned with an argument array and never a shell, and stdout is read
 * as bytes: the shared `runGit` decodes UTF-8, which would corrupt a PNG.
 */
import {
  ErrorCodes,
  FILE_BLOB_MAX_BYTES,
  FILE_BLOB_PAGE_MAX_BYTES,
  ProtocolError,
  imageHeaderSize,
  imageMediaTypeForPath,
  type FileBlob,
  type FileBlobRefusal,
} from "@lasercode/protocol";
import { gitEnv } from "@lasercode/protocol/git-run";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { assertGitRef, assertRepoFile } from "./diff.js";
import type { RepoRef } from "./repositories.js";

/** Media type declared for bytes this app will not draw. */
const OPAQUE_MEDIA_TYPE = "application/octet-stream";

/** Enough of the payload for `imageHeaderSize`, which decodes 4 KiB at most. */
const HEADER_PROBE_BYTES = 8 * 1024;

const GIT_TIMEOUT_MS = 15_000;

export async function fileBlob(
  repo: RepoRef,
  file: string,
  ref: string | undefined,
  offset = 0,
  limit = FILE_BLOB_PAGE_MAX_BYTES,
): Promise<FileBlob> {
  const path = assertRepoFile(repo.path, file);
  const mediaType = imageMediaTypeForPath(path);
  const side = !ref || ref === "worktree" ? "worktree" : ref;
  const base = { repo: repo.path, path, ref: side, mediaType: mediaType ?? OPAQUE_MEDIA_TYPE };

  const size = side === "worktree" ? worktreeSize(repo.path, path) : await refSize(repo.path, side, path);
  // Nothing is read for a file we would refuse to send: the size is the whole
  // answer for it, and for a git ref that answer cost one `cat-file -s`.
  if (!mediaType) return refusal(base, size, "not-an-image");
  if (size > FILE_BLOB_MAX_BYTES) return refusal(base, size, "too-large");
  if (size === 0) return refusal(base, size, "empty");

  const bytes = side === "worktree" ? readWorktree(repo.path, path) : await readRef(repo.path, side, path);
  return page(base, bytes, offset, limit);
}

function refusal(
  base: { repo: string; path: string; ref: string; mediaType: string },
  totalBytes: number,
  refused: FileBlobRefusal,
): FileBlob {
  return { ...base, totalBytes, offset: 0, bytes: 0, truncated: totalBytes > 0, refused };
}

function page(
  base: { repo: string; path: string; ref: string; mediaType: string },
  buffer: Buffer,
  offset: number,
  limit: number,
): FileBlob {
  const totalBytes = buffer.length;
  const from = Math.min(Math.max(offset, 0), totalBytes);
  const asked = Math.min(Math.max(limit, 4), FILE_BLOB_PAGE_MAX_BYTES);
  const to = Math.min(from + asked, totalBytes);
  const slice = buffer.subarray(from, to);
  const next = to < totalBytes ? to : undefined;
  return {
    ...base,
    totalBytes,
    offset: from,
    bytes: slice.length,
    ...(next !== undefined ? { next } : {}),
    truncated: next !== undefined,
    ...(slice.length > 0 ? { data: slice.toString("base64") } : {}),
    // The header is in the first bytes, so only the first page can declare a
    // size — and it declares it from the header alone, never from a decode.
    ...(from === 0 ? headerSize(buffer, totalBytes) : {}),
  };
}

function headerSize(buffer: Buffer, totalBytes: number): { width?: number; height?: number } {
  const probe = buffer.subarray(0, Math.min(buffer.length, HEADER_PROBE_BYTES)).toString("base64");
  // The plausibility bound belongs to the whole payload, not to the probe.
  const size = imageHeaderSize(probe, Math.ceil(totalBytes / 3) * 4);
  return size ? { width: size.width, height: size.height } : {};
}

function worktreeSize(repo: string, path: string): number {
  try {
    const info = statSync(resolve(repo, path));
    if (!info.isFile()) throw new ProtocolError(ErrorCodes.InvalidParams, "That path is not a file.");
    return info.size;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in the working tree.");
  }
}

function readWorktree(repo: string, path: string): Buffer {
  try {
    return readFileSync(resolve(repo, path));
  } catch {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in the working tree.");
  }
}

async function refSize(repo: string, ref: string, path: string): Promise<number> {
  assertGitRef(ref);
  const shown = await gitBytes(repo, ["cat-file", "-s", `${ref}:${path}`]);
  const size = Number.parseInt(shown.stdout.toString("utf8").trim(), 10);
  if (shown.exitCode !== 0 || !Number.isInteger(size) || size < 0) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in this revision.");
  }
  return size;
}

async function readRef(repo: string, ref: string, path: string): Promise<Buffer> {
  assertGitRef(ref);
  const shown = await gitBytes(repo, ["cat-file", "-p", `${ref}:${path}`]);
  if (shown.exitCode !== 0) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That file is not in this revision.");
  }
  return shown.stdout;
}

/**
 * `runGit` with the same env scrubbing, reading stdout as bytes. The shared
 * runner returns a UTF-8 string, which is right for a patch and destroys a
 * picture; nothing else about the call differs.
 */
function gitBytes(cwd: string, args: readonly string[]): Promise<{ stdout: Buffer; exitCode: number }> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        // One page beyond the ceiling: enough to see that a blob is too large
        // without letting a hostile size allocate without bound.
        maxBuffer: FILE_BLOB_MAX_BYTES + FILE_BLOB_PAGE_MAX_BYTES,
        encoding: "buffer",
        // The same per-command scrubbing the shared runner does: an inherited
        // GIT_DIR must not retarget the repository this page came from.
        env: gitEnv(),
      },
      (error, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        if (!error) {
          done({ stdout: out, exitCode: 0 });
          return;
        }
        const errno = error as NodeJS.ErrnoException & { status?: unknown };
        if (errno.code === "ENOENT") {
          fail(new Error("git is not installed"));
          return;
        }
        done({ stdout: out, exitCode: typeof errno.status === "number" ? errno.status : 1 });
      },
    );
  });
}
