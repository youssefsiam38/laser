/**
 * Electron's own process metrics, for the host's cross-check (RP-1).
 *
 * The shell is the only party that can see `app.getAppMetrics()`, and the host
 * is the only party that owns the inventory. So the shell reports, the host
 * verifies against its own view of the machine and compares, and nothing else
 * happens: there is no control verb here, no path, no window title, no URL —
 * a pid, its creation time, Electron's own process type and a working set.
 *
 * `creationTime` is what makes a row provable. Without it a recycled renderer
 * pid could hand another process's metrics to a row that is not it, so the
 * host refuses any row it cannot tie to a process that started when the shell
 * says it did.
 *
 * A working set is not private memory and is never treated as one; it exists
 * here to disagree with the host's own measurement when something is wrong.
 *
 * The report is sent when the shell connects and whenever the host asks
 * (`resource/refresh_request`, which it only sends after somebody asked for a
 * snapshot). Nothing polls, and reporting costs the host nothing: it retains
 * the claim and checks it the next time somebody actually asks for a snapshot,
 * so a connection never turns into a walk of the machine's process table.
 */
import { RESOURCE_REPORT_PROCESS_MAX, type ResourceDesktopReport } from "@lasercode/protocol";

/** The shape of `app.getAppMetrics()` we depend on, so tests need no Electron. */
export interface ElectronAppMetric {
  pid?: number;
  type?: string;
  /** Milliseconds since the epoch, as Electron's `ProcessMetric` reports it. */
  creationTime?: number;
  memory?: { workingSetSize?: number; privateBytes?: number };
}

/**
 * Build the report. Rows without a usable pid are dropped rather than guessed
 * at, and `workingSetSize` is KiB in Electron's API — converting it here means
 * the host compares bytes with bytes.
 */
export function electronProcessReport(
  metrics: readonly ElectronAppMetric[],
  options: { mainPid: number; mainCreationTime?: number; now?: () => number },
): ResourceDesktopReport {
  const now = options.now ?? Date.now;
  const processes: ResourceDesktopReport["processes"] = [];
  for (const metric of metrics) {
    if (processes.length >= RESOURCE_REPORT_PROCESS_MAX) break;
    const pid = metric.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    const workingSetKb = metric.memory?.workingSetSize;
    processes.push({
      pid,
      type: typeof metric.type === "string" && metric.type ? metric.type : "Unknown",
      ...(typeof metric.creationTime === "number" && Number.isFinite(metric.creationTime) && metric.creationTime >= 0
        ? { creationTime: metric.creationTime }
        : {}),
      ...(typeof workingSetKb === "number" && Number.isFinite(workingSetKb) && workingSetKb >= 0
        ? { workingSetBytes: workingSetKb * 1024 }
        : {}),
    });
  }
  const mainCreationTime = options.mainCreationTime ?? metrics.find((metric) => metric.pid === options.mainPid)?.creationTime;
  return {
    at: new Date(now()).toISOString(),
    main: {
      pid: options.mainPid,
      ...(typeof mainCreationTime === "number" && Number.isFinite(mainCreationTime) ? { creationTime: mainCreationTime } : {}),
    },
    processes,
  };
}
