/**
 * Tracking the running host.
 *
 * `<state-dir>/host.json` is the pidfile and the port file in one
 * record. It is advisory: the authority on "is a host running" is always an
 * answer from `GET /healthz`, because a pid can be reused and a file can
 * outlive a machine crash. The record only tells us *where* to look.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import type { PiorbitPaths } from "./config.js";

export interface HostRecord {
  pid: number;
  host: string;
  port: number;
  url: string;
  agentDir: string;
  sessionDir: string;
  stateDir: string;
  subagentsTempRoot: string;
  startedAt: string;
  /** Version of the CLI that started it, so a stale daemon is identifiable. */
  cliVersion: string;
  /**
   * An identity for the *process*, not just its number: the machine's boot id
   * plus the process's own start time. A pid is reused, and this file outlives
   * a crash or a power cut, so without this `piorbit down` could SIGTERM and
   * then SIGKILL whatever program happened to inherit pid 4242 after a reboot.
   * Absent when the platform cannot supply one (see `processIdentity`).
   */
  identity?: string;
}

export type HostStatus =
  /** Answering on /healthz. The only state where session verbs will work. */
  | { state: "running"; record: HostRecord }
  /** No record, or a record whose process is gone (the file is removed). */
  | { state: "stopped"; removedStaleRecord: boolean }
  /** The process is alive but the port does not answer: starting, or wedged. */
  | { state: "unreachable"; record: HostRecord; reason: string };

export function readHostFile(path: string): HostRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HostRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number" || typeof parsed.host !== "string") {
      return undefined;
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      url: parsed.url ?? `http://${parsed.host}:${parsed.port}`,
      agentDir: parsed.agentDir ?? "",
      sessionDir: parsed.sessionDir ?? "",
      stateDir: parsed.stateDir ?? "",
      subagentsTempRoot: parsed.subagentsTempRoot ?? "",
      startedAt: parsed.startedAt ?? "",
      cliVersion: parsed.cliVersion ?? "unknown",
      ...(typeof parsed.identity === "string" ? { identity: parsed.identity } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Write via a temp file and rename, so a reader never sees half a record. */
export function writeHostFile(path: string, record: HostRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.host.${process.pid}.json`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearHostFile(path: string): void {
  rmSync(path, { force: true });
}

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

/**
 * A string that identifies *this run* of a process, so a reused pid cannot be
 * mistaken for it.
 *
 * Linux: the kernel's boot id (a new one per boot) plus field 22 of
 * `/proc/<pid>/stat`, the process start time in clock ticks since boot.
 * Elsewhere: `ps -o lstart=`, which is the start wall-clock time.
 * `undefined` when neither is available — the caller then falls back to the
 * older, weaker "is anything alive at this pid" test and refuses to signal.
 */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field can contain spaces and parentheses, so parse from the
      // last ')' — every field after it is space-separated and positional.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTime = after[19]; // field 22 overall, 20th after the state field
      if (bootId && startTime) return `linux:${bootId}:${startTime}`;
      return undefined;
    }
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return lstart ? `ps:${lstart}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is the process at `record.pid` still the host this record describes? `false`
 * only when we can positively tell it is somebody else; `undefined` when the
 * platform gave us nothing to compare.
 */
export function isRecordedProcess(record: HostRecord): boolean | undefined {
  if (!record.identity) return undefined;
  const current = processIdentity(record.pid);
  if (current === undefined) return undefined;
  return current === record.identity;
}

/** `GET /healthz`. Resolves false on any failure, including a timeout. */
export async function probeHealth(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/healthz`, { signal: controller.signal });
    return response.ok && (await response.text()).trim() === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** True when something accepts a TCP connection on the port. */
export async function portInUse(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * What is running, if anything. Removes a record whose process is gone so the
 * next command does not have to reason about it.
 */
export async function inspectHost(paths: Pick<PiorbitPaths, "hostFile">, timeoutMs = 1500): Promise<HostStatus> {
  const record = readHostFile(paths.hostFile);
  if (!record) return { state: "stopped", removedStaleRecord: false };

  if (!isProcessAlive(record.pid) || isRecordedProcess(record) === false) {
    // Either nothing is at that pid, or something else is: the record outlived
    // the host (a reboot, an OOM kill, a power cut). Drop it.
    clearHostFile(paths.hostFile);
    return { state: "stopped", removedStaleRecord: true };
  }
  if (await probeHealth(record.url, timeoutMs)) return { state: "running", record };
  return {
    state: "unreachable",
    record,
    reason: `process ${record.pid} is alive but ${record.url}/healthz did not answer within ${timeoutMs} ms`,
  };
}
