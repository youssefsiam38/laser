import { totalmem } from "node:os";

const MIB = 1024 * 1024;
const OLD_SPACE_QUANTUM_MIB = 64;

export const HOST_OLD_SPACE_FLOOR_MIB = 448;
export const HOST_OLD_SPACE_CAP_MIB = 448;
export const WORKER_OLD_SPACE_FLOOR_MIB = 1728;
export const WORKER_OLD_SPACE_CAP_MIB = 2048;

export type HeapCeilingRole = "host" | "project_worker";

export class HeapCeilingCapacityError extends Error {
  override readonly name = "HeapCeilingCapacityError";

  constructor(
    readonly role: HeapCeilingRole,
    readonly capacityBytes: number,
    readonly requiredBytes: number,
  ) {
    const label = role === "host" ? "agent host" : "project agent";
    super(
      `The ${label} needs at least ${requiredBytes / MIB} MiB of runtime-reported memory, ` +
        `but this environment reports ${Math.floor(capacityBytes / MIB)} MiB. ` +
        "Use an environment with a larger memory limit.",
    );
  }
}

function validCapacity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The process-wide capacity reported by the runtime.
 *
 * A cgroup/job limit is stronger evidence than physical RAM, so when Node can
 * read both the smaller positive integer wins. Zero and malformed readings are
 * absence, never a machine with zero bytes.
 */
export function runtimeMemoryCapacityBytes(
  physicalBytes: unknown = totalmem(),
  constrainedBytes: unknown = process.constrainedMemory?.(),
): number | undefined {
  const readings = [physicalBytes, constrainedBytes].filter(validCapacity);
  return readings.length > 0 ? Math.min(...readings) : undefined;
}

/** Derive the explicit old-space request. Unknown capacity uses the safe floor. */
export function oldSpaceMiBFor(role: HeapCeilingRole, capacityBytes?: number): number {
  const floor = role === "host" ? HOST_OLD_SPACE_FLOOR_MIB : WORKER_OLD_SPACE_FLOOR_MIB;
  const cap = role === "host" ? HOST_OLD_SPACE_CAP_MIB : WORKER_OLD_SPACE_CAP_MIB;
  if (capacityBytes === undefined) return floor;
  if (!validCapacity(capacityBytes)) return floor;

  const roundedCapacityMiB = Math.floor(capacityBytes / MIB / OLD_SPACE_QUANTUM_MIB) * OLD_SPACE_QUANTUM_MIB;
  if (roundedCapacityMiB < floor) {
    throw new HeapCeilingCapacityError(role, capacityBytes, floor * MIB);
  }
  return Math.min(cap, roundedCapacityMiB);
}

export function hostOldSpaceMiB(capacityBytes = runtimeMemoryCapacityBytes()): number {
  return oldSpaceMiBFor("host", capacityBytes);
}

export function workerOldSpaceMiB(capacityBytes = runtimeMemoryCapacityBytes()): number {
  return oldSpaceMiBFor("project_worker", capacityBytes);
}

export function oldSpaceSizeFlag(oldSpaceMiB: number): string {
  if (!Number.isSafeInteger(oldSpaceMiB) || oldSpaceMiB <= 0) {
    throw new TypeError("old-space size must be a positive integer number of MiB");
  }
  return `--max-old-space-size=${oldSpaceMiB}`;
}

export function oldSpaceBytes(oldSpaceMiB: number): number {
  oldSpaceSizeFlag(oldSpaceMiB);
  const bytes = oldSpaceMiB * MIB;
  if (!Number.isSafeInteger(bytes)) throw new TypeError("old-space size is too large");
  return bytes;
}

/**
 * Read only an explicit Node old-space flag. V8's measured heap limit is a
 * different fact and must never be reverse-engineered into configuration.
 */
export function configuredOldSpaceBytes(execArgv: readonly string[]): number | undefined {
  let raw: string | undefined;
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index]!;
    if (value === "--max-old-space-size") {
      raw = execArgv[index + 1];
      index += 1;
      continue;
    }
    if (value.startsWith("--max-old-space-size=")) raw = value.slice("--max-old-space-size=".length);
  }
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const mib = Number(raw);
  if (!Number.isSafeInteger(mib)) return undefined;
  try {
    return oldSpaceBytes(mib);
  } catch {
    return undefined;
  }
}
