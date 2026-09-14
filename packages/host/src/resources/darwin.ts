/**
 * macOS collector: `ps` for the table, `vmmap --summary` for the figure that
 * actually means something on this platform.
 *
 * `ps` gives structure, start time (which is also the identity token), RSS,
 * elapsed and CPU in two bounded calls. RSS on macOS is not private memory, so
 * the private/physical figure comes from `vmmap --summary`'s "Physical
 * footprint" — best effort, per process, capped per snapshot so a wide tree
 * cannot turn one question into a hundred subprocesses. A refusal (another
 * user's process, a hardened binary) is `permission_denied`, not a zero.
 *
 * `ps -o comm=` prints the executable path; only its sanitized basename is
 * kept. No `ps -o args=`, ever: that is argv.
 */
import {
  resourceAvailable,
  resourceUnavailable,
  type ResourceMeasure,
} from "@lasercode/protocol";
import { executableLabel } from "./identity.js";
import {
  parseCpuTime,
  parseElapsed,
  parseHumanSize,
  runCommand,
  unavailableMetrics,
  type CommandRunner,
  type ProcessCollector,
  type ProcessRowMetrics,
  type ProcessTableRow,
} from "./platform.js";

/** `vmmap` calls one snapshot may make. Beyond it, rows say `not_collected`. */
export const DARWIN_FOOTPRINT_BUDGET = 32;

export interface DarwinPsRow {
  pid: number;
  ppid: number;
  residentBytes?: number;
  elapsedMs?: number;
  cpuSeconds?: number;
  startToken: string;
}

/** `pid ppid rss etime time lstart…` — `lstart` has spaces, so it comes last. */
export function parsePsTable(text: string): DarwinPsRow[] {
  const rows: DarwinPsRow[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    const rssKb = Number(parts[2]);
    const elapsedMs = parseElapsed(parts[3] ?? "");
    const cpuSeconds = parseCpuTime(parts[4] ?? "");
    const lstart = parts.slice(5).join(" ");
    if (!lstart) continue;
    rows.push({
      pid,
      ppid,
      ...(Number.isFinite(rssKb) ? { residentBytes: rssKb * 1024 } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(cpuSeconds !== undefined ? { cpuSeconds } : {}),
      startToken: `ps:${lstart}`,
    });
  }
  return rows;
}

/** `pid /path/to/Executable` → pid → sanitized basename. */
export function parsePsCommands(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, executableLabel(trimmed.slice(space + 1)));
  }
  return out;
}

export function parseVmmapSummary(text: string): { footprintBytes?: number; peakFootprintBytes?: number } {
  const out: { footprintBytes?: number; peakFootprintBytes?: number } = {};
  for (const line of text.split("\n")) {
    const peak = /^Physical footprint \(peak\):\s+(\S+)/.exec(line.trim());
    if (peak) {
      const value = parseHumanSize(peak[1]!);
      if (value !== undefined) out.peakFootprintBytes = value;
      continue;
    }
    const current = /^Physical footprint:\s+(\S+)/.exec(line.trim());
    if (current) {
      const value = parseHumanSize(current[1]!);
      if (value !== undefined) out.footprintBytes = value;
    }
  }
  return out;
}

export class DarwinProcessCollector implements ProcessCollector {
  readonly name = "darwin-ps";
  readonly source = "ps" as const;
  private readonly run: CommandRunner;
  private rows = new Map<number, DarwinPsRow>();
  private budget = DARWIN_FOOTPRINT_BUDGET;

  constructor(run: CommandRunner = runCommand) {
    this.run = run;
  }

  async table(): Promise<ProcessTableRow[]> {
    this.budget = DARWIN_FOOTPRINT_BUDGET;
    const [table, commands] = await Promise.all([
      this.run("ps", ["-axo", "pid=,ppid=,rss=,etime=,time=,lstart="]),
      this.run("ps", ["-axo", "pid=,comm="]).catch(() => ""),
    ]);
    const parsed = parsePsTable(table);
    const labels = parsePsCommands(commands);
    this.rows = new Map(parsed.map((row) => [row.pid, row]));
    return parsed.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      startToken: row.startToken,
      label: labels.get(row.pid) ?? "unknown",
    }));
  }

  async measure(row: ProcessTableRow): Promise<ProcessRowMetrics> {
    const cached = this.rows.get(row.pid);
    if (!cached || cached.startToken !== row.startToken) return unavailableMetrics("process_gone");

    let footprint: ResourceMeasure = resourceUnavailable("not_collected", "the per-snapshot footprint budget was reached");
    let peak: ResourceMeasure = resourceUnavailable("not_collected", "the per-snapshot footprint budget was reached");
    if (this.budget > 0) {
      this.budget -= 1;
      try {
        const summary = parseVmmapSummary(await this.run("vmmap", ["--summary", String(row.pid)], { timeoutMs: 1500 }));
        footprint = summary.footprintBytes === undefined
          ? resourceUnavailable("collector_failed", "vmmap reported no physical footprint")
          : resourceAvailable(summary.footprintBytes);
        peak = summary.peakFootprintBytes === undefined
          ? resourceUnavailable("collector_failed", "vmmap reported no peak footprint")
          : resourceAvailable(summary.peakFootprintBytes);
      } catch {
        footprint = resourceUnavailable("permission_denied", "vmmap could not read this process");
        peak = resourceUnavailable("permission_denied", "vmmap could not read this process");
      }
    }

    return {
      memory: {
        pss: resourceUnavailable("unsupported_platform", "proportional set size is a Linux counter"),
        resident: cached.residentBytes === undefined ? resourceUnavailable("collector_failed") : resourceAvailable(cached.residentBytes),
        // `ps` has no high-water mark; vmmap's peak footprint is the closest
        // true statement, and it is peak *private*, which is what matters.
        peakResident: peak,
        privateResident: footprint,
        commit: resourceUnavailable("unsupported_platform", "private commit is a Windows counter"),
      },
      cpu: { seconds: cached.cpuSeconds === undefined ? resourceUnavailable("collector_failed") : resourceAvailable(cached.cpuSeconds) },
      elapsedMs: cached.elapsedMs === undefined ? resourceUnavailable("collector_failed") : resourceAvailable(cached.elapsedMs),
      io: {
        readBytes: resourceUnavailable("unsupported_platform", "macOS exposes no per-process I/O byte counters to us"),
        writeBytes: resourceUnavailable("unsupported_platform", "macOS exposes no per-process I/O byte counters to us"),
      },
    };
  }
}
