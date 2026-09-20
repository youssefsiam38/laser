/**
 * Launch-bound retained generation tree T: a digest-checked copy of a verified
 * package root's executable inventory plus a canonical supplementary inventory
 * of the unpacked and runtime trees. Pointer identity stays on the package
 * root; this module never writes runtime-generation.json.
 *
 * Copy/scan primitives: retain-copy.ts. Store lock, leases, sweep, and the
 * locked adopt-or-publish critical section: retain-store.ts.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DATA_DIR_NAME } from "@lasercode/protocol";
import { processIdentity } from "./process-identity.js";
import {
  HASH,
  HEX_TOKEN,
  RUNTIME_RETAIN_DIR_NAME,
  RUNTIME_RETAINED_MARKER_NAME,
  RUNTIME_SUPPLEMENT_NAME,
  RuntimeRetainError,
  assertClosedSet,
  copyRelativeFile,
  hashSourceFile,
  joinRoot,
  mapFsError,
  parseSupplement,
  retainedRuntimeDigest,
  runtimeSupplementDigest,
  scanRuntimeSupplement,
  writeBytes,
  fsyncDirectory,
  type RetainCopyBoundary,
  type RetainProgress,
  type RuntimeSupplementManifest,
  type RuntimeSupplementRow,
} from "./retain-copy.js";
import {
  adoptOrPublish,
  completeTree,
  ensureRetainParent,
  executionRootOf,
  stagingDirOf,
  writeStagingMarker,
} from "./retain-store.js";
import {
  RUNTIME_MANIFEST_NAME,
  RuntimeGenerationError,
  runtimeManifestDigest,
  verifyRuntimeGeneration,
  type RuntimeGenerationManifest,
  type RuntimeGenerationReference,
} from "./runtime-generation.js";

export {
  HASH,
  HEX_TOKEN,
  RUNTIME_RETAIN_DIR_NAME,
  RUNTIME_RETAINED_MARKER_NAME,
  RUNTIME_RETAIN_STAGING_MARKER_NAME,
  RUNTIME_SUPPLEMENT_NAME,
  RuntimeRetainError,
  retainedRuntimeDigest,
  runtimeSupplementDigest,
  sanitizedRetainFileMode,
  scanRuntimeSupplement,
  type RetainCopyBoundary,
  type RetainProgress,
  type RuntimeRetainErrorReason,
  type RuntimeSupplementManifest,
  type RuntimeSupplementRow,
} from "./retain-copy.js";
export {
  RUNTIME_RETAIN_LEASES_DIR_NAME,
  RUNTIME_RETAIN_STORE_LOCK_NAME,
  acquireRuntimeGenerationLease,
  bindRuntimeGenerationLease,
  evaluateRuntimeGenerationLease,
  releaseRuntimeGenerationLease,
  restartRuntimeGenerationLease,
  retainStoreLockPath,
  sweepRuntimeGenerations,
  type RetainIdentityProbes,
  type RetainLeaseLiveness,
  type RuntimeGenerationLease,
  type RuntimeGenerationLeaseState,
} from "./retain-store.js";

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

function adoptVerified(input: {
  retainDir: string;
  executionRoot: string;
  staging?: string | undefined;
  selected: RuntimeGenerationReference;
  launchId: string;
  launcherLeaseId?: string | undefined;
  retainedDigest: string;
  supplementDigest: string;
}): RetainRuntimeGenerationResult {
  const reference: RuntimeGenerationReference = {
    generationId: input.selected.generationId,
    installRoot: input.executionRoot,
    manifestDigest: input.selected.manifestDigest,
  };
  adoptOrPublish({
    retainDir: input.retainDir,
    executionRoot: input.executionRoot,
    staging: input.staging,
    generationId: input.selected.generationId,
    launchId: input.launchId,
    launcherLeaseId: input.launcherLeaseId,
    retainedDigest: input.retainedDigest,
    verify: () => { verifyRetainedRuntimeGeneration(reference, input.retainedDigest); },
  });
  return { reference, retainedDigest: input.retainedDigest, supplementDigest: input.supplementDigest };
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
  return adoptVerified({
    retainDir,
    executionRoot,
    selected,
    launchId,
    launcherLeaseId,
    retainedDigest,
    supplementDigest,
  });
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
  writeStagingMarker(staging, {
    schemaVersion: 1,
    launchId: input.launchId,
    generationId: input.selected.generationId,
    launcherPid: process.pid,
    launcherIdentity: identity ?? "",
  });

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
    const result = adoptVerified({
      retainDir,
      executionRoot,
      staging,
      selected: input.selected,
      launchId: input.launchId,
      launcherLeaseId: input.launcherLeaseId,
      retainedDigest,
      supplementDigest: writtenDigest,
    });
    input.onProgress?.({ phase: "ready", copiedBytes, totalBytes, copiedFiles, totalFiles });
    return result;
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    mapFsError(error, "failed-lock");
  }
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
