import { createHash } from "node:crypto";
import {
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
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ENV, type FeatureId, type WorkerMode } from "@lasercode/protocol";

export const RUNTIME_MANIFEST_NAME = "runtime-generation.json";
export const RUNTIME_POINTER_NAME = "runtime-generation.json";
export const RUNTIME_GENERATION_ERROR = "The app's runtime files changed after they were installed. Reinstall the app before starting it.";

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

export interface RuntimeGenerationPointer {
  schemaVersion: 1;
  active: RuntimeGenerationReference;
  previous?: RuntimeGenerationReference;
  pending?: RuntimeGenerationReference;
}

export interface FeatureGenerationManifest {
  schemaVersion: 1;
  featureGenerationId: string;
  runtimeGenerationId: string;
  cwdDigest: string;
  desiredPrefsRevision: number;
  effectiveFeatures: FeatureId[];
  mode: WorkerMode;
}

export class RuntimeGenerationError extends Error {
  override readonly name = "RuntimeGenerationError";
  constructor(readonly reason: "missing" | "corrupt" | "drift" | "pointer") {
    super(RUNTIME_GENERATION_ERROR);
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

/** Verify the exact selected install before host launch or worker spawn. */
export function verifyRuntimeGeneration(reference: RuntimeGenerationReference, full = false): RuntimeGenerationManifest {
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
  const manifestMatches = runtimeManifestDigest(raw) === reference.manifestDigest
    && manifest.generationId === reference.generationId;
  const entryPaths = new Set(Object.values(manifest.entries));
  const rowsToHash: RuntimeInventoryRow[] = [];
  let metadataMismatch = !manifestMatches;
  for (const row of manifest.inventory) {
    const absolute = resolve(root, row.path);
    if (!inside(root, absolute)) throw new RuntimeGenerationError("corrupt");
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        metadataMismatch = true;
        rowsToHash.push(row);
        continue;
      }
      if (full || entryPaths.has(row.path) || stat.size !== row.length || stat.mtimeMs !== row.mtimeMs) rowsToHash.push(row);
      if (stat.size !== row.length || stat.mtimeMs !== row.mtimeMs) metadataMismatch = true;
    } catch {
      metadataMismatch = true;
      rowsToHash.push(row);
    }
  }
  let digestMismatch = false;
  for (const row of rowsToHash) {
    try {
      const absolute = resolve(root, row.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.size !== row.length || fileDigest(absolute) !== row.sha256) digestMismatch = true;
    } catch { digestMismatch = true; }
  }
  // A changed or corrupt row triggers one complete pass before refusal, so a
  // partial mismatch can never hide another changed executable.
  if ((metadataMismatch || digestMismatch) && !full) {
    const fullyVerified = verifyRuntimeGeneration(reference, true);
    if (!manifestMatches) throw new RuntimeGenerationError("pointer");
    return fullyVerified;
  }
  if (!manifestMatches) throw new RuntimeGenerationError("pointer");
  if (digestMismatch) throw new RuntimeGenerationError("drift");
  return manifest;
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

export function readRuntimeGenerationPointer(stateDir: string): RuntimeGenerationPointer | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, RUNTIME_POINTER_NAME), "utf8")) as Partial<RuntimeGenerationPointer>;
    if (parsed.schemaVersion !== 1 || !validReference(parsed.active)
      || (parsed.previous !== undefined && !validReference(parsed.previous))
      || (parsed.pending !== undefined && !validReference(parsed.pending))) throw new RuntimeGenerationError("pointer");
    return parsed as RuntimeGenerationPointer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof RuntimeGenerationError) throw error;
    throw new RuntimeGenerationError("pointer");
  }
}

export function writeRuntimeGenerationPointer(stateDir: string, pointer: RuntimeGenerationPointer): void {
  atomicWrite(join(stateDir, RUNTIME_POINTER_NAME), `${JSON.stringify(pointer, null, 2)}\n`, 0o600);
}

/** Select on first install; otherwise retain current as pending and launch active. */
export function stageRuntimeGeneration(stateDir: string, currentEntry: string): {
  pointer: RuntimeGenerationPointer;
  current: RuntimeGenerationReference;
  manifest: RuntimeGenerationManifest;
} {
  const current = runtimeReferenceFromManifest(findRuntimeManifest(currentEntry));
  const manifest = verifyRuntimeGeneration(current, true);
  let pointer = readRuntimeGenerationPointer(stateDir);
  if (!pointer) {
    pointer = { schemaVersion: 1, active: current };
    writeRuntimeGenerationPointer(stateDir, pointer);
  } else if (pointer.active.generationId !== current.generationId || pointer.active.installRoot !== current.installRoot) {
    const alreadyRetained = [pointer.active, pointer.previous, pointer.pending]
      .some((row) => row?.generationId === current.generationId && row.installRoot === current.installRoot);
    if (!alreadyRetained) {
      pointer = { ...pointer, pending: current };
      writeRuntimeGenerationPointer(stateDir, pointer);
    }
  }
  return { pointer, current, manifest };
}

export function prepareRuntimeGeneration(stateDir: string, currentEntry: string): {
  pointer: RuntimeGenerationPointer;
  manifest: RuntimeGenerationManifest;
} {
  const staged = stageRuntimeGeneration(stateDir, currentEntry);
  const manifest = verifyRuntimeGeneration(staged.pointer.active);
  return { pointer: staged.pointer, manifest };
}

/** The only activation write: verify target, then atomically replace one pointer. */
export function selectRuntimeGeneration(stateDir: string, generationId: string): RuntimeGenerationPointer {
  const pointer = readRuntimeGenerationPointer(stateDir);
  if (!pointer) throw new RuntimeGenerationError("pointer");
  const target = [pointer.active, pointer.previous, pointer.pending]
    .find((reference) => reference?.generationId === generationId);
  if (!target) throw new RuntimeGenerationError("pointer");
  verifyRuntimeGeneration(target, true);
  if (target.generationId === pointer.active.generationId && target.installRoot === pointer.active.installRoot) return pointer;
  const next: RuntimeGenerationPointer = {
    schemaVersion: 1,
    active: target,
    previous: pointer.active,
    ...(pointer.pending && pointer.pending.generationId !== target.generationId ? { pending: pointer.pending } : {}),
  };
  writeRuntimeGenerationPointer(stateDir, next);
  return next;
}

export function runtimeUpdateId(manifest: Pick<RuntimeGenerationManifest, "buildIdentity" | "generationId">): string {
  return sha256(`${manifest.buildIdentity}\0${manifest.generationId}`);
}

export class RuntimeGenerationGuard {
  constructor(readonly reference: RuntimeGenerationReference) {}
  verify(): RuntimeGenerationManifest {
    return verifyRuntimeGeneration(this.reference);
  }
}

export class FeatureGenerationStore {
  constructor(private readonly stateDir: string, private readonly runtimeGenerationId: string) {}

  ensure(input: { cwd: string; desiredPrefsRevision: number; effectiveFeatures: FeatureId[]; mode: WorkerMode }): FeatureGenerationManifest {
    const cwdDigest = sha256(input.cwd);
    const effectiveFeatures = [...input.effectiveFeatures].sort();
    const body = `${this.runtimeGenerationId}\0${cwdDigest}\0${input.desiredPrefsRevision}\0${input.mode}\0${effectiveFeatures.join("\0")}`;
    const featureGenerationId = sha256(body);
    const manifest: FeatureGenerationManifest = {
      schemaVersion: 1,
      featureGenerationId,
      runtimeGenerationId: this.runtimeGenerationId,
      cwdDigest,
      desiredPrefsRevision: input.desiredPrefsRevision,
      effectiveFeatures,
      mode: input.mode,
    };
    const root = join(this.stateDir, "feature-generations");
    const manifestPath = join(root, `${featureGenerationId}.json`);
    if (!existsSync(manifestPath)) atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    else if (readFileSync(manifestPath, "utf8") !== `${JSON.stringify(manifest, null, 2)}\n`) throw new RuntimeGenerationError("corrupt");
    atomicWrite(join(root, "projects", `${cwdDigest}.json`), `${JSON.stringify({ schemaVersion: 1, featureGenerationId })}\n`, 0o600);
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
