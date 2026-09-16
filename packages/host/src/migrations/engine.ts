import { createHash } from "node:crypto";
import { runtimeMigrationCopy } from "@lasercode/protocol";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  atomicWrite,
  copyWhole,
  describeUnit,
  fsyncDirectory,
  modeOf,
  removePath,
  resolveUnit,
  safeMigrationPath,
  unitKey,
  validSnapshotUnit,
  validateUnit,
  verifyUnit,
  type MigrationEngineBoundary,
} from "./storage.js";
import type {
  MigrationContext,
  MigrationEngineOptions,
  MigrationRecoveryResult,
  MigrationRegistry,
  MigrationSnapshotManifest,
  MigrationState,
  MigrationStep,
  MigrationUnit,
  SnapshotUnitManifest,
} from "./types.js";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export class MigrationError extends Error {
  override readonly name = "MigrationError";
  constructor(
    readonly category: "snapshot" | "migration" | "restore" | "schema" | "target",
    message = category === "schema" ? runtimeMigrationCopy("newer-schema") : runtimeMigrationCopy("unsafe"),
    options?: ErrorOptions,
  ) { super(message, options); }
}

export function readMigrationState(stateDir: string): MigrationState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "migration-state.json"), "utf8")) as Partial<MigrationState>;
    validateState(parsed);
    return parsed as MigrationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("restore", runtimeMigrationCopy("restore-failed"), { cause: error });
  }
}

export interface MigrationRunInput {
  updateId: string;
  targetGenerationId: string;
}

export class MigrationEngine {
  private readonly boundary: MigrationEngineBoundary | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: MigrationEngineOptions) {
    this.boundary = options.boundary;
    this.now = options.now ?? (() => new Date());
    validateRegistry(options.registry);
  }

  currentState(): MigrationState | undefined {
    return readMigrationState(this.options.roots.stateDir);
  }

  currentSchema(): number {
    try {
      const value = JSON.parse(readFileSync(this.schemaPath(), "utf8")) as { schemaVersion?: unknown };
      if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) throw new MigrationError("schema");
      return value.schemaVersion as number;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
      if (error instanceof MigrationError) throw error;
      throw new MigrationError("schema");
    }
  }

  needsMigration(): boolean {
    const current = this.currentSchema();
    if (current > this.options.registry.targetSchema) throw new MigrationError("schema");
    return current < this.options.registry.targetSchema;
  }

  migrate(input: MigrationRunInput): MigrationState | undefined {
    validateIdentity(input.updateId, input.targetGenerationId);
    const existing = this.currentState();
    if (existing && (existing.updateId !== input.updateId || existing.targetGenerationId !== input.targetGenerationId)) {
      throw new MigrationError("migration", runtimeMigrationCopy("owner"));
    }
    if (existing?.phase === "migrated") return existing;
    if (existing?.phase === "restoring") {
      this.restore(existing.updateId);
      return this.migrate(input);
    }

    const fromSchema = existing?.fromSchema ?? this.currentSchema();
    const targetSchema = this.options.registry.targetSchema;
    if (fromSchema > targetSchema) throw new MigrationError("schema");
    if (fromSchema === targetSchema) return undefined;
    const steps = stepsFrom(this.options.registry, fromSchema);
    const schemaFileExisted = existing?.schemaFileExisted ?? existsSync(this.schemaPath());
    let state: MigrationState = existing ?? {
      schemaVersion: 1,
      updateId: input.updateId,
      phase: "snapshotting",
      fromSchema,
      targetSchema,
      targetGenerationId: input.targetGenerationId,
      stepIndex: 0,
      restoreIndex: 0,
      schemaFileExisted,
      updatedAt: this.now().toISOString(),
    };
    state = this.writeState(state);
    try {
      const snapshot = this.createOrResumeSnapshot(state, steps);
      state = this.writeState({ ...state, phase: "migrating", snapshotDigest: snapshot.digest });
      const context = this.contextFor(steps);
      for (let index = state.stepIndex; index < steps.length; index += 1) {
        const step = steps[index]!;
        this.boundary?.("step", step.id);
        step.run(context.forStep(step));
        state = this.writeState({ ...state, stepIndex: index + 1 });
      }
      atomicWrite(this.schemaPath(), `${JSON.stringify({ schemaVersion: targetSchema }, null, 2)}\n`, 0o600, this.boundary);
      state = this.writeState({ ...state, phase: "migrated", stepIndex: steps.length });
      return state;
    } catch (error) {
      this.noteFailure(state, state.phase === "snapshotting" ? "snapshot" : "migration");
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new MigrationError(state.phase === "snapshotting" ? "snapshot" : "migration", runtimeMigrationCopy("space"), { cause: error });
      }
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(state.phase === "snapshotting" ? "snapshot" : "migration", undefined, { cause: error });
    }
  }

  recover(input: { targetVerified: boolean }): MigrationRecoveryResult {
    const state = this.currentState();
    if (!state) return { status: "none" };
    if (state.phase === "snapshotting") removePath(this.snapshotStaging(state.updateId));
    if (state.phase === "snapshotting" || state.phase === "migrating") {
      const migrated = this.migrate({ updateId: state.updateId, targetGenerationId: state.targetGenerationId });
      return migrated ? { status: "migrated", state: migrated } : { status: "none" };
    }
    if (state.phase === "restoring") return { status: "restored", state: this.restore(state.updateId) };
    if (input.targetVerified) return { status: "migrated", state };
    this.noteFailure(state, "target");
    return { status: "restored", state: this.restore(state.updateId) };
  }

  restore(updateId: string): MigrationState {
    const initial = this.currentState();
    if (!initial || initial.updateId !== updateId || !initial.snapshotDigest) throw new MigrationError("restore");
    let state = initial.phase === "restoring"
      ? initial
      : this.writeState({ ...initial, phase: "restoring", restoreIndex: 0, failureCategory: "restore" });
    try {
      const snapshot = this.readSnapshot(state);
      for (let index = state.restoreIndex; index < snapshot.manifest.units.length; index += 1) {
        const unit = snapshot.manifest.units[index]!;
        this.restoreUnit(state, unit, index);
        state = this.writeState({ ...state, restoreIndex: index + 1 });
        this.options.onProgress?.({ phase: "restoring", completed: index + 1, total: snapshot.manifest.units.length });
      }
      if (!state.schemaFileExisted) rmSync(this.schemaPath(), { force: true });
      this.removeState();
      return state;
    } catch (error) {
      this.noteFailure(state, "restore");
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new MigrationError("restore", runtimeMigrationCopy("restore-space"), { cause: error });
      }
      if (error instanceof MigrationError) throw error;
      throw new MigrationError("restore", runtimeMigrationCopy("restore-failed"), { cause: error });
    }
  }

  /** Fence a migrated marker to the one host launch that may bind against it. */
  markLaunchAttempt(updateId: string, launchId: string): void {
    if (!/^[0-9a-f]{32}$/.test(launchId)) throw new MigrationError("target");
    const state = this.currentState();
    if (!state || state.updateId !== updateId || state.phase !== "migrated") throw new MigrationError("target");
    this.writeState({ ...state, launchAttemptId: launchId });
  }

  /** Called only after that exact launch reports the selected generation and version. */
  acknowledgeSelection(updateId: string, launchId: string): void {
    const state = this.currentState();
    if (!state || state.updateId !== updateId || state.phase !== "migrated" || state.launchAttemptId !== launchId) {
      throw new MigrationError("target");
    }
    this.removeState();
  }

  /** The snapshot outlives migration and selection; only a healthy exact launch removes it. */
  markSucceeded(updateId: string): void {
    if (!HASH.test(updateId)) throw new MigrationError("target");
    removePath(this.snapshotRoot(updateId));
    removePath(this.snapshotStaging(updateId));
    const state = this.currentState();
    if (state?.updateId === updateId) this.removeState();
    fsyncDirectory(this.snapshotsRoot());
  }

  private createOrResumeSnapshot(state: MigrationState, steps: readonly MigrationStep[]): { digest: string } {
    const final = this.snapshotRoot(state.updateId);
    if (existsSync(final)) {
      try { return { digest: this.readSnapshot({ ...state, snapshotDigest: this.snapshotDigest(final) }).digest }; }
      catch { removePath(final); }
    }
    const staging = this.snapshotStaging(state.updateId);
    removePath(staging);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    chmodSync(staging, 0o700);
    const units = declaredUnits(steps);
    if (state.schemaFileExisted) units.push({ root: "stateDir", path: "migration-schema.json", type: "file" });
    const resolvedUnits = units.map((unit) => ({ unit, source: resolveUnit(this.options.roots, unit) }));
    for (let left = 0; left < resolvedUnits.length; left += 1) {
      for (let right = left + 1; right < resolvedUnits.length; right += 1) {
        const a = resolvedUnits[left]!.source;
        const b = resolvedUnits[right]!.source;
        const aToB = relative(a, b);
        const bToA = relative(b, a);
        const nested = (value: string) => value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
        if (nested(aToB) || nested(bToA)) throw new MigrationError("snapshot");
      }
    }
    const manifestUnits: SnapshotUnitManifest[] = [];
    for (const [index, { unit, source }] of resolvedUnits.entries()) {
      const destination = this.snapshotUnitPath(staging, unit);
      copyWhole(source, destination, unit.type, this.boundary);
      const expected = describeUnit(this.options.roots, unit, source, this.boundary);
      if (!verifyUnit(destination, expected, this.boundary)) throw new MigrationError("snapshot");
      manifestUnits.push(expected);
      this.options.onProgress?.({ phase: "snapshotting", completed: index + 1, total: units.length });
    }
    const manifest: MigrationSnapshotManifest = {
      schemaVersion: 1,
      updateId: state.updateId,
      fromSchema: state.fromSchema,
      targetSchema: state.targetSchema,
      units: manifestUnits,
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    atomicWrite(join(staging, "manifest.json"), text, 0o600, this.boundary);
    this.boundary?.("hash", join(staging, "manifest.json"));
    const digest = sha256(text);
    this.verifySnapshot(staging, manifest, digest);
    mkdirSync(this.snapshotsRoot(), { recursive: true, mode: 0o700 });
    this.boundary?.("rename", final);
    renameSync(staging, final);
    fsyncDirectory(this.snapshotsRoot());
    this.verifySnapshot(final, manifest, digest);
    return { digest };
  }

  private readSnapshot(state: MigrationState): { manifest: MigrationSnapshotManifest; digest: string } {
    const root = this.snapshotRoot(state.updateId);
    const manifestPath = join(root, "manifest.json");
    const raw = readFileSync(manifestPath);
    this.boundary?.("hash", manifestPath);
    const digest = sha256(raw);
    if (digest !== state.snapshotDigest) throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
    let manifest: MigrationSnapshotManifest;
    try { manifest = JSON.parse(raw.toString("utf8")) as MigrationSnapshotManifest; }
    catch (error) { throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"), { cause: error }); }
    this.verifySnapshot(root, manifest, digest);
    if (manifest.updateId !== state.updateId || manifest.fromSchema !== state.fromSchema || manifest.targetSchema !== state.targetSchema) {
      throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
    }
    return { manifest, digest };
  }

  private verifySnapshot(root: string, manifest: MigrationSnapshotManifest, digest: string): void {
    if (!HASH.test(digest) || manifest.schemaVersion !== 1 || !HASH.test(manifest.updateId)
      || !Number.isSafeInteger(manifest.fromSchema) || !Number.isSafeInteger(manifest.targetSchema)
      || !Array.isArray(manifest.units) || modeOf(root) !== 0o700) throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
    const seen = new Set<string>();
    for (const unit of manifest.units) {
      if (!validSnapshotUnit(unit) || seen.has(unitKey(unit))) throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
      seen.add(unitKey(unit));
      if (!verifyUnit(this.snapshotUnitPath(root, unit), unit, this.boundary)) {
        throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
      }
    }
  }

  private restoreUnit(state: MigrationState, unit: SnapshotUnitManifest, index: number): void {
    const destination = resolveUnit(this.options.roots, unit);
    const parent = dirname(destination);
    const staging = join(parent, `.${basename(destination)}.restore-${state.updateId}-${index}`);
    const displaced = `${staging}.previous`;
    if (existsSync(destination) && verifyUnit(destination, unit, this.boundary)) {
      removePath(staging); removePath(displaced); return;
    }
    removePath(staging);
    copyWhole(this.snapshotUnitPath(this.snapshotRoot(state.updateId), unit), staging, unit.type, this.boundary);
    if (!verifyUnit(staging, unit, this.boundary)) throw new MigrationError("restore", runtimeMigrationCopy("snapshot-damaged"));
    if (existsSync(destination)) {
      removePath(displaced);
      this.boundary?.("rename", displaced);
      renameSync(destination, displaced);
    }
    this.boundary?.("rename", destination);
    renameSync(staging, destination);
    fsyncDirectory(parent);
    if (!verifyUnit(destination, unit, this.boundary)) throw new MigrationError("restore");
    removePath(displaced);
  }

  private contextFor(steps: readonly MigrationStep[]): { forStep(step: MigrationStep): MigrationContext } {
    const roots = this.options.roots;
    const boundary = this.boundary;
    return {
      forStep: (step) => {
        const allowed = new Set(step.units.map(unitKey));
        const pathFor = (unit: MigrationUnit): string => {
          validateUnit(unit);
          if (!allowed.has(unitKey(unit))) throw new MigrationError("migration", "A migration tried to write outside its declared data units.");
          const path = resolveUnit(roots, unit);
          const displaced = `${path}.migration-previous`;
          if (!existsSync(path) && existsSync(displaced)) renameSync(displaced, path);
          return path;
        };
        return {
          readFile(unit) {
            if (unit.type !== "file") throw new MigrationError("migration");
            return readFileSync(pathFor(unit));
          },
          writeFile(unit, bytes, mode) {
            if (unit.type !== "file") throw new MigrationError("migration");
            atomicWrite(pathFor(unit), Buffer.from(bytes), mode ?? 0o600, boundary);
          },
          readDirectory(unit) {
            if (unit.type !== "directory") throw new MigrationError("migration");
            const root = pathFor(unit);
            const files = new Map<string, Buffer>();
            const visit = (directory: string): void => {
              for (const name of readdirSync(directory).sort()) {
                const path = join(directory, name);
                const stat = lstatSync(path);
                if (stat.isSymbolicLink()) throw new MigrationError("migration");
                if (stat.isDirectory()) visit(path);
                else if (stat.isFile()) files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
                else throw new MigrationError("migration");
              }
            };
            visit(root);
            return files;
          },
          replaceDirectory(unit, files, mode) {
            if (unit.type !== "directory") throw new MigrationError("migration");
            const destination = pathFor(unit);
            const staging = `${destination}.migration-next`;
            const displaced = `${destination}.migration-previous`;
            removePath(staging);
            if (!existsSync(destination) && existsSync(displaced)) renameSync(displaced, destination);
            removePath(displaced);
            mkdirSync(staging, { recursive: true, mode: mode ?? 0o700 });
            for (const [relativePath, bytes] of files) {
              if (!safeMigrationPath(relativePath)) throw new MigrationError("migration");
              atomicWrite(join(staging, relativePath), Buffer.from(bytes), 0o600, boundary);
            }
            boundary?.("rename", displaced);
            renameSync(destination, displaced);
            boundary?.("rename", destination);
            renameSync(staging, destination);
            fsyncDirectory(dirname(destination));
            removePath(displaced);
          },
        };
      },
    };
  }

  private noteFailure(state: MigrationState, category: NonNullable<MigrationState["failureCategory"]>): void {
    try { this.writeState({ ...state, failureCategory: category }); } catch { /* Preserve the earlier durable marker. */ }
  }

  private writeState(state: Omit<MigrationState, "updatedAt"> | MigrationState): MigrationState {
    const next: MigrationState = { ...state, updatedAt: this.now().toISOString() };
    this.boundary?.("marker", next.phase);
    atomicWrite(this.statePath(), `${JSON.stringify(next, null, 2)}\n`, 0o600, this.boundary);
    this.options.onState?.(next);
    return next;
  }

  private removeState(): void {
    rmSync(this.statePath(), { force: true });
    fsyncDirectory(this.options.roots.stateDir);
  }

  private snapshotDigest(root: string): string {
    const path = join(root, "manifest.json");
    this.boundary?.("hash", path);
    return sha256(readFileSync(path));
  }
  private statePath(): string { return join(this.options.roots.stateDir, "migration-state.json"); }
  private schemaPath(): string { return join(this.options.roots.stateDir, "migration-schema.json"); }
  private snapshotsRoot(): string { return join(this.options.roots.stateDir, "migration-snapshots"); }
  private snapshotRoot(updateId: string): string { return join(this.snapshotsRoot(), updateId); }
  private snapshotStaging(updateId: string): string { return join(this.snapshotsRoot(), `${updateId}.staging`); }
  private snapshotUnitPath(root: string, unit: MigrationUnit): string { return join(root, "data", unit.root, ...unit.path.split("/")); }
}

function validateIdentity(updateId: string, generationId: string): void {
  if (!HASH.test(updateId) || !HASH.test(generationId)) throw new MigrationError("target");
}

function validateRegistry(registry: MigrationRegistry): void {
  if (!Number.isSafeInteger(registry.targetSchema) || registry.targetSchema < 1 || !Array.isArray(registry.steps)) throw new MigrationError("schema");
  const ids = new Set<string>();
  for (const step of registry.steps) {
    if (!ID.test(step.id) || ids.has(step.id) || !Number.isSafeInteger(step.fromSchema)
      || !Number.isSafeInteger(step.toSchema) || step.toSchema !== step.fromSchema + 1
      || !Array.isArray(step.units) || typeof step.run !== "function") throw new MigrationError("schema");
    ids.add(step.id);
    const units = new Set<string>();
    for (const unit of step.units) {
      try { validateUnit(unit); } catch { throw new MigrationError("schema"); }
      const key = unitKey(unit);
      if (units.has(key)) throw new MigrationError("schema");
      units.add(key);
    }
  }
}

function stepsFrom(registry: MigrationRegistry, fromSchema: number): MigrationStep[] {
  const result: MigrationStep[] = [];
  let schema = fromSchema;
  while (schema < registry.targetSchema) {
    const candidates = registry.steps.filter((step) => step.fromSchema === schema);
    if (candidates.length !== 1) throw new MigrationError("schema", "This update does not contain a complete migration path for the current data.");
    const step = candidates[0]!;
    result.push(step);
    schema = step.toSchema;
  }
  return result;
}

function declaredUnits(steps: readonly MigrationStep[]): MigrationUnit[] {
  const units = new Map<string, MigrationUnit>();
  const locations = new Map<string, MigrationUnit["type"]>();
  for (const step of steps) for (const unit of step.units) {
    const location = `${unit.root}:${unit.path}`;
    const previous = locations.get(location);
    if (previous && previous !== unit.type) throw new MigrationError("schema");
    locations.set(location, unit.type);
    units.set(unitKey(unit), { ...unit });
  }
  return [...units.values()].sort((left, right) => unitKey(left).localeCompare(unitKey(right)));
}

function validateState(value: Partial<MigrationState>): void {
  if (value.schemaVersion !== 1 || !HASH.test(value.updateId ?? "") || !HASH.test(value.targetGenerationId ?? "")
    || !["snapshotting", "migrating", "migrated", "restoring"].includes(value.phase ?? "")
    || !Number.isSafeInteger(value.fromSchema) || !Number.isSafeInteger(value.targetSchema)
    || !Number.isSafeInteger(value.stepIndex) || (value.stepIndex ?? -1) < 0
    || !Number.isSafeInteger(value.restoreIndex) || (value.restoreIndex ?? -1) < 0
    || typeof value.schemaFileExisted !== "boolean"
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.snapshotDigest !== undefined && !HASH.test(value.snapshotDigest))
    || (value.launchAttemptId !== undefined && !/^[0-9a-f]{32}$/.test(value.launchAttemptId))
    || (value.failureCategory !== undefined && !["snapshot", "migration", "restore", "target"].includes(value.failureCategory))) {
    throw new MigrationError("restore");
  }
}
