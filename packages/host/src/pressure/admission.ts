import {
  aggregateMemoryPressureLevel,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureRefusal,
} from "@lasercode/protocol";

const MIB = 1024 * 1024;
const WORKER_RESERVATION_BYTES = 1280 * MIB;
const SYSTEM_RESERVATION_BYTES = 2048 * MIB;
const REFUSAL_COALESCE_MS = 5_000;

export type HostAdmissionRefusal = Extract<
  MemoryPressureRefusal,
  "speculative_worker" | "whole_transcript" | "worker_free_full_read" | "new_project_worker"
>;

export interface PressureAdmissionDeps {
  /** Settled host+machine decision. */
  hostLevel(): MemoryPressureLevelState;
  /** Fresh exact-generation worker evidence, globally or for one project. */
  workerLevel(cwd?: string): MemoryPressureLevelState;
  /** True only when MemAvailable was actually measured. */
  machineAvailabilityKnown(): boolean;
  /** Static machine capacity. Invalid/zero readings make the fallback inert. */
  totalMemoryBytes(): number;
  /** Alive or starting worker processes, including warm workers. */
  reservedWorkerCount(): number;
  now?: () => number;
  onRefusal?(event: { refusal: HostAdmissionRefusal; level: MemoryPressureLevel; cwd?: string }): void;
  onSuppressed?(refusal: HostAdmissionRefusal): void;
}

export interface PressureAdmission {
  /** Pure policy read apart from bounded refusal accounting when it declines. */
  admits(refusal: HostAdmissionRefusal, cwd?: string): boolean;
  /** Current policy set, without recording a refusal. */
  refusing(): HostAdmissionRefusal[];
}

const THRESHOLD: Record<HostAdmissionRefusal, MemoryPressureLevel> = {
  speculative_worker: "warning",
  whole_transcript: "warning",
  worker_free_full_read: "critical",
  new_project_worker: "critical",
};

const WORKER_CREATION = new Set<HostAdmissionRefusal>(["speculative_worker", "new_project_worker"]);
const PATH_SCOPED = new Set<HostAdmissionRefusal>(["whole_transcript", "worker_free_full_read"]);
const ORDER: readonly HostAdmissionRefusal[] = [
  "whole_transcript",
  "speculative_worker",
  "new_project_worker",
  "worker_free_full_read",
];

function reaches(level: MemoryPressureLevelState, threshold: MemoryPressureLevel): boolean {
  if (level === "unknown" || level === "normal") return false;
  return level === "critical" || threshold === "warning";
}

/** Cross-platform admission fallback used only when MemAvailable is unavailable. */
export function workerReservationWouldOverflow(totalMemoryBytes: number, reservedWorkerCount: number): boolean {
  if (!Number.isSafeInteger(totalMemoryBytes) || totalMemoryBytes <= 0) return false;
  if (!Number.isSafeInteger(reservedWorkerCount) || reservedWorkerCount < 0) return false;
  const budget = Math.min(
    Math.max(0, totalMemoryBytes - SYSTEM_RESERVATION_BYTES),
    Math.floor(totalMemoryBytes * 0.5),
  );
  const reserved = reservedWorkerCount * WORKER_RESERVATION_BYTES;
  return reserved + WORKER_RESERVATION_BYTES > budget;
}

export function createPressureAdmission(deps: PressureAdmissionDeps): PressureAdmission {
  const now = deps.now ?? Date.now;
  const lastRecorded = new Map<HostAdmissionRefusal, number>();

  const decision = (refusal: HostAdmissionRefusal, cwd?: string): { refused: boolean; level: MemoryPressureLevelState } => {
    const threshold = THRESHOLD[refusal];
    if (WORKER_CREATION.has(refusal) && !deps.machineAvailabilityKnown()) {
      const refused = workerReservationWouldOverflow(deps.totalMemoryBytes(), deps.reservedWorkerCount());
      return { refused, level: refused ? threshold : "unknown" };
    }
    const level = aggregateMemoryPressureLevel([
      deps.hostLevel(),
      deps.workerLevel(PATH_SCOPED.has(refusal) ? cwd : undefined),
    ]);
    return { refused: reaches(level, threshold), level };
  };

  return {
    admits(refusal, cwd) {
      const result = decision(refusal, cwd);
      if (!result.refused) return true;
      const at = now();
      const previous = lastRecorded.get(refusal);
      if (previous !== undefined && at - previous < REFUSAL_COALESCE_MS) {
        deps.onSuppressed?.(refusal);
        return false;
      }
      lastRecorded.set(refusal, at);
      deps.onRefusal?.({
        refusal,
        level: result.level === "warning" || result.level === "critical" ? result.level : THRESHOLD[refusal],
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return false;
    },
    refusing() {
      return ORDER.filter((refusal) => decision(refusal).refused);
    },
  };
}
