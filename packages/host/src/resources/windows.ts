/**
 * Windows collector: one PowerShell call, two CIM classes.
 *
 * `Win32_Process` gives structure, creation time (the identity token), working
 * set, peak working set, private commit (`PrivatePageCount`), CPU and I/O byte
 * counters. Private *working set* — the figure Task Manager shows and the one
 * RP-1 asks for — is not on that class, so it is joined from
 * `Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate`, which is keyed by
 * `IDProcess` and needs no localized counter names.
 *
 * `CommandLine` is never selected. The projection below is the complete list of
 * fields that leave PowerShell.
 */
import { resourceAvailable, resourceUnavailable, type ResourceMeasure } from "@lasercode/protocol";
import { executableLabel } from "./identity.js";
import {
  runCommand,
  unavailableMetrics,
  type CommandRunner,
  type ProcessCollector,
  type ProcessRowMetrics,
  type ProcessTableRow,
} from "./platform.js";

const SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,WorkingSetSize,PeakWorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount;",
  "$w = @();",
  "try { $w = Get-CimInstance Win32_PerfRawData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate } catch { };",
  "ConvertTo-Json -Depth 3 -Compress @{ processes = @($p); perf = @($w) }",
].join(" ");

export interface WindowsRow {
  pid: number;
  ppid?: number;
  startToken: string;
  label: string;
  workingSetBytes?: number;
  peakWorkingSetBytes?: number;
  privateWorkingSetBytes?: number;
  commitBytes?: number;
  cpuSeconds?: number;
  createdAtMs?: number;
  readBytes?: number;
  writeBytes?: number;
}

/**
 * CIM dates arrive as `/Date(1700000000000)/`, as a WMI datetime
 * (`20240102150405.123456+060`) or as ISO, depending on the serializer.
 */
export function parseCimDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const epoch = /\/Date\((-?\d+)\)\//.exec(value);
  if (epoch) return Number(epoch[1]);
  const wmi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(value);
  if (wmi) {
    const [, year, month, day, hour, minute, second, micro, offset] = wmi;
    const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Math.floor(Number(micro) / 1000));
    return utc - Number(offset) * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const numberOf = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

/** The PowerShell document → rows. Tolerates a missing perf class entirely. */
export function parseWindowsProcesses(json: string): WindowsRow[] {
  let document: { processes?: unknown[]; perf?: unknown[] };
  try {
    document = JSON.parse(json) as typeof document;
  } catch {
    return [];
  }
  const privateBySid = new Map<number, number>();
  for (const raw of document.perf ?? []) {
    const row = raw as Record<string, unknown>;
    const pid = numberOf(row.IDProcess);
    const bytes = numberOf(row.WorkingSetPrivate);
    if (pid !== undefined && bytes !== undefined) privateBySid.set(pid, bytes);
  }

  const rows: WindowsRow[] = [];
  for (const raw of document.processes ?? []) {
    const row = raw as Record<string, unknown>;
    const pid = numberOf(row.ProcessId);
    const createdAtMs = parseCimDate(row.CreationDate);
    if (pid === undefined || pid <= 0 || createdAtMs === undefined) continue;
    const kernel = numberOf(row.KernelModeTime) ?? 0;
    const user = numberOf(row.UserModeTime) ?? 0;
    const ppid = numberOf(row.ParentProcessId);
    const workingSetBytes = numberOf(row.WorkingSetSize);
    const peakWorkingSetKb = numberOf(row.PeakWorkingSetSize);
    const commitBytes = numberOf(row.PrivatePageCount);
    const readBytes = numberOf(row.ReadTransferCount);
    const writeBytes = numberOf(row.WriteTransferCount);
    const privateWorkingSetBytes = privateBySid.get(pid);
    rows.push({
      pid,
      ...(ppid !== undefined ? { ppid } : {}),
      startToken: `cim:${createdAtMs}`,
      label: executableLabel(typeof row.Name === "string" ? row.Name : undefined),
      ...(workingSetBytes !== undefined ? { workingSetBytes } : {}),
      ...(peakWorkingSetKb !== undefined ? { peakWorkingSetBytes: peakWorkingSetKb * 1024 } : {}),
      ...(privateWorkingSetBytes !== undefined ? { privateWorkingSetBytes } : {}),
      ...(commitBytes !== undefined ? { commitBytes } : {}),
      // 100-nanosecond units, the Win32 convention.
      cpuSeconds: (kernel + user) / 1e7,
      createdAtMs,
      ...(readBytes !== undefined ? { readBytes } : {}),
      ...(writeBytes !== undefined ? { writeBytes } : {}),
    });
  }
  return rows;
}

export class WindowsProcessCollector implements ProcessCollector {
  readonly name = "windows-cim";
  readonly source = "cim" as const;
  private rows = new Map<number, WindowsRow>();

  constructor(
    private readonly run: CommandRunner = runCommand,
    private readonly now: () => number = Date.now,
  ) {}

  async table(): Promise<ProcessTableRow[]> {
    const output = await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { timeoutMs: 8000 });
    const parsed = parseWindowsProcesses(output);
    this.rows = new Map(parsed.map((row) => [row.pid, row]));
    return parsed.map((row) => ({
      pid: row.pid,
      ...(row.ppid !== undefined ? { ppid: row.ppid } : {}),
      startToken: row.startToken,
      label: row.label,
    }));
  }

  async measure(row: ProcessTableRow): Promise<ProcessRowMetrics> {
    const cached = this.rows.get(row.pid);
    if (!cached || cached.startToken !== row.startToken) return unavailableMetrics("process_gone");
    const value = (bytes: number | undefined, detail: string): ResourceMeasure =>
      bytes === undefined ? resourceUnavailable("collector_failed", detail) : resourceAvailable(bytes);
    return {
      memory: {
        pss: resourceUnavailable("unsupported_platform", "proportional set size is a Linux counter"),
        resident: value(cached.workingSetBytes, "the working set was not reported"),
        peakResident: value(cached.peakWorkingSetBytes, "the peak working set was not reported"),
        privateResident: cached.privateWorkingSetBytes === undefined
          ? resourceUnavailable("permission_denied", "the process performance counters were not readable")
          : resourceAvailable(cached.privateWorkingSetBytes),
        commit: value(cached.commitBytes, "private commit was not reported"),
      },
      cpu: { seconds: value(cached.cpuSeconds, "processor time was not reported") },
      elapsedMs: cached.createdAtMs === undefined
        ? resourceUnavailable("collector_failed")
        : resourceAvailable(Math.max(0, this.now() - cached.createdAtMs)),
      io: {
        readBytes: value(cached.readBytes, "I/O counters were not reported"),
        writeBytes: value(cached.writeBytes, "I/O counters were not reported"),
      },
    };
  }
}
