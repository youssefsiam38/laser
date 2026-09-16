import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNTIME_FAILURE_CATEGORIES, type RuntimeFailure, type WorkerMode } from "@lasercode/protocol";

const VERSION = 1;
const MAX_INCIDENTS = 64;
const MAX_MODES = 64;
const RETENTION_MS = 30 * 86_400_000;
const AUTOMATIC_RETRY_LIMIT = 2;

interface RepairIncident {
  fingerprint: string;
  cwdDigest: string;
  owner: RuntimeFailure["owner"]["kind"];
  category: RuntimeFailure["category"];
  generation: string;
  firstAt: string;
  lastAt: string;
  automaticAttempts: number;
  action: "observed" | "automatic_retry" | "try_again" | "safe_mode" | "normal_mode";
  outcome: "unresolved" | "healthy";
  launchId?: string;
}

interface ProjectMode {
  cwdDigest: string;
  mode: WorkerMode;
  updatedAt: string;
}

interface RepairState {
  version: typeof VERSION;
  incidents: RepairIncident[];
  modes: ProjectMode[];
}

const EMPTY = (): RepairState => ({ version: VERSION, incidents: [], modes: [] });

export interface AutomaticRepairDecision {
  allowed: boolean;
  attempts: number;
  paused: boolean;
}

/** Durable, bounded policy state. It never stores a project path or private log. */
export class RuntimeRepairLedger {
  private state = EMPTY();
  private corrupted = false;

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    this.load();
  }

  get automaticPaused(): boolean {
    return this.corrupted;
  }

  mode(cwd: string): WorkerMode {
    const digest = cwdDigest(cwd);
    return this.state.modes.find((row) => row.cwdDigest === digest)?.mode ?? "normal";
  }

  status(cwd: string, mode: WorkerMode): { state: "available" | "exhausted" | "paused"; automaticAttempts: number } {
    if (this.corrupted) return { state: "paused", automaticAttempts: 0 };
    const digest = cwdDigest(cwd);
    const attempts = this.state.incidents
      .filter((row) => row.cwdDigest === digest && row.generation === mode && row.outcome === "unresolved")
      .reduce((maximum, row) => Math.max(maximum, row.automaticAttempts), 0);
    return { state: attempts >= AUTOMATIC_RETRY_LIMIT ? "exhausted" : "available", automaticAttempts: attempts };
  }

  /** Person-authorized actions replace a corrupt ledger and never rewrite prefs. */
  authorize(cwd: string, mode: WorkerMode): void {
    if (this.corrupted) {
      this.state = EMPTY();
      this.corrupted = false;
    }
    const digest = cwdDigest(cwd);
    const at = this.now().toISOString();
    const existing = this.state.modes.find((row) => row.cwdDigest === digest);
    if (existing) Object.assign(existing, { mode, updatedAt: at });
    else this.state.modes.push({ cwdDigest: digest, mode, updatedAt: at });
    this.state.modes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.state.modes = this.state.modes.slice(0, MAX_MODES);
    for (const incident of this.state.incidents) {
      if (incident.cwdDigest !== digest || incident.outcome !== "unresolved") continue;
      incident.action = mode === "safe" ? "safe_mode" : incident.action === "safe_mode" ? "normal_mode" : "try_again";
      incident.lastAt = at;
    }
    this.persist();
  }

  noteFailure(cwd: string, mode: WorkerMode, failure: RuntimeFailure): void {
    if (this.corrupted) return;
    this.incident(cwd, mode, failure);
    this.persist();
  }

  automaticRetry(cwd: string, mode: WorkerMode, failure: RuntimeFailure): AutomaticRepairDecision {
    if (this.corrupted) return { allowed: false, attempts: 0, paused: true };
    const incident = this.incident(cwd, mode, failure);
    if (incident.automaticAttempts >= AUTOMATIC_RETRY_LIMIT) {
      this.persist();
      return { allowed: false, attempts: incident.automaticAttempts, paused: false };
    }
    incident.automaticAttempts += 1;
    incident.action = "automatic_retry";
    incident.lastAt = this.now().toISOString();
    this.persist();
    return { allowed: true, attempts: incident.automaticAttempts, paused: false };
  }

  markHealthy(cwd: string): void {
    if (this.corrupted) return;
    const digest = cwdDigest(cwd);
    const at = this.now().toISOString();
    let changed = false;
    for (const incident of this.state.incidents) {
      if (incident.cwdDigest !== digest || incident.outcome === "healthy") continue;
      incident.outcome = "healthy";
      incident.lastAt = at;
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Test/diagnostic projection; contains digests only. */
  snapshot(): Readonly<RepairState> {
    return structuredClone(this.state);
  }

  private incident(cwd: string, mode: WorkerMode, failure: RuntimeFailure): RepairIncident {
    this.prune();
    const digest = cwdDigest(cwd);
    const generation = mode;
    const fingerprint = createHash("sha256")
      .update(`${failure.owner.kind}\0${digest}\0${generation}\0${failure.category}`)
      .digest("hex");
    const at = this.now().toISOString();
    let incident = this.state.incidents.find((row) => row.fingerprint === fingerprint && row.outcome === "unresolved");
    if (!incident) {
      incident = {
        fingerprint,
        cwdDigest: digest,
        owner: failure.owner.kind,
        category: failure.category,
        generation,
        firstAt: at,
        lastAt: at,
        automaticAttempts: 0,
        action: "observed",
        outcome: "unresolved",
        ...((failure.owner.kind === "host" || failure.owner.kind === "worker") ? { launchId: failure.owner.launchId } : {}),
      };
      this.state.incidents.push(incident);
    } else {
      incident.lastAt = at;
      if (failure.owner.kind === "host" || failure.owner.kind === "worker") incident.launchId = failure.owner.launchId;
    }
    this.state.incidents.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    this.state.incidents = this.state.incidents.slice(0, MAX_INCIDENTS);
    return incident;
  }

  private prune(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    this.state.incidents = this.state.incidents
      .filter((row) => Date.parse(row.lastAt) >= cutoff)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, MAX_INCIDENTS);
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!validState(value)) throw new Error("invalid recovery record");
      this.state = value;
      this.prune();
    } catch {
      this.corrupted = true;
      try {
        const suffix = this.now().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
        renameSync(this.path, `${this.path}.corrupt-${suffix}`);
      } catch {
        // Preserve in place if it cannot be renamed; automation still pauses.
      }
    }
  }

  private persist(): void {
    if (this.corrupted) return;
    this.prune();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(this.path), `.${process.pid}.runtime-repair.tmp`);
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}

function cwdDigest(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

function validState(value: unknown): value is RepairState {
  const state = value as Partial<RepairState> | null;
  if (!state || typeof state !== "object" || state.version !== VERSION || !Array.isArray(state.incidents) || !Array.isArray(state.modes)) return false;
  return state.incidents.length <= MAX_INCIDENTS
    && state.modes.length <= MAX_MODES
    && state.incidents.every(validIncident)
    && state.modes.every((row) => row && /^[0-9a-f]{64}$/.test(row.cwdDigest) && (row.mode === "normal" || row.mode === "safe") && validDate(row.updatedAt));
}

function validIncident(row: unknown): row is RepairIncident {
  const incident = row as Partial<RepairIncident> | null;
  return Boolean(incident
    && /^[0-9a-f]{64}$/.test(incident.fingerprint ?? "")
    && /^[0-9a-f]{64}$/.test(incident.cwdDigest ?? "")
    && ["host", "worker", "module"].includes(incident.owner ?? "")
    && typeof incident.category === "string"
    && (RUNTIME_FAILURE_CATEGORIES as readonly string[]).includes(incident.category)
    && (incident.generation === "normal" || incident.generation === "safe")
    && validDate(incident.firstAt)
    && validDate(incident.lastAt)
    && Number.isInteger(incident.automaticAttempts)
    && (incident.automaticAttempts ?? -1) >= 0
    && ["observed", "automatic_retry", "try_again", "safe_mode", "normal_mode"].includes(incident.action ?? "")
    && (incident.outcome === "unresolved" || incident.outcome === "healthy")
    && (incident.launchId === undefined || /^[0-9a-f]{32}$/.test(incident.launchId)));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export const RUNTIME_REPAIR_LIMITS = {
  incidents: MAX_INCIDENTS,
  modes: MAX_MODES,
  retentionMs: RETENTION_MS,
  automaticRetries: AUTOMATIC_RETRY_LIMIT,
} as const;
