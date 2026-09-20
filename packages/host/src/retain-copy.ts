/**
 * Fd copy, walk, scan, and closed-set primitives for a retained generation
 * tree. The store lock and publish/adopt decision live in retain-store.ts.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  RUNTIME_MANIFEST_NAME,
  RuntimeGenerationError,
  safeRuntimeRelativePath,
  type RuntimeGenerationManifest,
} from "./runtime-generation.js";

export const RUNTIME_RETAIN_DIR_NAME = "runtime-generations";
export const RUNTIME_SUPPLEMENT_NAME = "runtime-supplement.json";
export const RUNTIME_RETAINED_MARKER_NAME = "RETAINED";
export const RUNTIME_RETAIN_STAGING_MARKER_NAME = "STAGING";

export const HASH = /^[0-9a-f]{64}$/;
export const HEX_TOKEN = /^[0-9a-f]{16,128}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const COPY_BUFFER = 64 * 1024;
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export type RuntimeRetainErrorReason =
  | "failed-disk"
  | "failed-permission"
  | "failed-exec"
  | "failed-changed"
  | "failed-corrupt"
  | "failed-lock";

export class RuntimeRetainError extends Error {
  override readonly name = "RuntimeRetainError";
  constructor(readonly reason: RuntimeRetainErrorReason, message?: string) {
    super(message ?? copyFor(reason));
  }
}

function copyFor(reason: RuntimeRetainErrorReason): string {
  switch (reason) {
    case "failed-disk":
      return "There is not enough free space to keep this version of the app running after an update.";
    case "failed-permission":
      return "The app could not write a private copy of its runtime.";
    case "failed-exec":
      return "The app could not execute its retained runtime. The copy may be on a noexec filesystem.";
    case "failed-changed":
      return "The app's files changed while it was making a private copy. Try again.";
    case "failed-corrupt":
      return "The app's retained runtime is missing or damaged. Restart the app to use the installed version.";
    case "failed-lock":
      return "Another copy of the app is preparing its runtime. Try again.";
  }
}

export function mapFsError(error: unknown, fallback: RuntimeRetainErrorReason): never {
  if (error instanceof RuntimeRetainError) throw error;
  if (error instanceof RuntimeGenerationError) {
    throw new RuntimeRetainError(error.reason === "update" ? "failed-changed" : "failed-corrupt");
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSPC") throw new RuntimeRetainError("failed-disk");
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new RuntimeRetainError("failed-permission");
  if (code === "EEXIST") throw new RuntimeRetainError("failed-lock");
  throw new RuntimeRetainError(fallback);
}

export interface RuntimeSupplementRow {
  path: string;
  length: number;
  sha256: string;
  mode: number;
}

export interface RuntimeSupplementManifest {
  schemaVersion: 1;
  generationId: string;
  manifestDigest: string;
  supplementDigest: string;
  files: RuntimeSupplementRow[];
}

export type RetainCopyBoundary = "source-opened" | "before-recheck" | "before-publish";

export interface RetainProgress {
  phase: "copying" | "verifying" | "ready" | "failed";
  copiedBytes?: number;
  totalBytes?: number;
  copiedFiles?: number;
  totalFiles?: number;
}

export function sanitizedRetainFileMode(mode: number): number {
  return ((mode & ~0o6000) & 0o111) !== 0 ? 0o755 : 0o644;
}

export function retainedRuntimeDigest(generationId: string, manifestDigest: string, supplementDigest: string): string {
  return sha256(`${generationId}\0${manifestDigest}\0${supplementDigest}`);
}

function compareRetainPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function runtimeSupplementDigest(
  rows: readonly Pick<RuntimeSupplementRow, "path" | "length" | "sha256" | "mode">[],
): string {
  return sha256([...rows]
    .sort((left, right) => compareRetainPath(left.path, right.path))
    .map((row) => `${row.path}\0${row.length}\0${row.sha256}\0${row.mode}\n`)
    .join(""));
}

function treePrefix(entry: string, marker: string): string | undefined {
  const parts = entry.split("/");
  const index = parts.indexOf(marker);
  if (index === -1) return undefined;
  return parts.slice(0, index + 1).join("/");
}

export function joinRoot(root: string, rel: string): string {
  return rel === "" ? root : join(root, ...rel.split("/"));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function fsyncDirectory(path: string): void {
  try { fsyncPath(path); } catch { /* Windows cannot fsync a directory. */ }
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  if (NOFOLLOW !== 0) {
    return mode === undefined ? openSync(path, flags | NOFOLLOW) : openSync(path, flags | NOFOLLOW, mode);
  }
  let listed: Stats;
  try {
    listed = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (flags & constants.O_CREAT) === 0) throw error;
    const created = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
    try {
      if (!fstatSync(created).isFile()) {
        closeSync(created);
        throw new RuntimeRetainError("failed-corrupt");
      }
      return created;
    } catch (openedError) {
      closeSync(created);
      throw openedError;
    }
  }
  if (listed.isSymbolicLink() || !listed.isFile()) throw new RuntimeRetainError("failed-corrupt");
  const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) {
      closeSync(fd);
      throw new RuntimeRetainError("failed-changed");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function hashFd(fd: number): { sha256: string; length: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER);
  let length = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, buffer.length, length);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
    length += n;
  }
  return { sha256: hash.digest("hex"), length };
}

function copyFdToFd(sourceFd: number, destFd: number): { sha256: string; length: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER);
  let length = 0;
  for (;;) {
    const n = readSync(sourceFd, buffer, 0, buffer.length, length);
    if (n === 0) break;
    let written = 0;
    while (written < n) written += writeSync(destFd, buffer, written, n - written, length + written);
    hash.update(buffer.subarray(0, n));
    length += n;
  }
  return { sha256: hash.digest("hex"), length };
}

function refuseSpecial(stat: Stats): void {
  if (stat.isSymbolicLink() || stat.isDirectory() || stat.isBlockDevice() || stat.isCharacterDevice()
    || stat.isFIFO() || stat.isSocket() || !stat.isFile()) {
    throw new RuntimeRetainError("failed-corrupt");
  }
}

function mkdirContained(root: string, relDir: string): void {
  if (relDir === "") return;
  let cursor = root;
  for (const part of relDir.split("/")) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RuntimeRetainError("failed-corrupt");
    } catch (error) {
      if (error instanceof RuntimeRetainError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") mapFsError(error, "failed-permission");
      try { mkdirSync(cursor, { mode: 0o700 }); }
      catch (makeError) { mapFsError(makeError, "failed-permission"); }
    }
  }
}

function copyRegularFile(
  source: string,
  destination: string,
  expected?: { sha256: string; length: number },
): { sha256: string; length: number; mode: number } {
  let sourceFd: number | undefined;
  let destFd: number | undefined;
  try {
    sourceFd = openNoFollow(source, constants.O_RDONLY);
    const sourceStat = fstatSync(sourceFd);
    refuseSpecial(sourceStat);
    const mode = sanitizedRetainFileMode(sourceStat.mode);
    destFd = openNoFollow(destination, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, mode);
    const copied = copyFdToFd(sourceFd, destFd);
    const destHash = hashFd(destFd);
    if (destHash.sha256 !== copied.sha256 || destHash.length !== copied.length) throw new RuntimeRetainError("failed-changed");
    if (expected && (copied.sha256 !== expected.sha256 || copied.length !== expected.length)) {
      throw new RuntimeRetainError("failed-changed");
    }
    fsyncSync(destFd);
    chmodSync(destination, mode);
    return { sha256: copied.sha256, length: copied.length, mode };
  } catch (error) {
    mapFsError(error, "failed-corrupt");
    throw error;
  } finally {
    if (destFd !== undefined) try { closeSync(destFd); } catch { /* already closed */ }
    if (sourceFd !== undefined) try { closeSync(sourceFd); } catch { /* already closed */ }
  }
}

export function copyRelativeFile(
  sourceRoot: string,
  destRoot: string,
  rel: string,
  expected: { sha256: string; length: number } | undefined,
  onBoundary?: (boundary: RetainCopyBoundary, detail: string) => void,
): { sha256: string; length: number; mode: number } {
  if (!safeRuntimeRelativePath(rel)) throw new RuntimeRetainError("failed-corrupt");
  const source = joinRoot(sourceRoot, rel);
  const destination = joinRoot(destRoot, rel);
  if (!inside(sourceRoot, source) || !inside(destRoot, destination)) throw new RuntimeRetainError("failed-corrupt");
  mkdirContained(destRoot, rel.split("/").slice(0, -1).join("/"));
  onBoundary?.("source-opened", rel);
  return copyRegularFile(source, destination, expected);
}

function walkRegularFiles(root: string, relBase: string): string[] {
  const directory = joinRoot(root, relBase);
  const files: string[] = [];
  const visit = (rel: string, treeRoot: boolean): void => {
    const absolute = joinRoot(root, rel);
    let stat: Stats;
    try { stat = lstatSync(absolute); }
    catch { throw new RuntimeRetainError("failed-corrupt"); }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      if (treeRoot) throw new RuntimeRetainError("failed-corrupt");
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === "." || name === "..") continue;
        visit(rel === "" ? name : `${rel}/${name}`, false);
      }
      return;
    }
    files.push(rel);
  };
  try { lstatSync(directory); } catch { return files; }
  visit(relBase, true);
  return files;
}

export function hashSourceFile(root: string, rel: string): { sha256: string; length: number; mode: number } {
  if (!safeRuntimeRelativePath(rel)) throw new RuntimeRetainError("failed-corrupt");
  const absolute = joinRoot(root, rel);
  let fd: number | undefined;
  try {
    fd = openNoFollow(absolute, constants.O_RDONLY);
    const stat = fstatSync(fd);
    refuseSpecial(stat);
    const hashed = hashFd(fd);
    return { ...hashed, mode: sanitizedRetainFileMode(stat.mode) };
  } catch (error) {
    mapFsError(error, "failed-changed");
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export function scanRuntimeSupplement(
  installRoot: string,
  manifest: RuntimeGenerationManifest,
): RuntimeSupplementRow[] {
  const inventory = new Set(manifest.inventory.map((row) => row.path));
  const trees = new Set<string>();
  const unpacked = treePrefix(manifest.entries.cli, "app.asar.unpacked")
    ?? treePrefix(manifest.entries.worker, "app.asar.unpacked");
  if (unpacked) trees.add(unpacked);
  if (manifest.entries.node) {
    const runtime = treePrefix(manifest.entries.node, "runtime");
    if (runtime) trees.add(runtime);
  }
  const rows: RuntimeSupplementRow[] = [];
  const seen = new Set<string>();
  for (const tree of trees) {
    for (const rel of walkRegularFiles(installRoot, tree)) {
      if (inventory.has(rel) || seen.has(rel)) continue;
      seen.add(rel);
      const hashed = hashSourceFile(installRoot, rel);
      rows.push({ path: rel, length: hashed.length, sha256: hashed.sha256, mode: hashed.mode });
    }
  }
  rows.sort((left, right) => compareRetainPath(left.path, right.path));
  return rows;
}

export function parseSupplement(raw: string): RuntimeSupplementManifest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RuntimeRetainError("failed-corrupt"); }
  const manifest = value as Partial<RuntimeSupplementManifest>;
  if (manifest.schemaVersion !== 1
    || !HASH.test(manifest.generationId ?? "")
    || !HASH.test(manifest.manifestDigest ?? "")
    || !HASH.test(manifest.supplementDigest ?? "")
    || !Array.isArray(manifest.files)) {
    throw new RuntimeRetainError("failed-corrupt");
  }
  const seen = new Set<string>();
  for (const row of manifest.files) {
    if (!safeRuntimeRelativePath(row?.path)
      || seen.has(row.path)
      || !Number.isSafeInteger(row.length)
      || row.length < 0
      || !HASH.test(row.sha256)
      || !Number.isSafeInteger(row.mode)
      || (row.mode !== 0o644 && row.mode !== 0o755)) {
      throw new RuntimeRetainError("failed-corrupt");
    }
    seen.add(row.path);
  }
  const files = manifest.files as RuntimeSupplementRow[];
  if (runtimeSupplementDigest(files) !== manifest.supplementDigest) throw new RuntimeRetainError("failed-corrupt");
  return {
    schemaVersion: 1,
    generationId: manifest.generationId as string,
    manifestDigest: manifest.manifestDigest as string,
    supplementDigest: manifest.supplementDigest as string,
    files,
  };
}

function reservedRetainName(rel: string): boolean {
  return rel === RUNTIME_MANIFEST_NAME
    || rel === RUNTIME_SUPPLEMENT_NAME
    || rel === RUNTIME_RETAINED_MARKER_NAME
    || rel === RUNTIME_RETAIN_STAGING_MARKER_NAME;
}

function isClosedSetExtra(rel: string, allowed: Set<string>): boolean {
  return !allowed.has(rel) && !reservedRetainName(rel);
}

export function assertClosedSet(root: string, allowed: Set<string>): void {
  const visit = (rel: string): void => {
    const absolute = rel === "" ? root : joinRoot(root, rel);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new RuntimeRetainError("failed-corrupt");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === "." || name === "..") continue;
        visit(rel === "" ? name : `${rel}/${name}`);
      }
      return;
    }
    if (!stat.isFile()) throw new RuntimeRetainError("failed-corrupt");
    if (rel !== "" && isClosedSetExtra(rel, allowed)) throw new RuntimeRetainError("failed-corrupt");
  };
  visit("");
}

export function writeBytes(path: string, bytes: string | Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    if (typeof bytes === "string") writeSync(fd, bytes);
    else writeSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, mode);
}
