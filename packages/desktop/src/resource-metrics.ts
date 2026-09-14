/**
 * Electron's own process metrics, for the host's cross-check (RP-1).
 *
 * The shell is the only party that can see `app.getAppMetrics()`, and the host
 * is the only party that owns the inventory. So the shell reports, the host
 * verifies and compares, and nothing else happens: there is no control verb
 * here, no path, no window title, no URL — a pid, Electron's own process type
 * and a working-set number.
 *
 * A working set is not private memory and is never treated as one; it exists
 * here to disagree with our own measurement when something is wrong.
 *
 * The report is sent when the shell connects and whenever the host asks
 * (`resource/refresh_request`, which it only sends after somebody asked for a
 * snapshot). Nothing polls: with diagnostics closed, this file is idle.
 */

/** The shape of `app.getAppMetrics()` we depend on, so tests need no Electron. */
export interface ElectronAppMetric {
  pid?: number;
  type?: string;
  memory?: { workingSetSize?: number; privateBytes?: number };
}

export interface DesktopResourceReport {
  at: string;
  main: { pid: number };
  processes: Array<{ pid: number; type: string; workingSetBytes?: number }>;
}

/** Rows one report carries, matching the protocol's own bound. */
export const DESKTOP_REPORT_PROCESS_MAX = 256;

/**
 * Build the report. Rows without a usable pid are dropped rather than guessed
 * at, and `workingSetSize` is KiB in Electron's API — converting it here means
 * the host compares bytes with bytes.
 */
export function electronProcessReport(
  metrics: readonly ElectronAppMetric[],
  options: { mainPid: number; now?: () => number } = { mainPid: process.pid },
): DesktopResourceReport {
  const now = options.now ?? Date.now;
  const processes: DesktopResourceReport["processes"] = [];
  for (const metric of metrics) {
    if (processes.length >= DESKTOP_REPORT_PROCESS_MAX) break;
    const pid = metric.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    const workingSetKb = metric.memory?.workingSetSize;
    processes.push({
      pid,
      type: typeof metric.type === "string" && metric.type ? metric.type : "Unknown",
      ...(typeof workingSetKb === "number" && Number.isFinite(workingSetKb) && workingSetKb >= 0
        ? { workingSetBytes: workingSetKb * 1024 }
        : {}),
    });
  }
  return { at: new Date(now()).toISOString(), main: { pid: options.mainPid }, processes };
}
