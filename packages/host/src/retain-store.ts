/**
 * Retain-parent store: exclusive lock, leases, sweep, and the locked
 * adopt-or-publish critical section. Copy/scan primitives live in retain-copy.ts.
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isProcessAlive, processIdentity } from "./process-identity.js";
import { RUNTIME_MANIFEST_NAME } from "./runtime-generation.js";
import {
  HASH,
  HEX_TOKEN,
  RUNTIME_RETAINED_MARKER_NAME,
  RUNTIME_RETAIN_STAGING_MARKER_NAME,
  RUNTIME_SUPPLEMENT_NAME,
  RuntimeRetainError,
  fsyncDirectory,
  mapFsError,
  writeBytes,
} from "./retain-copy.js";

export const RUNTIME_RETAIN_STORE_LOCK_NAME = ".store.lock";
export const RUNTIME_RETAIN_LEASES_DIR_NAME = "leases";

const LOCK_ATTEMPTS = 8;
const STAGING_ORPHAN_MS = 60_000;

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

export type RetainLeaseLiveness = "protected" | "reclaimable" | "unknown";

export interface RetainIdentityProbes {
  identity: (pid: number) => string | undefined;
  alive: (pid: number) => boolean;
}

const defaultProbes: RetainIdentityProbes = { identity: processIdentity, alive: isProcessAlive };

/**
 * Launcher, bind, and stop-path pause only. Must never be reached from a
 * thread serving live work — the worker's only thread carries every session
 * stream (see packages/worker/src/keybindings.ts).
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ensureRetainParent(retainDir: string): void {
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

export function executionRootOf(retainDir: string, generationId: string): string {
  if (!HASH.test(generationId)) throw new RuntimeRetainError("failed-corrupt");
  return join(retainDir, generationId);
}

export function stagingDirOf(retainDir: string, generationId: string, launchId: string): string {
  if (!HASH.test(generationId) || !HEX_TOKEN.test(launchId)) throw new RuntimeRetainError("failed-corrupt");
  return join(retainDir, `.staging-${generationId}-${launchId}`);
}

export function writeStagingMarker(dir: string, marker: StagingMarker): void {
  writeBytes(join(dir, RUNTIME_RETAIN_STAGING_MARKER_NAME), `${JSON.stringify(marker)}\n`, 0o600);
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
    const now = Date.now();
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
      if (protectedRoots.has(absolute)) continue;
      const marker = readStagingMarker(absolute);
      if (!marker) {
        if (now - stat.mtimeMs < STAGING_ORPHAN_MS) continue;
        rmSync(absolute, { recursive: true, force: true });
        continue;
      }
      const lease = leases.find((row) => row.launchId === marker.launchId);
      if (lease && evaluateRuntimeGenerationLease(lease, probes) !== "reclaimable") continue;
      const launcher = sideLiveness(marker.launcherPid, marker.launcherIdentity, probes, true);
      if (launcher === "keep" || launcher === "unknown") continue;
      rmSync(absolute, { recursive: true, force: true });
    }
  }, probes);
}

export function completeTree(root: string): boolean {
  try {
    lstatSync(join(root, RUNTIME_MANIFEST_NAME));
    lstatSync(join(root, RUNTIME_SUPPLEMENT_NAME));
    lstatSync(join(root, RUNTIME_RETAINED_MARKER_NAME));
    return true;
  } catch {
    return false;
  }
}

export function adoptOrPublish(input: {
  retainDir: string;
  executionRoot: string;
  staging?: string | undefined;
  generationId: string;
  launchId: string;
  launcherLeaseId?: string | undefined;
  retainedDigest: string;
  verify: () => void;
}): void {
  withStoreLock(input.retainDir, () => {
    let published = false;
    if (completeTree(input.executionRoot)) {
      if (input.staging) {
        try { rmSync(input.staging, { recursive: true, force: true }); } catch { /* this process's staging */ }
      }
    } else if (!input.staging) {
      throw new RuntimeRetainError("failed-corrupt");
    } else {
      try {
        renameSync(input.staging, input.executionRoot);
        fsyncDirectory(input.retainDir);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && completeTree(input.executionRoot)) {
          try { rmSync(input.staging, { recursive: true, force: true }); } catch { /* this process's staging */ }
        } else {
          mapFsError(error, "failed-lock");
        }
      }
    }
    try {
      input.verify();
    } catch (error) {
      if (published) {
        try { rmSync(input.executionRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      throw error instanceof RuntimeRetainError ? error : new RuntimeRetainError("failed-corrupt");
    }
    if (input.launcherLeaseId) {
      writeBindingLease({
        retainDir: input.retainDir,
        launcherLeaseId: input.launcherLeaseId,
        launchId: input.launchId,
        generationId: input.generationId,
        executionRoot: input.executionRoot,
        retainedDigest: input.retainedDigest,
      });
    }
  });
}

export function retainStoreLockPath(retainDir: string): string {
  return lockPath(retainDir);
}
