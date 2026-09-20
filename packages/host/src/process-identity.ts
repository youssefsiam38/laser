/**
 * A string that identifies *this run* of a process, so a reused pid cannot be
 * mistaken for it. Used by host.json, retain leases, and store-lock recovery.
 *
 * Linux: the kernel's boot id plus field 22 of `/proc/<pid>/stat` (start time
 * in clock ticks since boot). Windows: the process creation timestamp from
 * CIM/Win32_Process. Elsewhere: `ps -o lstart=`. `undefined` when the
 * platform cannot supply one — callers then fail closed rather than treat a
 * pid as proof.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One parser of `/proc/<pid>/stat` after the last `)`, plus the boot id. */
export function parseLinuxProcessIdentity(bootId: string, stat: string): string | undefined {
  const trimmedBoot = bootId.trim();
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const after = stat.slice(close + 2).split(" ");
  const startTime = after[19]; // field 22 overall, 20th after the state field
  if (trimmedBoot && startTime) return `linux:${trimmedBoot}:${startTime}`;
  return undefined;
}

export function parseUnixPsIdentity(lstart: string): string | undefined {
  const trimmed = lstart.trim();
  return trimmed ? `ps:${trimmed}` : undefined;
}

/**
 * Windows CIM `CreationDate` is a DMTF datetime (`yyyymmddHHMMSS.mmmmmm±UUU`).
 * Localized `DateTime.ToString()` forms are refused: they are not a stable
 * identity across locales.
 */
export function parseWindowsCimCreationIdentity(output: string): string | undefined {
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const value = lines[lines.length - 1];
  if (!value) return undefined;
  if (/^\d{14}\.\d{6}[-+]\d{3}$/.test(value)) return `win:${value}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[-+]\d{2}:\d{2})?$/.test(value)) return `win:${value}`;
  return undefined;
}

function windowsIdentity(pid: number): string | undefined {
  const output = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "([string](Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $args[0])).CreationDate)",
    "-args",
    String(pid),
  ], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseWindowsCimCreationIdentity(output);
}

export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return parseLinuxProcessIdentity(bootId, stat);
    }
    if (process.platform === "win32") return windowsIdentity(pid);
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseUnixPsIdentity(lstart);
  } catch {
    return undefined;
  }
}
