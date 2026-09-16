import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeGenerationError } from "./runtime-generation.js";

export const UPDATE_TRANSACTION_PHASES = [
  "discovered", "staging", "staged", "parking", "snapshotting", "migrating", "ready",
  "selected", "restarting", "succeeded", "failed", "restoring", "rolled_back",
] as const;
export type UpdateTransactionPhase = (typeof UPDATE_TRANSACTION_PHASES)[number];

export interface UpdateTransaction {
  schemaVersion: 1;
  updateId: string;
  phase: UpdateTransactionPhase;
  targetGenerationId: string;
  previousGenerationId: string;
  targetVersion: string;
  buildIdentity: string;
  manifestDigest: string;
  updatedAt: string;
  failureCategory?: string;
  selectedLaunchId?: string;
  selectedVersion?: string;
}

const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;

const ALLOWED: Readonly<Record<UpdateTransactionPhase, readonly UpdateTransactionPhase[]>> = {
  discovered: ["staging", "failed"],
  staging: ["staged", "failed"],
  staged: ["parking", "failed"],
  parking: ["staged", "snapshotting", "ready", "failed"],
  snapshotting: ["migrating", "failed", "restoring"],
  migrating: ["ready", "failed", "restoring"],
  ready: ["selected", "failed"],
  selected: ["restarting", "failed", "restoring"],
  restarting: ["succeeded", "failed", "restoring"],
  succeeded: [],
  failed: ["parking", "restoring", "rolled_back"],
  restoring: ["rolled_back", "failed"],
  rolled_back: ["parking"],
};

export class UpdateTransactionStore {
  constructor(private readonly stateDir: string, private readonly now: () => Date = () => new Date()) {}

  begin(input: Omit<UpdateTransaction, "schemaVersion" | "phase" | "updatedAt">): UpdateTransaction {
    this.validateBase(input);
    const existing = this.read(input.updateId);
    if (existing) {
      if (existing.targetGenerationId !== input.targetGenerationId
        || existing.targetVersion !== input.targetVersion
        || existing.buildIdentity !== input.buildIdentity
        || existing.manifestDigest !== input.manifestDigest) throw new RuntimeGenerationError("corrupt");
      return existing;
    }
    const transaction: UpdateTransaction = {
      schemaVersion: 1,
      phase: "discovered",
      updatedAt: this.now().toISOString(),
      ...input,
    };
    this.write(transaction);
    return transaction;
  }

  read(updateId: string): UpdateTransaction | undefined {
    if (!HASH.test(updateId)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.path(updateId), "utf8")) as Partial<UpdateTransaction>;
      this.validate(value);
      return value as UpdateTransaction;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof RuntimeGenerationError) throw error;
      throw new RuntimeGenerationError("corrupt");
    }
  }

  transition(updateId: string, phase: UpdateTransactionPhase, patch: {
    failureCategory?: string;
    selectedLaunchId?: string;
    selectedVersion?: string;
  } = {}): UpdateTransaction {
    const current = this.read(updateId);
    if (!current) throw new RuntimeGenerationError("missing");
    if (phase !== current.phase && !ALLOWED[current.phase].includes(phase)) throw new RuntimeGenerationError("corrupt");
    if (patch.failureCategory !== undefined && !CATEGORY.test(patch.failureCategory)) throw new RuntimeGenerationError("corrupt");
    if (patch.selectedLaunchId !== undefined && !/^[0-9a-f]{32}$/.test(patch.selectedLaunchId)) throw new RuntimeGenerationError("corrupt");
    if (patch.selectedVersion !== undefined && !VERSION.test(patch.selectedVersion)) throw new RuntimeGenerationError("corrupt");
    if (phase === "succeeded") {
      const launchId = patch.selectedLaunchId ?? current.selectedLaunchId;
      const version = patch.selectedVersion ?? current.selectedVersion;
      if (!launchId || version !== current.targetVersion) throw new RuntimeGenerationError("corrupt");
    }
    const next: UpdateTransaction = {
      ...current,
      phase,
      updatedAt: this.now().toISOString(),
      ...patch,
    };
    this.write(next);
    return next;
  }

  private path(updateId: string): string {
    return join(this.stateDir, "update-transactions", `${updateId}.json`);
  }

  private validateBase(value: Partial<UpdateTransaction>): void {
    if (!HASH.test(value.updateId ?? "")
      || !HASH.test(value.targetGenerationId ?? "")
      || !HASH.test(value.previousGenerationId ?? "")
      || !VERSION.test(value.targetVersion ?? "")
      || typeof value.buildIdentity !== "string" || value.buildIdentity.length < 1 || value.buildIdentity.length > 200
      || !HASH.test(value.manifestDigest ?? "")) throw new RuntimeGenerationError("corrupt");
  }

  private validate(value: Partial<UpdateTransaction>): void {
    this.validateBase(value);
    if (value.schemaVersion !== 1
      || !UPDATE_TRANSACTION_PHASES.includes(value.phase as UpdateTransactionPhase)
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
      || (value.failureCategory !== undefined && !CATEGORY.test(value.failureCategory))
      || (value.selectedLaunchId !== undefined && !/^[0-9a-f]{32}$/.test(value.selectedLaunchId))
      || (value.selectedVersion !== undefined && !VERSION.test(value.selectedVersion))) throw new RuntimeGenerationError("corrupt");
  }

  private write(transaction: UpdateTransaction): void {
    const path = this.path(transaction.updateId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Windows cannot fsync a directory. */ }
  }
}
