/**
 * The collector seam.
 *
 * Discovery is two phases on purpose. `table()` is one cheap read of the whole
 * process table — enough to know who descends from whom — and `measure()` is
 * the expensive per-process part, run only for the rows that turned out to be
 * ours. A machine with two thousand processes therefore costs one read, not two
 * thousand.
 *
 * Every call is bounded: a command gets a timeout and a maximum output size,
 * and any failure becomes an `unavailable` measure or a health entry. A
 * collector may never throw into the host.
 */
import { execFile } from "node:child_process";
import {
  resourceUnavailable,
  type ResourceMeasure,
  type ResourceMeasurementSource,
  type ResourceProcessMemory,
} from "@lasercode/protocol";

/** One row of the process table: identity and structure, nothing measured yet. */
export interface ProcessTableRow {
  pid: number;
  ppid?: number;
  /** Identity of this run of the pid; the collector's own platform token. */
  startToken: string;
  /** Sanitized executable basename. Never argv. */
  label: string;
}

export interface ProcessRowMetrics {
  memory: ResourceProcessMemory;
  cpu: { seconds: ResourceMeasure };
  elapsedMs: ResourceMeasure;
  io: { readBytes: ResourceMeasure; writeBytes: ResourceMeasure };
}

export interface ProcessCollector {
  readonly name: string;
  readonly source: ResourceMeasurementSource;
  /** The whole table, once per snapshot. */
  table(): Promise<ProcessTableRow[]>;
  /** Numbers for one row. Never throws; missing counters come back unavailable. */
  measure(row: ProcessTableRow): Promise<ProcessRowMetrics>;
}

/** Every field unavailable for the same reason: the honest empty row. */
export function unavailableMetrics(reason: Parameters<typeof resourceUnavailable>[0], detail?: string): ProcessRowMetrics {
  const measure = (): ResourceMeasure => resourceUnavailable(reason, detail);
  return {
    memory: { pss: measure(), resident: measure(), peakResident: measure(), privateResident: measure(), commit: measure() },
    cpu: { seconds: measure() },
    elapsedMs: measure(),
    io: { readBytes: measure(), writeBytes: measure() },
  };
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export class CommandFailure extends Error {
  override readonly name = "CommandFailure";
}

/**
 * Run a diagnostic command and return its stdout. Bounded in time and size,
 * and the child is killed when either bound is hit, so a wedged `ps` cannot
 * hold a snapshot open or fill memory.
 */
export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<string> {
  const timeout = options.timeoutMs ?? 2000;
  const maxBuffer = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer, encoding: "utf8", killSignal: "SIGKILL", windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new CommandFailure(`${command} failed: ${error.message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export type CommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<string>;

/** `1.2G`, `345.6M`, `12K`, `900` → bytes. `undefined` when it is not a size. */
export function parseHumanSize(text: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KMGT])?B?$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2]?.toUpperCase();
  const scale = unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : unit === "T" ? 1024 ** 4 : 1;
  return value * scale;
}

/** `ps` elapsed (`dd-hh:mm:ss`, `hh:mm:ss`, `mm:ss`) → milliseconds. */
export function parseElapsed(text: string): number | undefined {
  const trimmed = text.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  const total = Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) ? total * 1000 : undefined;
}

/** `ps` cpu time (`mm:ss.ss`, `hh:mm:ss`) → seconds. */
export function parseCpuTime(text: string): number | undefined {
  const ms = parseElapsed(text);
  return ms === undefined ? undefined : ms / 1000;
}
