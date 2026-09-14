/**
 * Linux collector: `/proc`, and only the files that hold counters.
 *
 * Read: `stat` (parent, start time, cpu, executable name), `smaps_rollup`
 * (Pss, Private_Clean + Private_Dirty, Rss), `status` (VmHWM, VmRSS), `io`
 * (read_bytes, write_bytes), and the `exe` link's basename for a label.
 *
 * Not read, ever: `cmdline` and `environ`. The command line of a process is
 * where secrets live — a token passed as a flag, a password in a URL — and the
 * answer to that is not redaction, it is never opening the file.
 *
 * Every read is asynchronous. `/proc` is a virtual filesystem, but it is
 * backed by real kernel work, and a host that pauses its event loop to walk a
 * thousand processes has made a diagnostic into an outage.
 *
 * `procRoot` is injectable so the whole collector can be exercised against a
 * fixture tree, which is also how the PSS reconciliation test gets exact
 * expected numbers.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { resourceAvailable, resourceUnavailable, type ResourceMeasure } from "@lasercode/protocol";
import { commFromStat, executableLabel, ppidFromStat, startTicksFromStat } from "./identity.js";
import { unavailableMetrics, type ProcessCollector, type ProcessRowMetrics, type ProcessTableRow } from "./platform.js";

/** USER_HZ is fixed at 100 for userspace on Linux, whatever CONFIG_HZ is. */
const USER_HZ = 100;

export interface LinuxCollectorIo {
  procRoot?: string;
  readFile?: (path: string) => Promise<string>;
  readLink?: (path: string) => Promise<string>;
  readDir?: (path: string) => Promise<string[]>;
}

export class LinuxProcessCollector implements ProcessCollector {
  readonly name = "linux-proc";
  readonly source = "proc" as const;
  private readonly root: string;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly readLink: (path: string) => Promise<string>;
  private readonly readDir: (path: string) => Promise<string[]>;
  private bootId: string | undefined;
  private bootTimeMs: number | undefined;
  private uptimeSeconds: number | undefined;

  constructor(io: LinuxCollectorIo = {}) {
    this.root = io.procRoot ?? "/proc";
    this.readFile = io.readFile ?? ((path) => readFile(path, "utf8"));
    this.readLink = io.readLink ?? ((path) => readlink(path));
    this.readDir = io.readDir ?? ((path) => readdir(path));
  }

  async table(): Promise<ProcessTableRow[]> {
    this.bootId = (await this.read(`${this.root}/sys/kernel/random/boot_id`))?.trim();
    this.uptimeSeconds = Number((await this.read(`${this.root}/uptime`))?.split(" ")[0] ?? NaN);
    this.bootTimeMs = this.parseBootTime(await this.read(`${this.root}/stat`));

    const entries = (await this.readDir(this.root).catch(() => [] as string[])).filter((entry) => /^\d+$/.test(entry));
    const rows = await Promise.all(entries.map((entry) => this.rowOf(Number(entry))));
    return rows.filter((row): row is ProcessTableRow => row !== undefined);
  }

  async measure(row: ProcessTableRow): Promise<ProcessRowMetrics> {
    const stat = await this.read(`${this.root}/${row.pid}/stat`);
    if (!stat) return unavailableMetrics("process_gone");
    // The pid was reused between the table read and now: measuring it would
    // attach a stranger's numbers to our row.
    const ticks = startTicksFromStat(stat);
    if (!ticks || !row.startToken.endsWith(`:${ticks}`)) return unavailableMetrics("process_gone");

    const [rollupText, statusText, ioText] = await Promise.all([
      this.read(`${this.root}/${row.pid}/smaps_rollup`),
      this.read(`${this.root}/${row.pid}/status`),
      this.read(`${this.root}/${row.pid}/io`),
    ]);
    const rollup = this.parseKeyedKb(rollupText);
    const status = this.parseKeyedKb(statusText);
    const io = this.parseIo(ioText);
    const rollupMissing = rollup === undefined;

    const privateBytes = rollup && (rollup.Private_Clean !== undefined || rollup.Private_Dirty !== undefined)
      ? (rollup.Private_Clean ?? 0) + (rollup.Private_Dirty ?? 0)
      : undefined;

    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const startTicks = Number(ticks);
    const cpuSeconds = Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / USER_HZ : undefined;
    const elapsedMs = Number.isFinite(this.uptimeSeconds) && Number.isFinite(startTicks)
      ? Math.max(0, (this.uptimeSeconds! - startTicks / USER_HZ) * 1000)
      : undefined;

    return {
      memory: {
        pss: bytes(rollup?.Pss, rollupMissing ? "permission_denied" : "collector_failed"),
        resident: bytes(rollup?.Rss ?? status?.VmRSS, "collector_failed"),
        peakResident: bytes(status?.VmHWM, "collector_failed"),
        privateResident: bytes(privateBytes, rollupMissing ? "permission_denied" : "collector_failed"),
        // Windows' private commit has no Linux equivalent worth pretending about.
        commit: resourceUnavailable("unsupported_platform", "private commit is a Windows counter"),
      },
      cpu: { seconds: cpuSeconds === undefined ? resourceUnavailable("collector_failed") : resourceAvailable(cpuSeconds) },
      elapsedMs: elapsedMs === undefined ? resourceUnavailable("collector_failed") : resourceAvailable(elapsedMs),
      io: {
        readBytes: bytes(io?.read, "permission_denied", true),
        writeBytes: bytes(io?.write, "permission_denied", true),
      },
    };
  }

  private async rowOf(pid: number): Promise<ProcessTableRow | undefined> {
    const stat = await this.read(`${this.root}/${pid}/stat`);
    if (!stat) return undefined; // It ended while we were looking at it. Normal.
    const ticks = startTicksFromStat(stat);
    if (!ticks || !this.bootId) return undefined; // No provable identity: no row.
    const ppid = ppidFromStat(stat);
    const startedAtMs = this.bootTimeMs === undefined ? undefined : this.bootTimeMs + (Number(ticks) / USER_HZ) * 1000;
    return {
      pid,
      ...(ppid !== undefined ? { ppid } : {}),
      startToken: `linux:${this.bootId}:${ticks}`,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      label: await this.labelOf(pid, stat),
    };
  }

  private async labelOf(pid: number, stat: string): Promise<string> {
    try {
      return executableLabel(await this.readLink(`${this.root}/${pid}/exe`));
    } catch {
      // `exe` needs the same user or CAP_SYS_PTRACE; `comm` is the kernel's own
      // name for the executable and is always readable. Neither is argv.
      return executableLabel(commFromStat(stat));
    }
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      return await this.readFile(path);
    } catch {
      return undefined;
    }
  }

  /** `btime <seconds since epoch>` from `/proc/stat`, for absolute start times. */
  private parseBootTime(text: string | undefined): number | undefined {
    if (text === undefined) return undefined;
    const match = /^btime\s+(\d+)$/m.exec(text);
    return match ? Number(match[1]) * 1000 : undefined;
  }

  /** `Pss:  1234 kB` lines → bytes, keyed by name. */
  private parseKeyedKb(text: string | undefined): Record<string, number> | undefined {
    if (text === undefined) return undefined;
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Za-z_]+):\s+(\d+)\s*kB$/.exec(line.trim());
      if (match) out[match[1]!] = Number(match[2]) * 1024;
    }
    return out;
  }

  private parseIo(text: string | undefined): { read?: number; write?: number } | undefined {
    if (text === undefined) return undefined;
    const out: { read?: number; write?: number } = {};
    for (const line of text.split("\n")) {
      const match = /^(read_bytes|write_bytes):\s+(\d+)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === "read_bytes") out.read = Number(match[2]);
      else out.write = Number(match[2]);
    }
    return out;
  }
}

function bytes(value: number | undefined, reason: "collector_failed" | "permission_denied", ioCounter = false): ResourceMeasure {
  if (value === undefined || !Number.isFinite(value)) {
    return resourceUnavailable(reason, ioCounter ? "the kernel refused this process's I/O counters" : undefined);
  }
  return resourceAvailable(value);
}
