/**
 * Launch-bound retained generation tree T: a digest-checked copy of a verified
 * package root's executable inventory plus a canonical supplementary inventory
 * of the unpacked and runtime trees. Pointer identity stays on the package
 * root; this module never writes runtime-generation.json.
 */
import { spawnSync } from "node:child_process";
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
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DATA_DIR_NAME } from "@lasercode/protocol";
import { isProcessAlive, processIdentity } from "./process-identity.js";
import {
  RUNTIME_MANIFEST_NAME,
  RuntimeGenerationError,
  runtimeManifestDigest,
  safeRuntimeRelativePath,
  verifyRuntimeGeneration,
  type RuntimeGenerationManifest,
  type RuntimeGenerationReference,
} from "./runtime-generation.js";

export const RUNTIME_RETAIN_DIR_NAME = "runtime-generations";
export const RUNTIME_SUPPLEMENT_NAME = "runtime-supplement.json";
export const RUNTIME_RETAINED_MARKER_NAME = "RETAINED";
export const RUNTIME_RETAIN_STORE_LOCK_NAME = ".store.lock";
export const RUNTIME_RETAIN_LEASES_DIR_NAME = "leases";
export const RUNTIME_RETAIN_STAGING_MARKER_NAME = "STAGING";

const HASH = /^[0-9a-f]{64}$/;
const HEX_TOKEN = /^[0-9a-f]{16,128}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_ATTEMPTS = 8;
const COPY_BUFFER = 64 * 1024;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

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

function mapFsError(error: unknown, fallback: RuntimeRetainErrorReason): never {
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

export type RuntimeGenerationLeaseState = "binding" | "bound" | "restarting";

export interface RuntimeGenerationLease {
  schemaVersion: 1;
  launcherLeaseId: string;
  launchId: string;
  generationId: string;
  executionRoot: string;
  retainedDigest: string;
  state: RuntimeGenerationLeaseState;
  launcherPid: number;
  launcherIdentity: string;
  daemonPid?: number;
  daemonIdentity?: string;
  createdAt: string;
  updatedAt: string;
}

export type RetainCopyBoundary = "source-opened" | "before-recheck" | "before-publish";

export interface RetainProgress {
  phase: "copying" | "verifying" | "ready" | "failed";
  copiedBytes?: number;
  totalBytes?: number;
  copiedFiles?: number;
  totalFiles?: number;
}

export interface RetainRuntimeGenerationInput {
  retainDir: string;
  selected: RuntimeGenerationReference;
  manifest: RuntimeGenerationManifest;
  launchId: string;
  launcherLeaseId?: string;
  /** Already-bound envelope; only an existing launcher may supply this when R moved on. */
  expectedRetainedDigest?: string;
  onProgress?: (progress: RetainProgress) => void;
  /** Test-only copy seam. Production leaves it absent. */
  onBoundary?: (boundary: RetainCopyBoundary, detail: string) => void;
}

export interface RetainRuntimeGenerationResult {
  reference: RuntimeGenerationReference;
  retainedDigest: string;
  supplementDigest: string;
}

export type RetainLeaseLiveness = "protected" | "reclaimable" | "unknown";

export interface RetainIdentityProbes {
  identity: (pid: number) => string | undefined;
  alive: (pid: number) => boolean;
}

const defaultProbes: RetainIdentityProbes = { identity: processIdentity, alive: isProcessAlive };

export function runtimeRetainDirFor(stateDir: string): string {
  return join(stateDir, RUNTIME_RETAIN_DIR_NAME);
}

export function defaultNativeRuntimeRetainParent(): string {
  return join("/var/lib", DATA_DIR_NAME, RUNTIME_RETAIN_DIR_NAME);
}

export function nativeUidChildAcceptable(
  stat: Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid" | "mode">,
  uid: number,
): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700;
}

export function inspectNativeRetainParent(nativeParent: string): "ok" | "absent" {
  const probe = join(nativeParent, `.retain-write-${process.pid}`);
  try {
    const stat = lstatSync(nativeParent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "absent";
    writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    unlinkSync(probe);
    return "ok";
  } catch {
    try { unlinkSync(probe); } catch { /* probe never landed */ }
    return "absent";
  }
}

export function resolveNativeRuntimeRetainDir(nativeParent: string, uid = process.getuid?.()): string | undefined {
  if (uid === undefined) return undefined;
  if (inspectNativeRetainParent(nativeParent) !== "ok") return undefined;
  const child = join(nativeParent, String(uid));
  let stat: Stats | undefined;
  try { stat = lstatSync(child); } catch { stat = undefined; }
  if (!stat) {
    try { mkdirSync(child, { mode: 0o700 }); }
    catch { return undefined; }
    try { stat = lstatSync(child); } catch { return undefined; }
  }
  if (!nativeUidChildAcceptable(stat, uid)) return undefined;
  return child;
}

export function selectRuntimeRetainParent(configuredRetainDir: string, nativeParent?: string): string {
  if (nativeParent) {
    const resolved = resolveNativeRuntimeRetainDir(nativeParent);
    if (resolved) return resolved;
  }
  return configuredRetainDir;
}

export function sanitizedRetainFileMode(mode: number): number {
  return ((mode & ~0o6000) & 0o111) !== 0 ? 0o755 : 0o644;
}

export function retainedRuntimeDigest(generationId: string, manifestDigest: string, supplementDigest: string): string {
  return sha256(`${generationId}\0${manifestDigest}\0${supplementDigest}`);
}

export function runtimeSupplementDigest(
  rows: readonly Pick<RuntimeSupplementRow, "path" | "length" | "sha256" | "mode">[],
): string {
  return sha256([...rows]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((row) => `${row.path}\0${row.length}\0${row.sha256}\0${row.mode}\n`)
    .join(""));
}

function treePrefix(entry: string, marker: string): string | undefined {
  const parts = entry.split("/");
  const index = parts.indexOf(marker);
  if (index === -1) return undefined;
  return parts.slice(0, index + 1).join("/");
}

function joinRoot(root: string, rel: string): string {
  return rel === "" ? root : join(root, ...rel.split("/"));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(path: string): void {
  try { fsyncPath(path); } catch { /* Windows cannot fsync a directory. */ }
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  if (NOFOLLOW !== 0) {
    try {
      return mode === undefined ? openSync(path, flags | NOFOLLOW) : openSync(path, flags | NOFOLLOW, mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EEXIST") throw error;
    }
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

function copyRelativeFile(
  sourceRoot: string,
  destRoot: string,
  rel: string,
  expected: { sha256: string; length: number } | undefined,
  onBoundary: RetainRuntimeGenerationInput["onBoundary"],
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
  const visit = (rel: string): void => {
    const absolute = joinRoot(root, rel);
    let stat: Stats;
    try { stat = lstatSync(absolute); }
    catch { throw new RuntimeRetainError("failed-corrupt"); }
    if (stat.isSymbolicLink()) throw new RuntimeRetainError("failed-corrupt");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === "." || name === "..") continue;
        visit(rel === "" ? name : `${rel}/${name}`);
      }
      return;
    }
    if (!stat.isFile()) throw new RuntimeRetainError("failed-corrupt");
    files.push(rel);
  };
  try { lstatSync(directory); } catch { return files; }
  visit(relBase);
  return files;
}

function hashSourceFile(root: string, rel: string): { sha256: string; length: number; mode: number } {
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
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return rows;
}

function parseSupplement(raw: string): RuntimeSupplementManifest {
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

function assertClosedSet(root: string, allowed: Set<string>): void {
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

export function verifyRetainedRuntimeGeneration(
  reference: RuntimeGenerationReference,
  retainedDigest: string,
): RuntimeGenerationManifest {
  if (!HASH.test(retainedDigest)) throw new RuntimeRetainError("failed-corrupt");
  let manifest: RuntimeGenerationManifest;
  try {
    manifest = verifyRuntimeGeneration(reference, true);
  } catch (error) {
    if (error instanceof RuntimeGenerationError) {
      throw new RuntimeRetainError(error.reason === "update" || error.reason === "drift" ? "failed-changed" : "failed-corrupt");
    }
    throw error;
  }
  const root = reference.installRoot;
  let supplementRaw: string;
  try { supplementRaw = readFileSync(joinRoot(root, RUNTIME_SUPPLEMENT_NAME), "utf8"); }
  catch { throw new RuntimeRetainError("failed-corrupt"); }
  const supplement = parseSupplement(supplementRaw);
  if (supplement.generationId !== reference.generationId || supplement.manifestDigest !== reference.manifestDigest) {
    throw new RuntimeRetainError("failed-changed");
  }
  const allowed = new Set<string>([
    ...manifest.inventory.map((row) => row.path),
    ...supplement.files.map((row) => row.path),
  ]);
  for (const row of supplement.files) {
    const hashed = hashSourceFile(root, row.path);
    if (hashed.sha256 !== row.sha256 || hashed.length !== row.length || hashed.mode !== row.mode) {
      throw new RuntimeRetainError("failed-changed");
    }
    let listed: Stats;
    try { listed = lstatSync(joinRoot(root, row.path)); }
    catch { throw new RuntimeRetainError("failed-corrupt"); }
    if (listed.isSymbolicLink() || (listed.mode & 0o6000) !== 0) throw new RuntimeRetainError("failed-corrupt");
  }
  try { lstatSync(joinRoot(root, RUNTIME_RETAINED_MARKER_NAME)); }
  catch { throw new RuntimeRetainError("failed-corrupt"); }
  assertClosedSet(root, allowed);
  const envelope = retainedRuntimeDigest(reference.generationId, reference.manifestDigest, supplement.supplementDigest);
  if (envelope !== retainedDigest) throw new RuntimeRetainError("failed-changed");
  return manifest;
}

function expectedEnvelopeFromSource(
  selected: RuntimeGenerationReference,
  manifest: RuntimeGenerationManifest,
): { supplement: RuntimeSupplementRow[]; supplementDigest: string; retainedDigest: string } {
  verifyRuntimeGeneration(selected, true);
  const supplement = scanRuntimeSupplement(selected.installRoot, manifest);
  const supplementDigest = runtimeSupplementDigest(supplement);
  return {
    supplement,
    supplementDigest,
    retainedDigest: retainedRuntimeDigest(selected.generationId, selected.manifestDigest, supplementDigest),
  };
}

function writeBytes(path: string, bytes: string | Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    if (typeof bytes === "string") writeSync(fd, bytes);
    else writeSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, mode);
}

function ensureRetainParent(retainDir: string): void {
  if (!isAbsolute(retainDir)) throw new RuntimeRetainError("failed-permission");
  try {
    const stat = lstatSync(retainDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RuntimeRetainError("failed-permission");
  } catch (error) {
    if (error instanceof RuntimeRetainError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") mapFsError(error, "failed-permission");
    try { mkdirSync(retainDir, { recursive: true, mode: 0o700 }); }
    catch (makeError) { mapFsError(makeError, "failed-permission"); }
    try {
      const stat = lstatSync(retainDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RuntimeRetainError("failed-permission");
    } catch (checkError) { mapFsError(checkError, "failed-permission"); }
  }
}

interface StoreLockRecord {
  schemaVersion: 1;
  pid: number;
  identity?: string;
  createdAt: string;
  purpose: "retain-store";
}

function lockPath(retainDir: string): string {
  return join(retainDir, RUNTIME_RETAIN_STORE_LOCK_NAME);
}

function readLockRecord(path: string): StoreLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreLockRecord>;
    if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.pid) || parsed.purpose !== "retain-store") return undefined;
    return {
      schemaVersion: 1,
      pid: parsed.pid as number,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      purpose: "retain-store",
      ...(typeof parsed.identity === "string" ? { identity: parsed.identity } : {}),
    };
  } catch {
    return undefined;
  }
}

function lockHolderState(record: StoreLockRecord | undefined, probes: RetainIdentityProbes): "live" | "stale" | "unknown" {
  if (!record) return "unknown";
  const current = probes.identity(record.pid);
  if (record.identity && current !== undefined) return current === record.identity ? "live" : "stale";
  if (probes.alive(record.pid)) return "unknown";
  return "stale";
}

function acquireStoreLock(retainDir: string, probes: RetainIdentityProbes = defaultProbes): number {
  const path = lockPath(retainDir);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const identity = processIdentity(process.pid);
      const record: StoreLockRecord = identity === undefined
        ? { schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), purpose: "retain-store" }
        : { schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), purpose: "retain-store", identity };
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") mapFsError(error, "failed-lock");
      const existing = readLockRecord(path);
      const state = lockHolderState(existing, probes);
      if (state === "stale") {
        try { unlinkSync(path); } catch { /* raced */ }
        continue;
      }
      if (state === "unknown") throw new RuntimeRetainError("failed-lock");
      sleep(25 * (attempt + 1));
    }
  }
  throw new RuntimeRetainError("failed-lock");
}

function releaseStoreLock(retainDir: string, fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
  try { unlinkSync(lockPath(retainDir)); } catch { /* already gone */ }
}

function withStoreLock<T>(retainDir: string, fn: () => T, probes: RetainIdentityProbes = defaultProbes): T {
  const fd = acquireStoreLock(retainDir, probes);
  try { return fn(); }
  finally { releaseStoreLock(retainDir, fd); }
}

function leasesDir(retainDir: string): string {
  return join(retainDir, RUNTIME_RETAIN_LEASES_DIR_NAME);
}

function leasePath(retainDir: string, launcherLeaseId: string): string {
  if (!HEX_TOKEN.test(launcherLeaseId)) throw new RuntimeRetainError("failed-corrupt");
  return join(leasesDir(retainDir), `${launcherLeaseId}.json`);
}

function parseLease(raw: string): RuntimeGenerationLease | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeGenerationLease>;
    if (parsed.schemaVersion !== 1
      || !HEX_TOKEN.test(parsed.launcherLeaseId ?? "")
      || !HEX_TOKEN.test(parsed.launchId ?? "")
      || !HASH.test(parsed.generationId ?? "")
      || !HASH.test(parsed.retainedDigest ?? "")
      || typeof parsed.executionRoot !== "string"
      || !isAbsolute(parsed.executionRoot)
      || (parsed.state !== "binding" && parsed.state !== "bound" && parsed.state !== "restarting")
      || !Number.isInteger(parsed.launcherPid)
      || typeof parsed.launcherIdentity !== "string"
      || typeof parsed.createdAt !== "string"
      || typeof parsed.updatedAt !== "string") {
      return undefined;
    }
    return {
      schemaVersion: 1,
      launcherLeaseId: parsed.launcherLeaseId as string,
      launchId: parsed.launchId as string,
      generationId: parsed.generationId as string,
      executionRoot: parsed.executionRoot as string,
      retainedDigest: parsed.retainedDigest as string,
      state: parsed.state,
      launcherPid: parsed.launcherPid as number,
      launcherIdentity: parsed.launcherIdentity,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      ...(Number.isInteger(parsed.daemonPid) ? { daemonPid: parsed.daemonPid as number } : {}),
      ...(typeof parsed.daemonIdentity === "string" ? { daemonIdentity: parsed.daemonIdentity } : {}),
    };
  } catch {
    return undefined;
  }
}

function readLease(retainDir: string, launcherLeaseId: string): RuntimeGenerationLease | undefined {
  try { return parseLease(readFileSync(leasePath(retainDir, launcherLeaseId), "utf8")); }
  catch { return undefined; }
}

function writeLease(retainDir: string, lease: RuntimeGenerationLease): void {
  mkdirSync(leasesDir(retainDir), { recursive: true, mode: 0o700 });
  const path = leasePath(retainDir, lease.launcherLeaseId);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function sideLiveness(
  pid: number | undefined,
  recorded: string | undefined,
  probes: RetainIdentityProbes,
  required: boolean,
): "keep" | "dead" | "unknown" {
  if (pid === undefined || !recorded) return required ? "unknown" : "dead";
  const current = probes.identity(pid);
  if (current !== undefined) return current === recorded ? "keep" : "dead";
  return probes.alive(pid) ? "unknown" : "dead";
}

export function evaluateRuntimeGenerationLease(
  lease: RuntimeGenerationLease,
  probes: RetainIdentityProbes = defaultProbes,
): RetainLeaseLiveness {
  const launcher = sideLiveness(lease.launcherPid, lease.launcherIdentity, probes, true);
  const daemon = sideLiveness(lease.daemonPid, lease.daemonIdentity, probes, false);
  if (launcher === "keep" || daemon === "keep") return "protected";
  if (launcher === "unknown" || daemon === "unknown") return "unknown";
  return "reclaimable";
}

function listLeases(retainDir: string): RuntimeGenerationLease[] {
  let names: string[];
  try { names = readdirSync(leasesDir(retainDir)); }
  catch { return []; }
  const leases: RuntimeGenerationLease[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const lease = readLease(retainDir, name.slice(0, -".json".length));
    if (lease) leases.push(lease);
  }
  return leases;
}

function writeBindingLease(input: {
  retainDir: string;
  launcherLeaseId: string;
  launchId: string;
  generationId: string;
  executionRoot: string;
  retainedDigest: string;
}): void {
  const now = new Date().toISOString();
  const identity = processIdentity(process.pid);
  if (!identity) throw new RuntimeRetainError("failed-lock");
  writeLease(input.retainDir, {
    schemaVersion: 1,
    launcherLeaseId: input.launcherLeaseId,
    launchId: input.launchId,
    generationId: input.generationId,
    executionRoot: input.executionRoot,
    retainedDigest: input.retainedDigest,
    state: "binding",
    launcherPid: process.pid,
    launcherIdentity: identity,
    createdAt: now,
    updatedAt: now,
  });
}

export function acquireRuntimeGenerationLease(input: {
  retainDir: string;
  launchId: string;
  launcherLeaseId: string;
  generationId: string;
  executionRoot: string;
  retainedDigest: string;
}): void {
  ensureRetainParent(input.retainDir);
  withStoreLock(input.retainDir, () => {
    writeBindingLease(input);
  });
}

export function bindRuntimeGenerationLease(input: {
  retainDir: string;
  launchId: string;
  launcherLeaseId: string;
  pid: number;
  identity?: string;
}): void {
  withStoreLock(input.retainDir, () => {
    const lease = readLease(input.retainDir, input.launcherLeaseId);
    if (!lease) throw new RuntimeRetainError("failed-corrupt");
    const identity = input.identity ?? processIdentity(input.pid);
    if (!identity) throw new RuntimeRetainError("failed-lock");
    writeLease(input.retainDir, {
      ...lease,
      launchId: input.launchId,
      state: "bound",
      daemonPid: input.pid,
      daemonIdentity: identity,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function restartRuntimeGenerationLease(input: {
  retainDir: string;
  launcherLeaseId: string;
  launchId: string;
}): void {
  withStoreLock(input.retainDir, () => {
    const lease = readLease(input.retainDir, input.launcherLeaseId);
    if (!lease) throw new RuntimeRetainError("failed-corrupt");
    const next: RuntimeGenerationLease = {
      schemaVersion: 1,
      launcherLeaseId: lease.launcherLeaseId,
      launchId: input.launchId,
      generationId: lease.generationId,
      executionRoot: lease.executionRoot,
      retainedDigest: lease.retainedDigest,
      state: "restarting",
      launcherPid: lease.launcherPid,
      launcherIdentity: lease.launcherIdentity,
      createdAt: lease.createdAt,
      updatedAt: new Date().toISOString(),
    };
    writeLease(input.retainDir, next);
  });
}

export function releaseRuntimeGenerationLease(input: { retainDir: string; launcherLeaseId: string }): void {
  withStoreLock(input.retainDir, () => {
    try { unlinkSync(leasePath(input.retainDir, input.launcherLeaseId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") mapFsError(error, "failed-permission");
    }
  });
}

interface StagingMarker {
  schemaVersion: 1;
  launchId: string;
  generationId: string;
  launcherPid: number;
  launcherIdentity: string;
}

function readStagingMarker(dir: string): StagingMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RUNTIME_RETAIN_STAGING_MARKER_NAME), "utf8")) as Partial<StagingMarker>;
    if (parsed.schemaVersion !== 1
      || !HEX_TOKEN.test(parsed.launchId ?? "")
      || !HASH.test(parsed.generationId ?? "")
      || !Number.isInteger(parsed.launcherPid)
      || typeof parsed.launcherIdentity !== "string") return undefined;
    return parsed as StagingMarker;
  } catch {
    return undefined;
  }
}

function executionRootOf(retainDir: string, generationId: string): string {
  if (!HASH.test(generationId)) throw new RuntimeRetainError("failed-corrupt");
  return join(retainDir, generationId);
}

function stagingDirOf(retainDir: string, generationId: string, launchId: string): string {
  if (!HASH.test(generationId) || !HEX_TOKEN.test(launchId)) throw new RuntimeRetainError("failed-corrupt");
  return join(retainDir, `.staging-${generationId}-${launchId}`);
}

export function sweepRuntimeGenerations(input: {
  retainDir: string;
  keepExecutionRoot?: string;
  probes?: RetainIdentityProbes;
}): void {
  const probes = input.probes ?? defaultProbes;
  ensureRetainParent(input.retainDir);
  withStoreLock(input.retainDir, () => {
    const leases = listLeases(input.retainDir);
    const protectedRoots = new Set<string>();
    if (input.keepExecutionRoot) protectedRoots.add(input.keepExecutionRoot);
    for (const lease of leases) {
      const liveness = evaluateRuntimeGenerationLease(lease, probes);
      if (liveness === "reclaimable") {
        try { unlinkSync(leasePath(input.retainDir, lease.launcherLeaseId)); }
        catch { /* already gone */ }
        continue;
      }
      protectedRoots.add(lease.executionRoot);
    }
    let names: string[];
    try { names = readdirSync(input.retainDir); }
    catch { return; }
    for (const name of names) {
      if (name === RUNTIME_RETAIN_LEASES_DIR_NAME || name === RUNTIME_RETAIN_STORE_LOCK_NAME) continue;
      const absolute = join(input.retainDir, name);
      let stat: Stats;
      try { stat = lstatSync(absolute); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (HASH.test(name)) {
        if (protectedRoots.has(absolute)) continue;
        const stillProtected = listLeases(input.retainDir).some((lease) => (
          lease.executionRoot === absolute && evaluateRuntimeGenerationLease(lease, probes) !== "reclaimable"
        ));
        if (stillProtected) continue;
        rmSync(absolute, { recursive: true, force: true });
        continue;
      }
      const staging = name.match(/^\.staging-([0-9a-f]{64})-([0-9a-f]+)$/);
      if (!staging) continue;
      const marker = readStagingMarker(absolute);
      if (!marker) continue;
      const lease = leases.find((row) => row.launchId === marker.launchId);
      if (lease && evaluateRuntimeGenerationLease(lease, probes) !== "reclaimable") continue;
      const launcher = sideLiveness(marker.launcherPid, marker.launcherIdentity, probes, true);
      if (launcher === "keep" || launcher === "unknown") continue;
      rmSync(absolute, { recursive: true, force: true });
    }
  }, probes);
}

function completeTree(root: string): boolean {
  try {
    lstatSync(join(root, RUNTIME_MANIFEST_NAME));
    lstatSync(join(root, RUNTIME_SUPPLEMENT_NAME));
    lstatSync(join(root, RUNTIME_RETAINED_MARKER_NAME));
    return true;
  } catch {
    return false;
  }
}

function reuseExisting(
  retainDir: string,
  selected: RuntimeGenerationReference,
  manifest: RuntimeGenerationManifest,
  executionRoot: string,
  expectedRetainedDigest: string | undefined,
  launcherLeaseId: string | undefined,
  launchId: string,
): RetainRuntimeGenerationResult {
  let retainedDigest: string;
  let supplementDigest: string;
  try {
    verifyRuntimeGeneration(selected, true);
    const expected = expectedEnvelopeFromSource(selected, manifest);
    retainedDigest = expected.retainedDigest;
    supplementDigest = expected.supplementDigest;
  } catch (error) {
    if (!expectedRetainedDigest) {
      if (error instanceof RuntimeGenerationError && error.reason === "update") {
        throw new RuntimeRetainError("failed-changed");
      }
      throw error instanceof RuntimeRetainError ? error : new RuntimeRetainError("failed-changed");
    }
    retainedDigest = expectedRetainedDigest;
    const supplement = parseSupplement(readFileSync(join(executionRoot, RUNTIME_SUPPLEMENT_NAME), "utf8"));
    supplementDigest = supplement.supplementDigest;
  }
  verifyRetainedRuntimeGeneration({
    generationId: selected.generationId,
    installRoot: executionRoot,
    manifestDigest: selected.manifestDigest,
  }, retainedDigest);
  const reference: RuntimeGenerationReference = {
    generationId: selected.generationId,
    installRoot: executionRoot,
    manifestDigest: selected.manifestDigest,
  };
  if (launcherLeaseId) {
    withStoreLock(retainDir, () => {
      writeBindingLease({
        retainDir,
        launcherLeaseId,
        launchId,
        generationId: selected.generationId,
        executionRoot,
        retainedDigest,
      });
    });
  }
  return { reference, retainedDigest, supplementDigest };
}

function materialize(
  input: RetainRuntimeGenerationInput,
  retainDir: string,
  executionRoot: string,
): RetainRuntimeGenerationResult {
  const staging = stagingDirOf(retainDir, input.selected.generationId, input.launchId);
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const identity = processIdentity(process.pid);
  writeBytes(join(staging, RUNTIME_RETAIN_STAGING_MARKER_NAME), `${JSON.stringify({
    schemaVersion: 1,
    launchId: input.launchId,
    generationId: input.selected.generationId,
    launcherPid: process.pid,
    launcherIdentity: identity ?? "",
  } satisfies StagingMarker)}\n`, 0o600);

  const inventory = input.manifest.inventory;
  const totalFiles = inventory.length;
  const totalBytes = inventory.reduce((sum, row) => sum + row.length, 0);
  let copiedFiles = 0;
  let copiedBytes = 0;
  input.onProgress?.({ phase: "copying", copiedBytes, totalBytes, copiedFiles, totalFiles });
  for (const row of inventory) {
    copyRelativeFile(input.selected.installRoot, staging, row.path, { sha256: row.sha256, length: row.length }, input.onBoundary);
    copiedFiles += 1;
    copiedBytes += row.length;
    input.onProgress?.({ phase: "copying", copiedBytes, totalBytes, copiedFiles, totalFiles });
  }

  const sourceSupplement = scanRuntimeSupplement(input.selected.installRoot, input.manifest);
  const writtenSupplement: RuntimeSupplementRow[] = [];
  for (const row of sourceSupplement) {
    const copied = copyRelativeFile(
      input.selected.installRoot,
      staging,
      row.path,
      { sha256: row.sha256, length: row.length },
      input.onBoundary,
    );
    writtenSupplement.push({ path: row.path, length: copied.length, sha256: copied.sha256, mode: copied.mode });
  }

  input.onBoundary?.("before-recheck", input.selected.installRoot);
  try { verifyRuntimeGeneration(input.selected, true); }
  catch (error) {
    rmSync(staging, { recursive: true, force: true });
    mapFsError(error, "failed-changed");
  }
  const rechecked = scanRuntimeSupplement(input.selected.installRoot, input.manifest);
  const recheckedDigest = runtimeSupplementDigest(rechecked);
  const writtenDigest = runtimeSupplementDigest(writtenSupplement);
  if (recheckedDigest !== writtenDigest) {
    rmSync(staging, { recursive: true, force: true });
    throw new RuntimeRetainError("failed-changed");
  }

  const manifestBytes = readFileSync(join(input.selected.installRoot, RUNTIME_MANIFEST_NAME));
  if (runtimeManifestDigest(manifestBytes) !== input.selected.manifestDigest) {
    rmSync(staging, { recursive: true, force: true });
    throw new RuntimeRetainError("failed-changed");
  }
  writeBytes(join(staging, RUNTIME_MANIFEST_NAME), manifestBytes, 0o644);
  const supplementManifest: RuntimeSupplementManifest = {
    schemaVersion: 1,
    generationId: input.selected.generationId,
    manifestDigest: input.selected.manifestDigest,
    supplementDigest: writtenDigest,
    files: writtenSupplement,
  };
  writeBytes(join(staging, RUNTIME_SUPPLEMENT_NAME), `${JSON.stringify(supplementManifest, null, 2)}\n`, 0o644);
  writeBytes(join(staging, RUNTIME_RETAINED_MARKER_NAME), "RETAINED\n", 0o644);
  fsyncDirectory(staging);

  const retainedDigest = retainedRuntimeDigest(
    input.selected.generationId,
    input.selected.manifestDigest,
    writtenDigest,
  );
  input.onBoundary?.("before-publish", staging);
  input.onProgress?.({ phase: "verifying", copiedBytes, totalBytes, copiedFiles, totalFiles });

  try {
    withStoreLock(retainDir, () => {
      if (completeTree(executionRoot)) {
        rmSync(staging, { recursive: true, force: true });
        return;
      }
      renameSync(staging, executionRoot);
      fsyncDirectory(retainDir);
      if (input.launcherLeaseId) {
        writeBindingLease({
          retainDir,
          launcherLeaseId: input.launcherLeaseId,
          launchId: input.launchId,
          generationId: input.selected.generationId,
          executionRoot,
          retainedDigest,
        });
      }
    });
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { if (!completeTree(executionRoot)) rmSync(executionRoot, { recursive: true, force: true }); }
    catch { /* best-effort */ }
    mapFsError(error, "failed-lock");
  }

  const reference: RuntimeGenerationReference = {
    generationId: input.selected.generationId,
    installRoot: executionRoot,
    manifestDigest: input.selected.manifestDigest,
  };
  try {
    verifyRetainedRuntimeGeneration(reference, retainedDigest);
  } catch (error) {
    try { rmSync(executionRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error instanceof RuntimeRetainError ? error : new RuntimeRetainError("failed-corrupt");
  }
  input.onProgress?.({ phase: "ready", copiedBytes, totalBytes, copiedFiles, totalFiles });
  return { reference, retainedDigest, supplementDigest: writtenDigest };
}

export function retainRuntimeGeneration(input: RetainRuntimeGenerationInput): RetainRuntimeGenerationResult {
  if (!HEX_TOKEN.test(input.launchId)) throw new RuntimeRetainError("failed-corrupt");
  if (input.launcherLeaseId && !HEX_TOKEN.test(input.launcherLeaseId)) throw new RuntimeRetainError("failed-corrupt");
  if (input.expectedRetainedDigest && !HASH.test(input.expectedRetainedDigest)) throw new RuntimeRetainError("failed-corrupt");
  ensureRetainParent(input.retainDir);
  const executionRoot = executionRootOf(input.retainDir, input.selected.generationId);
  if (completeTree(executionRoot)) {
    try {
      return reuseExisting(
        input.retainDir,
        input.selected,
        input.manifest,
        executionRoot,
        input.expectedRetainedDigest,
        input.launcherLeaseId,
        input.launchId,
      );
    } catch (error) {
      if (!input.expectedRetainedDigest) throw error instanceof RuntimeRetainError ? error : new RuntimeRetainError("failed-changed");
      throw error instanceof RuntimeRetainError ? error : new RuntimeRetainError("failed-corrupt");
    }
  }
  try {
    verifyRuntimeGeneration(input.selected, true);
  } catch (error) {
    mapFsError(error, "failed-changed");
  }
  return materialize(input, input.retainDir, executionRoot);
}

function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT", "COMSPEC"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function probeRetainedExecution(nodeBinary: string): void {
  const result = spawnSync(nodeBinary, ["-e", "process.exit(0)"], {
    timeout: 10_000,
    env: probeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new RuntimeRetainError("failed-exec");
}

export function retainStoreLockPath(retainDir: string): string {
  return lockPath(retainDir);
}
