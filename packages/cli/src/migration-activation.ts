import { appendFileSync } from "node:fs";
import {
  MIGRATION_REGISTRY,
  MigrationEngine,
  MigrationError,
  UpdateTransactionStore,
  readMigrationState,
  readRuntimeGenerationPointer,
  runtimeUpdateId,
  type MigrationRegistry,
  type MigrationRoots,
  type RuntimeGenerationManifest,
} from "@lasercode/host";
import { runtimeMigrationCopy, runtimeMigrationEventCopy, runtimeUpdatePresentation } from "@lasercode/protocol";
import type { LaserPaths } from "./config.js";

export type MigrationLaunchPhase = "preparing" | "migrating" | "ready" | "restoring" | "restored" | "failed";

export interface MigrationLaunchEvent {
  schemaVersion: 1;
  type: "migration";
  updateId: string;
  phase: MigrationLaunchPhase;
  message: string;
  progress?: { completed: number; total: number };
}

export type MigrationEventSink = (event: MigrationLaunchEvent) => void;
export type MigrationSnapshotStatus = "available" | "none" | "restored";

export class MigrationActivationError extends Error {
  override readonly name = "MigrationActivationError";
  readonly canRestore: boolean;
  constructor(
    readonly updateId: string,
    readonly snapshot: MigrationSnapshotStatus,
    message = snapshot === "restored"
      ? runtimeUpdatePresentation("restored").title
      : snapshot === "none"
        ? runtimeUpdatePresentation("no-snapshot").detail
        : runtimeUpdatePresentation("migration-failed").title,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.canRestore = snapshot === "available";
  }
}

const messageFor = (phase: MigrationLaunchPhase): string => {
  if (phase === "preparing" || phase === "migrating" || phase === "ready") return runtimeMigrationEventCopy(phase);
  if (phase === "restoring") return runtimeUpdatePresentation("restoring").title;
  if (phase === "restored") return runtimeUpdatePresentation("restored").title;
  const copy = runtimeUpdatePresentation("migration-failed");
  return `${copy.title} ${copy.detail}`;
};

export function migrationEventLine(event: MigrationLaunchEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function emit(
  sink: MigrationEventSink | undefined,
  updateId: string,
  phase: MigrationLaunchPhase,
  progress?: { completed: number; total: number },
): void {
  sink?.({ schemaVersion: 1, type: "migration", updateId, phase, message: messageFor(phase), ...(progress ? { progress } : {}) });
}

function roots(paths: LaserPaths): MigrationRoots {
  return { stateDir: paths.stateDir, agentDir: paths.agentDir, sessionDir: paths.sessionDir };
}

function causeText(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.join(" <- ") || String(error);
}

function logCause(paths: LaserPaths, stage: string, error: unknown): void {
  try {
    appendFileSync(paths.logFile, `${new Date().toISOString()} migration ${stage} failed: ${causeText(error)}\n`, { mode: 0o600 });
  } catch { /* The durable marker remains the recovery authority when logging itself fails. */ }
}

function transitionToFailed(paths: LaserPaths, store: UpdateTransactionStore, updateId: string): void {
  try {
    const transaction = store.read(updateId);
    if (transaction && !["failed", "rolled_back", "succeeded"].includes(transaction.phase)) {
      store.transition(updateId, "failed", { failureCategory: "migration_failed" });
    }
  } catch (error) { logCause(paths, "failure-ledger", error); }
}

/** Run the staged generation's registry only when no old-generation host is bound. */
export function prepareUpdateData(
  paths: LaserPaths,
  input: { updateId: string; targetGenerationId: string },
  sink?: MigrationEventSink,
  dependencies: { registry?: MigrationRegistry } = {},
): void {
  const store = new UpdateTransactionStore(paths.stateDir);
  let transaction = store.read(input.updateId);
  if (!transaction || transaction.targetGenerationId !== input.targetGenerationId) {
    throw new MigrationActivationError(input.updateId, "none");
  }
  if (transaction.phase === "failed" || transaction.phase === "rolled_back") transaction = store.transition(input.updateId, "parking");
  if (transaction.phase === "staged") transaction = store.transition(input.updateId, "parking");
  if (transaction.phase === "selected") transaction = store.transition(input.updateId, "restarting");
  if (transaction.phase === "parking") transaction = store.transition(input.updateId, "snapshotting");
  if (!["snapshotting", "migrating", "ready", "restarting"].includes(transaction.phase)) {
    if (transaction.phase === "succeeded") return;
    throw new MigrationActivationError(input.updateId, "none");
  }

  emit(sink, input.updateId, "preparing", { completed: 0, total: 1 });
  try {
    let migrationAnnounced = false;
    const engine = new MigrationEngine({
      roots: roots(paths),
      registry: dependencies.registry ?? MIGRATION_REGISTRY,
      onState(state) {
        if (state.phase !== "migrating") return;
        const current = store.read(input.updateId);
        if (current?.phase === "snapshotting") store.transition(input.updateId, "migrating");
        if (!migrationAnnounced) {
          migrationAnnounced = true;
          emit(sink, input.updateId, "migrating");
        }
      },
      onProgress(progress) {
        emit(sink, input.updateId, progress.phase === "restoring" ? "restoring" : "preparing", {
          completed: progress.completed,
          total: Math.max(1, progress.total),
        });
      },
    });
    engine.migrate(input);
    transaction = store.read(input.updateId)!;
    if (transaction.phase === "snapshotting") transaction = store.transition(input.updateId, "migrating");
    if (transaction.phase === "migrating") store.transition(input.updateId, "ready");
    emit(sink, input.updateId, "ready", { completed: 1, total: 1 });
  } catch (error) {
    logCause(paths, "prepare", error);
    transitionToFailed(paths, store, input.updateId);
    emit(sink, input.updateId, "failed");
    const available = new MigrationEngine({ roots: roots(paths), registry: dependencies.registry ?? MIGRATION_REGISTRY })
      .currentState()?.snapshotDigest !== undefined;
    throw new MigrationActivationError(input.updateId, available ? "available" : "none", undefined, { cause: error });
  }
}

/** Resume a durable marker, or restore it when a selected target already failed to become ready. */
export function recoverUpdateData(
  paths: LaserPaths,
  input: { updateId: string; targetGenerationId: string; targetVerified: boolean },
  sink?: MigrationEventSink,
  dependencies: { registry?: MigrationRegistry } = {},
): "migrated" | "restored" | "none" {
  const store = new UpdateTransactionStore(paths.stateDir);
  const transaction = store.read(input.updateId);
  if (!transaction || transaction.targetGenerationId !== input.targetGenerationId) {
    throw new MigrationActivationError(input.updateId, "none");
  }
  const engine = new MigrationEngine({ roots: roots(paths), registry: dependencies.registry ?? MIGRATION_REGISTRY });
  try {
    if (!input.targetVerified && transaction.phase !== "restoring") store.transition(input.updateId, "restoring");
    emit(sink, input.updateId, input.targetVerified ? "preparing" : "restoring");
    const result = engine.recover({ targetVerified: input.targetVerified });
    if (result.status === "restored") {
      let current = store.read(input.updateId);
      if (current && current.phase !== "restoring" && current.phase !== "rolled_back") {
        current = store.transition(input.updateId, "restoring");
      }
      if (current?.phase === "restoring") store.transition(input.updateId, "rolled_back");
      emit(sink, input.updateId, "restored");
      return "restored";
    }
    if (result.status === "migrated") {
      let current = store.read(input.updateId);
      if (current?.phase === "snapshotting") current = store.transition(input.updateId, "migrating");
      if (current?.phase === "migrating") store.transition(input.updateId, "ready");
      emit(sink, input.updateId, "ready");
    }
    return result.status;
  } catch (error) {
    logCause(paths, "recover", error);
    transitionToFailed(paths, store, input.updateId);
    throw new MigrationActivationError(input.updateId, engine.currentState()?.snapshotDigest ? "available" : "none", undefined, { cause: error });
  }
}

export function restoreUpdateData(
  paths: LaserPaths,
  updateId: string,
  sink?: MigrationEventSink,
  dependencies: { registry?: MigrationRegistry } = {},
): void {
  const store = new UpdateTransactionStore(paths.stateDir);
  const transaction = store.read(updateId);
  if (!transaction) throw new MigrationActivationError(updateId, "none");
  if (transaction.phase === "rolled_back") return;
  if (transaction.phase !== "restoring") store.transition(updateId, "restoring");
  emit(sink, updateId, "restoring");
  try {
    new MigrationEngine({ roots: roots(paths), registry: dependencies.registry ?? MIGRATION_REGISTRY }).restore(updateId);
    store.transition(updateId, "rolled_back");
    emit(sink, updateId, "restored");
  } catch (error) {
    logCause(paths, "restore", error);
    emit(sink, updateId, "failed");
    throw new MigrationActivationError(updateId, "available", runtimeMigrationCopy("restore-failed"), { cause: error });
  }
}

export function completeMigrationLaunch(
  paths: LaserPaths,
  launch: { updateId?: string; launchId: string; generationId: string; version: string },
): boolean {
  const durableMarker = readMigrationState(paths.stateDir);
  const updateId = launch.updateId ?? durableMarker?.updateId;
  if (!updateId) return false;
  const store = new UpdateTransactionStore(paths.stateDir);
  const transaction = store.read(updateId);
  if (!transaction || (transaction.phase !== "restarting" && transaction.phase !== "succeeded")
    || transaction.targetGenerationId !== launch.generationId || transaction.targetVersion !== launch.version) return false;
  if (durableMarker && (durableMarker.phase !== "migrated"
    || durableMarker.targetGenerationId !== launch.generationId
    || durableMarker.launchAttemptId !== launch.launchId)) return false;
  if (transaction.phase === "restarting") {
    store.transition(updateId, "succeeded", { selectedLaunchId: launch.launchId, selectedVersion: launch.version });
  }
  const engine = new MigrationEngine({ roots: roots(paths), registry: MIGRATION_REGISTRY });
  if (durableMarker) engine.acknowledgeSelection(updateId, launch.launchId);
  engine.markSucceeded(updateId);
  return true;
}

/** Create or recover the transaction used by a closed/headless update launch. */
export function ensureUpdateTransaction(paths: LaserPaths, manifest: RuntimeGenerationManifest): string {
  const pointer = readRuntimeGenerationPointer(paths.stateDir);
  if (!pointer) throw new MigrationActivationError(runtimeUpdateId(manifest), "none");
  const updateId = runtimeUpdateId(manifest);
  const store = new UpdateTransactionStore(paths.stateDir);
  let transaction = store.begin({
    updateId,
    targetGenerationId: manifest.generationId,
    previousGenerationId: pointer.active.generationId,
    targetVersion: manifest.productVersion,
    buildIdentity: manifest.buildIdentity,
    manifestDigest: pointer.pending?.generationId === manifest.generationId
      ? pointer.pending.manifestDigest
      : pointer.active.manifestDigest,
  });
  if (transaction.phase === "discovered") transaction = store.transition(updateId, "staging");
  if (transaction.phase === "staging") store.transition(updateId, "staged");
  return updateId;
}
