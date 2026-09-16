import {
  MIGRATION_REGISTRY,
  MigrationEngine,
  UpdateTransactionStore,
  readRuntimeGenerationPointer,
  runtimeUpdateId,
  type MigrationPhase,
  type MigrationRegistry,
  type MigrationRoots,
  type RuntimeGenerationManifest,
} from "@lasercode/host";
import { runtimeUpdatePresentation } from "@lasercode/protocol";
import type { LaserPaths } from "./config.js";

export type MigrationLaunchPhase = "preparing" | "migrating" | "ready" | "restoring" | "restored" | "failed";

export interface MigrationLaunchEvent {
  schemaVersion: 1;
  type: "migration";
  updateId: string;
  phase: MigrationLaunchPhase;
  message: string;
}

export type MigrationEventSink = (event: MigrationLaunchEvent) => void;

export class MigrationActivationError extends Error {
  override readonly name = "MigrationActivationError";
  constructor(readonly updateId: string, readonly canRestore: boolean, message = runtimeUpdatePresentation("migration-failed").title) {
    super(message);
  }
}

const messageFor = (phase: MigrationLaunchPhase): string => {
  switch (phase) {
    case "preparing":
    case "migrating": return runtimeUpdatePresentation("preparing-data").title;
    case "ready": return "Data preparation finished.";
    case "restoring": return runtimeUpdatePresentation("restoring").title;
    case "restored": return runtimeUpdatePresentation("restored").title;
    case "failed": {
      const copy = runtimeUpdatePresentation("migration-failed");
      return `${copy.title} ${copy.detail}`;
    }
  }
};

export function migrationEventLine(event: MigrationLaunchEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function emit(sink: MigrationEventSink | undefined, updateId: string, phase: MigrationLaunchPhase): void {
  sink?.({ schemaVersion: 1, type: "migration", updateId, phase, message: messageFor(phase) });
}

function roots(paths: LaserPaths): MigrationRoots {
  return { stateDir: paths.stateDir, agentDir: paths.agentDir, sessionDir: paths.sessionDir };
}

function transitionToFailed(store: UpdateTransactionStore, updateId: string): void {
  try {
    const transaction = store.read(updateId);
    if (transaction && !["failed", "rolled_back", "succeeded"].includes(transaction.phase)) {
      store.transition(updateId, "failed", { failureCategory: "migration_failed" });
    }
  } catch { /* The migration marker remains the recovery authority. */ }
}

/** Run the staged generation's registry after parking and before selection. */
export function prepareUpdateData(
  paths: LaserPaths,
  input: { updateId: string; targetGenerationId: string },
  sink?: MigrationEventSink,
  dependencies: { registry?: MigrationRegistry } = {},
): void {
  const store = new UpdateTransactionStore(paths.stateDir);
  let transaction = store.read(input.updateId);
  if (!transaction || transaction.targetGenerationId !== input.targetGenerationId) throw new MigrationActivationError(input.updateId, false);
  if (transaction.phase === "failed" || transaction.phase === "rolled_back") transaction = store.transition(input.updateId, "parking");
  if (transaction.phase === "staged") transaction = store.transition(input.updateId, "parking");
  if (transaction.phase === "selected") transaction = store.transition(input.updateId, "restarting");
  if (transaction.phase === "restarting") transaction = store.transition(input.updateId, "snapshotting");
  if (transaction.phase === "parking") transaction = store.transition(input.updateId, "snapshotting");
  if (!["snapshotting", "migrating", "ready"].includes(transaction.phase)) {
    if (transaction.phase !== "selected" && transaction.phase !== "restarting" && transaction.phase !== "succeeded") {
      throw new MigrationActivationError(input.updateId, false);
    }
    return;
  }
  emit(sink, input.updateId, "preparing");
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
    });
    engine.migrate(input);
    transaction = store.read(input.updateId)!;
    if (transaction.phase === "snapshotting") transaction = store.transition(input.updateId, "migrating");
    if (transaction.phase === "migrating") store.transition(input.updateId, "ready");
    emit(sink, input.updateId, "ready");
  } catch (error) {
    if (error instanceof MigrationActivationError) throw error;
    transitionToFailed(store, input.updateId);
    emit(sink, input.updateId, "failed");
    throw new MigrationActivationError(input.updateId, true, messageFor("failed"));
  }
}

export function restoreUpdateData(paths: LaserPaths, updateId: string, sink?: MigrationEventSink): void {
  const store = new UpdateTransactionStore(paths.stateDir);
  const transaction = store.read(updateId);
  if (!transaction) throw new MigrationActivationError(updateId, false);
  if (transaction.phase === "rolled_back") return;
  if (transaction.phase !== "restoring") store.transition(updateId, "restoring");
  emit(sink, updateId, "restoring");
  try {
    new MigrationEngine({ roots: roots(paths), registry: MIGRATION_REGISTRY }).restore(updateId);
    store.transition(updateId, "rolled_back");
    emit(sink, updateId, "restored");
  } catch {
    emit(sink, updateId, "failed");
    throw new MigrationActivationError(updateId, true, "The previous data snapshot could not be restored safely.");
  }
}

/** Create or recover the transaction used by a closed/headless update launch. */
export function ensureUpdateTransaction(paths: LaserPaths, manifest: RuntimeGenerationManifest): string {
  const pointer = readRuntimeGenerationPointer(paths.stateDir);
  if (!pointer) throw new MigrationActivationError(runtimeUpdateId(manifest), false);
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

export function migrationPhaseForState(phase: MigrationPhase): MigrationLaunchPhase {
  if (phase === "restoring") return "restoring";
  if (phase === "migrated") return "ready";
  return phase === "snapshotting" ? "preparing" : "migrating";
}
