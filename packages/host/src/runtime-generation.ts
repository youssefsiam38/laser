import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ENV, type FeatureId, type WorkerMode } from "@lasercode/protocol";

// Electron's patched fs presents `app.asar` as a directory, so an inventory
// that lists the archive as a file always reads as drift. Verify raw bytes.
const fs: typeof nodeFs = process.versions.electron
  ? createRequire(import.meta.url)("original-fs") as typeof nodeFs
  : nodeFs;
const {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = fs;

export const RUNTIME_MANIFEST_NAME = "runtime-manifest.json";
export const RUNTIME_POINTER_NAME = "runtime-generation.json";
export const RUNTIME_GENERATION_ERROR = "The app's runtime files changed after they were installed. Reinstall the app before starting it.";
export const RUNTIME_UPDATE_INSTALLED_ERROR = "An update was installed. Restart the app and its host to use it.";
export const RUNTIME_MANIFEST_ERROR = "The app's runtime inventory is missing or damaged. Reinstall the app before starting it.";

export interface RuntimeInventoryRow {
  path: string;
  length: number;
  sha256: string;
  /** Build-time verification metadata; excluded from the generation id. */
  mtimeMs: number;
}

export interface RuntimeGenerationManifest {
  schemaVersion: 1;
  generationId: string;
  productVersion: string;
  buildIdentity: string;
  inventory: RuntimeInventoryRow[];
  entries: {
    cli: string;
    worker: string;
    node?: string;
    app?: string;
  };
}

export interface RuntimeGenerationReference {
  generationId: string;
  installRoot: string;
  manifestDigest: string;
}

export interface RuntimeFileVerification {
  length: number;
  mtimeMs: number;
  ino: number;
}

export interface RuntimeGenerationVerification {
  verifiedAt: string;
  rows: Record<string, RuntimeFileVerification>;
  /** Bundled Node is expensive and is hashed once per unchanged generation. */
  node?: RuntimeFileVerification;
}

export interface RuntimeGenerationSelection extends RuntimeGenerationReference {
  verification?: RuntimeGenerationVerification;
}

export interface RuntimeGenerationPointer {
  schemaVersion: 1;
  active: RuntimeGenerationSelection;
  /** History only: fixed-root installers do not retain the previous bytes. */
  previousGenerationId?: string;
  pending?: RuntimeGenerationSelection;
}

export interface FeatureGenerationManifest {
  schemaVersion: 1;
  featureGenerationId: string;
  runtimeGenerationId: string;
  cwdDigest: string;
  /** Revision of the `features` preference namespace, not the global prefs revision. */
  desiredPrefsRevision: number;
  effectiveFeatures: FeatureId[];
  mode: WorkerMode;
}

export type RuntimeGenerationErrorReason = "missing" | "corrupt" | "drift" | "update" | "pointer";

export class RuntimeGenerationError extends Error {
  override readonly name = "RuntimeGenerationError";
  constructor(readonly reason: RuntimeGenerationErrorReason) {
    super(reason === "drift"
      ? RUNTIME_GENERATION_ERROR
      : reason === "update"
        ? RUNTIME_UPDATE_INSTALLED_ERROR
        : reason === "missing" || reason === "corrupt"
          ? RUNTIME_MANIFEST_ERROR
          : "The app could not select its verified runtime. Restart the app and try again.");
  }
}

const HASH = /^[0-9a-f]{64}$/;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const posix = (value: string): string => value.split(sep).join("/");

function canonicalInventory(rows: readonly Pick<RuntimeInventoryRow, "path" | "length" | "sha256">[]): string {
  return [...rows]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((row) => `${row.path}\0${row.length}\0${row.sha256}\n`)
    .join("");
}

export function runtimeGenerationId(rows: readonly Pick<RuntimeInventoryRow, "path" | "length" | "sha256">[]): string {
  return sha256(canonicalInventory(rows));
}

export function runtimeManifestDigest(bytes: string | Buffer): string {
  return sha256(bytes);
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && !isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function fileDigest(path: string): string {
  return sha256(readFileSync(path));
}

function rowFor(installRoot: string, absolute: string): RuntimeInventoryRow {
  const path = realpathSync(absolute);
  const rel = posix(relative(realpathSync(installRoot), path));
  if (!safeRelativePath(rel) || rel.startsWith("../")) throw new Error(`runtime inventory path escapes its install root: ${absolute}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`runtime inventory entry is not a file: ${absolute}`);
  return { path: rel, length: stat.size, sha256: fileDigest(path), mtimeMs: stat.mtimeMs };
}

/** Build-time writer. `files` is the already-resolved executable closure. */
export function writeRuntimeGenerationManifest(input: {
  installRoot: string;
  files: readonly string[];
  entries: RuntimeGenerationManifest["entries"];
  productVersion: string;
  buildIdentity: string;
  output?: string;
}): { manifest: RuntimeGenerationManifest; manifestDigest: string; path: string } {
  const installRoot = realpathSync(input.installRoot);
  const rows = [...new Set(input.files.map((file) => realpathSync(file)))]
    .map((file) => rowFor(installRoot, file))
    .sort((left, right) => left.path.localeCompare(right.path));
  const entries = Object.fromEntries(Object.entries(input.entries).map(([name, path]) => {
    const absolute = realpathSync(resolve(installRoot, path));
    const rel = posix(relative(installRoot, absolute));
    if (!rows.some((row) => row.path === rel)) throw new Error(`runtime entry ${name} is not in the executable inventory: ${rel}`);
    return [name, rel];
  })) as RuntimeGenerationManifest["entries"];
  const manifest: RuntimeGenerationManifest = {
    schemaVersion: 1,
    generationId: runtimeGenerationId(rows),
    productVersion: input.productVersion,
    buildIdentity: input.buildIdentity,
    inventory: rows,
    entries,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = input.output ?? join(installRoot, RUNTIME_MANIFEST_NAME);
  atomicWrite(path, text, 0o644);
  return { manifest, manifestDigest: runtimeManifestDigest(text), path };
}

function parseManifest(raw: string): RuntimeGenerationManifest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RuntimeGenerationError("corrupt"); }
  const manifest = value as Partial<RuntimeGenerationManifest>;
  if (manifest.schemaVersion !== 1
    || !HASH.test(manifest.generationId ?? "")
    || typeof manifest.productVersion !== "string"
    || typeof manifest.buildIdentity !== "string"
    || !Array.isArray(manifest.inventory)
    || !manifest.entries
    || typeof manifest.entries !== "object") throw new RuntimeGenerationError("corrupt");
  const seen = new Set<string>();
  for (const row of manifest.inventory) {
    if (!safeRelativePath(row?.path)
      || seen.has(row.path)
      || !Number.isSafeInteger(row.length)
      || row.length < 0
      || !HASH.test(row.sha256)
      || typeof row.mtimeMs !== "number"
      || !Number.isFinite(row.mtimeMs)) throw new RuntimeGenerationError("corrupt");
    seen.add(row.path);
  }
  if (runtimeGenerationId(manifest.inventory) !== manifest.generationId) throw new RuntimeGenerationError("corrupt");
  for (const [name, path] of Object.entries(manifest.entries)) {
    if (!["cli", "worker", "node", "app"].includes(name) || !safeRelativePath(path) || !seen.has(path)) {
      throw new RuntimeGenerationError("corrupt");
    }
  }
  if (!safeRelativePath(manifest.entries.cli) || !safeRelativePath(manifest.entries.worker)) throw new RuntimeGenerationError("corrupt");
  return manifest as RuntimeGenerationManifest;
}

export function runtimeReferenceFromManifest(manifestPath: string): RuntimeGenerationReference {
  const raw = readFileSync(manifestPath);
  const manifest = parseManifest(raw.toString("utf8"));
  return {
    generationId: manifest.generationId,
    installRoot: realpathSync(dirname(manifestPath)),
    manifestDigest: runtimeManifestDigest(raw),
  };
}

export function findRuntimeManifest(start: string): string {
  let directory: string;
  try { directory = lstatSync(start).isDirectory() ? realpathSync(start) : dirname(realpathSync(start)); }
  catch { directory = dirname(resolve(start)); }
  for (;;) {
    const candidate = join(directory, RUNTIME_MANIFEST_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new RuntimeGenerationError("missing");
    directory = parent;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface RuntimeVerificationMetrics {
  generationId: string;
  hashedFiles: number;
  hashedBytes: number;
  full: boolean;
  durationMs: number;
}

const verificationCache = new Map<string, RuntimeGenerationVerification>();
let latestVerificationMetrics: RuntimeVerificationMetrics | undefined;

export function runtimeVerificationMetrics(): RuntimeVerificationMetrics | undefined {
  return latestVerificationMetrics && { ...latestVerificationMetrics };
}

const verificationKey = (reference: RuntimeGenerationReference): string =>
  `${reference.installRoot}\0${reference.generationId}\0${reference.manifestDigest}`;

function fileVerification(stat: NonNullable<ReturnType<typeof lstatSync>>): RuntimeFileVerification {
  return { length: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ino: Number(stat.ino) };
}

function sameVerification(left: RuntimeFileVerification | undefined, right: RuntimeFileVerification): boolean {
  return !!left && left.length === right.length && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

function verifyRuntimeGenerationDetailed(
  reference: RuntimeGenerationReference,
  full = false,
  persisted?: RuntimeGenerationVerification,
): { manifest: RuntimeGenerationManifest; verification: RuntimeGenerationVerification } {
  const started = performance.now();
  if (!HASH.test(reference.generationId) || !HASH.test(reference.manifestDigest) || !isAbsolute(reference.installRoot)) {
    throw new RuntimeGenerationError("pointer");
  }
  let root: string;
  let raw: Buffer;
  try {
    root = realpathSync(reference.installRoot);
    raw = readFileSync(join(root, RUNTIME_MANIFEST_NAME));
  } catch {
    throw new RuntimeGenerationError("missing");
  }
  const manifest = parseManifest(raw.toString("utf8"));
  if (runtimeManifestDigest(raw) !== reference.manifestDigest || manifest.generationId !== reference.generationId) {
    throw new RuntimeGenerationError("update");
  }

  const key = verificationKey(reference);
  const baseline = verificationCache.get(key) ?? persisted;
  const effectiveFull = full || !baseline;
  const nodePath = manifest.entries.node;
  const entryPaths = new Set(Object.values(manifest.entries).filter((path) => path !== nodePath));
  const currentRows: Record<string, RuntimeFileVerification> = {};
  const rowsToHash = new Map<string, RuntimeInventoryRow>();
  let invalidFile = false;
  for (const row of manifest.inventory) {
    const absolute = resolve(root, row.path);
    if (!inside(root, absolute)) throw new RuntimeGenerationError("corrupt");
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        invalidFile = true;
        rowsToHash.set(row.path, row);
        continue;
      }
      const current = fileVerification(stat);
      currentRows[row.path] = current;
      const previous = baseline?.rows[row.path] ?? { length: row.length, mtimeMs: row.mtimeMs, ino: current.ino };
      if (effectiveFull || entryPaths.has(row.path) || !sameVerification(previous, current)) rowsToHash.set(row.path, row);
      if (row.path === nodePath && !sameVerification(baseline?.node, current)) rowsToHash.set(row.path, row);
    } catch {
      invalidFile = true;
      rowsToHash.set(row.path, row);
    }
  }

  let digestMismatch = invalidFile;
  let hashedBytes = 0;
  for (const row of rowsToHash.values()) {
    hashedBytes += row.length;
    try {
      const absolute = resolve(root, row.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.length || fileDigest(absolute) !== row.sha256) digestMismatch = true;
    } catch { digestMismatch = true; }
  }
  if (digestMismatch) {
    if (!effectiveFull) return verifyRuntimeGenerationDetailed(reference, true);
    throw new RuntimeGenerationError("drift");
  }

  const verification: RuntimeGenerationVerification = {
    verifiedAt: new Date().toISOString(),
    rows: currentRows,
    ...(nodePath && currentRows[nodePath] ? { node: currentRows[nodePath] } : {}),
  };
  verificationCache.set(key, verification);
  latestVerificationMetrics = {
    generationId: manifest.generationId,
    hashedFiles: rowsToHash.size,
    hashedBytes,
    full: effectiveFull,
    durationMs: performance.now() - started,
  };
  return { manifest, verification };
}

/** Verify files against the manifest shipped in their own install root. */
export function verifyRuntimeGeneration(
  reference: RuntimeGenerationReference,
  full = false,
  persisted?: RuntimeGenerationVerification,
): RuntimeGenerationManifest {
  return verifyRuntimeGenerationDetailed(reference, full, persisted).manifest;
}

function validReference(value: unknown): value is RuntimeGenerationReference {
  const row = value as Partial<RuntimeGenerationReference> | undefined;
  return !!row && HASH.test(row.generationId ?? "") && HASH.test(row.manifestDigest ?? "")
    && typeof row.installRoot === "string" && isAbsolute(row.installRoot);
}

/** Exact launcher binding carried only in the local process environment. */
export function runtimeReferenceFromEnvironment(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>): RuntimeGenerationReference | undefined {
  const values = [env[ENV.runtimeGenerationId], env[ENV.runtimeInstallRoot], env[ENV.runtimeManifestDigest]];
  if (values.every((value) => value === undefined)) return undefined;
  const reference = {
    generationId: values[0],
    installRoot: values[1],
    manifestDigest: values[2],
  };
  if (!validReference(reference)) throw new RuntimeGenerationError("pointer");
  return reference;
}

function validFileVerification(value: unknown): value is RuntimeFileVerification {
  const row = value as Partial<RuntimeFileVerification> | undefined;
  const length = row?.length;
  const mtimeMs = row?.mtimeMs;
  const ino = row?.ino;
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
    && typeof mtimeMs === "number" && Number.isFinite(mtimeMs)
    && typeof ino === "number" && Number.isSafeInteger(ino) && ino >= 0;
}

function validVerification(value: unknown): value is RuntimeGenerationVerification {
  const verification = value as Partial<RuntimeGenerationVerification> | undefined;
  if (!verification || typeof verification.verifiedAt !== "string" || !Number.isFinite(Date.parse(verification.verifiedAt))
    || !verification.rows || typeof verification.rows !== "object") return false;
  if (!Object.entries(verification.rows).every(([path, row]) => safeRelativePath(path) && validFileVerification(row))) return false;
  return verification.node === undefined || validFileVerification(verification.node);
}

function validSelection(value: unknown): value is RuntimeGenerationSelection {
  const selection = value as Partial<RuntimeGenerationSelection> | undefined;
  return validReference(value) && (selection?.verification === undefined || validVerification(selection.verification));
}

export function readRuntimeGenerationPointer(stateDir: string): RuntimeGenerationPointer | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, RUNTIME_POINTER_NAME), "utf8")) as Partial<RuntimeGenerationPointer>;
    if (parsed.schemaVersion !== 1 || !validSelection(parsed.active)
      || (parsed.previousGenerationId !== undefined && !HASH.test(parsed.previousGenerationId))
      || (parsed.pending !== undefined && !validSelection(parsed.pending))) return undefined;
    return parsed as RuntimeGenerationPointer;
  } catch {
    // The pointer is selection history, never authority over the install. A
    // complete self-consistent install rebuilds it on the next launch.
    return undefined;
  }
}

export function writeRuntimeGenerationPointer(stateDir: string, pointer: RuntimeGenerationPointer): void {
  atomicWrite(join(stateDir, RUNTIME_POINTER_NAME), `${JSON.stringify(pointer, null, 2)}\n`, 0o600);
}

/** Verify the install-root manifest and retain it as pending without activating it. */
export function stageRuntimeGeneration(stateDir: string, currentEntry: string): {
  pointer: RuntimeGenerationPointer;
  current: RuntimeGenerationReference;
  manifest: RuntimeGenerationManifest;
} {
  const current = runtimeReferenceFromManifest(findRuntimeManifest(currentEntry));
  let pointer = readRuntimeGenerationPointer(stateDir);
  const retained = pointer?.active.generationId === current.generationId
    ? pointer.active.verification
    : pointer?.pending?.generationId === current.generationId
      ? pointer.pending.verification
      : undefined;
  const checked = verifyRuntimeGenerationDetailed(current, false, retained);
  const selection: RuntimeGenerationSelection = { ...current, verification: checked.verification };
  if (!pointer) {
    pointer = { schemaVersion: 1, active: selection };
  } else if (pointer.active.generationId === current.generationId && pointer.active.installRoot === current.installRoot) {
    pointer = { ...pointer, active: selection };
  } else {
    pointer = { ...pointer, pending: selection };
  }
  writeRuntimeGenerationPointer(stateDir, pointer);
  return { pointer, current, manifest: checked.manifest };
}

/** A fresh launch activates the complete manifest currently shipped in the root. */
export function prepareRuntimeGeneration(stateDir: string, currentEntry: string): {
  pointer: RuntimeGenerationPointer;
  manifest: RuntimeGenerationManifest;
} {
  const staged = stageRuntimeGeneration(stateDir, currentEntry);
  let pointer = staged.pointer;
  if (pointer.active.generationId !== staged.current.generationId || pointer.active.installRoot !== staged.current.installRoot) {
    const target = pointer.pending;
    if (!target || target.generationId !== staged.current.generationId) throw new RuntimeGenerationError("pointer");
    pointer = {
      schemaVersion: 1,
      active: target,
      previousGenerationId: pointer.active.generationId,
    };
    writeRuntimeGenerationPointer(stateDir, pointer);
  }
  return { pointer, manifest: staged.manifest };
}

/** Activate one staged generation after the park gate settles. */
export function selectRuntimeGeneration(stateDir: string, generationId: string): RuntimeGenerationPointer {
  const pointer = readRuntimeGenerationPointer(stateDir);
  if (!pointer) throw new RuntimeGenerationError("pointer");
  const target = pointer.active.generationId === generationId ? pointer.active : pointer.pending;
  if (!target || target.generationId !== generationId) throw new RuntimeGenerationError("pointer");
  const checked = verifyRuntimeGenerationDetailed(target, false, target.verification);
  const active: RuntimeGenerationSelection = { ...target, verification: checked.verification };
  if (pointer.active.generationId === generationId && pointer.active.installRoot === target.installRoot) {
    const next = { ...pointer, active };
    writeRuntimeGenerationPointer(stateDir, next);
    return next;
  }
  const next: RuntimeGenerationPointer = {
    schemaVersion: 1,
    active,
    previousGenerationId: pointer.active.generationId,
  };
  writeRuntimeGenerationPointer(stateDir, next);
  return next;
}

export function runtimeUpdateId(manifest: Pick<RuntimeGenerationManifest, "buildIdentity" | "generationId">): string {
  return sha256(`${manifest.buildIdentity}\0${manifest.generationId}`);
}

export class RuntimeGenerationGuard {
  constructor(readonly reference: RuntimeGenerationReference, private readonly persisted?: RuntimeGenerationVerification) {}
  verify(): RuntimeGenerationManifest {
    return verifyRuntimeGeneration(this.reference, false, this.persisted);
  }
}

interface FeatureGenerationPointer {
  schemaVersion: 1;
  featureGenerationId: string;
  previousFeatureGenerationId?: string;
}

export class FeatureGenerationStore {
  constructor(private readonly stateDir: string, private readonly runtimeGenerationId: string) {}

  ensure(input: { cwd: string; featurePrefsRevision: number; effectiveFeatures: FeatureId[]; mode: WorkerMode }): FeatureGenerationManifest {
    const cwdDigest = sha256(input.cwd);
    const effectiveFeatures = [...input.effectiveFeatures].sort();
    const body = `${this.runtimeGenerationId}\0${cwdDigest}\0${input.featurePrefsRevision}\0${input.mode}\0${effectiveFeatures.join("\0")}`;
    const featureGenerationId = sha256(body);
    const manifest: FeatureGenerationManifest = {
      schemaVersion: 1,
      featureGenerationId,
      runtimeGenerationId: this.runtimeGenerationId,
      cwdDigest,
      desiredPrefsRevision: input.featurePrefsRevision,
      effectiveFeatures,
      mode: input.mode,
    };
    const root = join(this.stateDir, "feature-generations");
    const manifestPath = join(root, `${featureGenerationId}.json`);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const pointerPath = join(root, "projects", `${cwdDigest}.json`);
    let pointer: FeatureGenerationPointer | undefined;
    if (existsSync(pointerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<FeatureGenerationPointer>;
        if (parsed.schemaVersion !== 1 || !HASH.test(parsed.featureGenerationId ?? "")
          || (parsed.previousFeatureGenerationId !== undefined && !HASH.test(parsed.previousFeatureGenerationId))) {
          throw new RuntimeGenerationError("corrupt");
        }
        pointer = parsed as FeatureGenerationPointer;
      } catch (error) {
        if (error instanceof RuntimeGenerationError) throw error;
        throw new RuntimeGenerationError("corrupt");
      }
    }

    if (pointer?.featureGenerationId === featureGenerationId) {
      if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifestText) {
        throw new RuntimeGenerationError("corrupt");
      }
      return manifest;
    }

    if (!existsSync(manifestPath)) atomicWrite(manifestPath, manifestText, 0o600);
    else if (readFileSync(manifestPath, "utf8") !== manifestText) throw new RuntimeGenerationError("corrupt");
    const next: FeatureGenerationPointer = {
      schemaVersion: 1,
      featureGenerationId,
      ...(pointer ? { previousFeatureGenerationId: pointer.featureGenerationId } : {}),
    };
    atomicWrite(pointerPath, `${JSON.stringify(next)}\n`, 0o600);

    const dropped = pointer?.previousFeatureGenerationId;
    if (dropped && dropped !== featureGenerationId && dropped !== next.previousFeatureGenerationId) {
      try {
        unlinkSync(join(root, `${dropped}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return manifest;
  }
}

function atomicWrite(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, "w", mode);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows cannot fsync a directory. */ }
}
