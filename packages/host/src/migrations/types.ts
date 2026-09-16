export type MigrationRootLabel = "stateDir" | "agentDir" | "sessionDir";
export type MigrationUnitType = "file" | "directory";

export interface MigrationUnit {
  root: MigrationRootLabel;
  /** POSIX-style relative path below the declared root. */
  path: string;
  type: MigrationUnitType;
}

export interface MigrationContext {
  readFile(unit: MigrationUnit): Buffer;
  writeFile(unit: MigrationUnit, bytes: string | Uint8Array, mode?: number): void;
  readDirectory(unit: MigrationUnit): ReadonlyMap<string, Buffer>;
  replaceDirectory(unit: MigrationUnit, files: ReadonlyMap<string, string | Uint8Array>, mode?: number): void;
}

export interface MigrationStep {
  id: string;
  fromSchema: number;
  toSchema: number;
  /** Every persistent unit this idempotent step may mutate. */
  units: readonly MigrationUnit[];
  run(context: MigrationContext): void;
}

export interface MigrationRegistry {
  /** Schema expected by the staged generation declaring this registry. */
  targetSchema: number;
  steps: readonly MigrationStep[];
}

export interface SnapshotUnitManifest extends MigrationUnit {
  mode: number;
  length: number;
  sha256: string;
}

export interface MigrationSnapshotManifest {
  schemaVersion: 1;
  updateId: string;
  fromSchema: number;
  targetSchema: number;
  units: SnapshotUnitManifest[];
}

export type MigrationPhase = "snapshotting" | "migrating" | "migrated" | "restoring";

export interface MigrationState {
  schemaVersion: 1;
  updateId: string;
  phase: MigrationPhase;
  fromSchema: number;
  targetSchema: number;
  targetGenerationId: string;
  snapshotDigest?: string;
  stepIndex: number;
  restoreIndex: number;
  schemaFileExisted: boolean;
  updatedAt: string;
  failureCategory?: "snapshot" | "migration" | "restore" | "target";
  /** Exact host launch permitted to bind while this migrated marker remains. */
  launchAttemptId?: string;
}

export type MigrationBoundary = "copy" | "hash" | "marker" | "step" | "rename";

export interface MigrationRoots {
  stateDir: string;
  agentDir: string;
  sessionDir: string;
}

export interface MigrationEngineOptions {
  roots: MigrationRoots;
  registry: MigrationRegistry;
  /** Test-only fault seam. Production leaves it absent. */
  boundary?: (boundary: MigrationBoundary, detail: string) => void;
  onState?: (state: MigrationState) => void;
  onProgress?: (progress: { phase: "snapshotting" | "restoring"; completed: number; total: number }) => void;
  now?: () => Date;
}

export type MigrationRecoveryResult =
  | { status: "none" }
  | { status: "migrated"; state: MigrationState }
  | { status: "restored"; state: MigrationState };
