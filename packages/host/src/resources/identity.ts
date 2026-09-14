/**
 * Process identity: `(pid, startToken)`.
 *
 * A pid is a slot, not a process. The kernel hands the same number to the next
 * program after ours ends, and the whole of RP-1 — a measurement, an owner, a
 * project label — would then describe a stranger. So every record and every row
 * carries a token for *this run* of the pid, and a record whose token no longer
 * matches is stale and is dropped rather than reinterpreted.
 *
 * Linux: the kernel's boot id plus field 22 of `/proc/<pid>/stat` (start time in
 * clock ticks since boot). Elsewhere: `ps -o lstart=`, the start wall-clock.
 * `undefined` when the platform gives us nothing — and then nothing is attached.
 *
 * `packages/cli/src/hostfile.ts` does the same for the host pidfile; the host
 * may not import the CLI, so this is the host's own small copy.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { RESOURCE_ID_MAX, sanitizeResourceLabel } from "@lasercode/protocol";

export interface IdentityIo {
  platform?: NodeJS.Platform;
  /** Root of the proc filesystem; a fixture directory in tests. */
  procRoot?: string;
  readFile?: (path: string) => string;
  ps?: (pid: number) => string;
}

const defaultRead = (path: string): string => readFileSync(path, "utf8");

const defaultPs = (pid: number): string => {
  const options: ExecFileSyncOptions = { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] };
  return String(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], options));
};

/**
 * The 22nd field of `/proc/<pid>/stat`. `comm` may contain spaces and
 * parentheses, so everything is parsed from the last `)`.
 */
export function startTicksFromStat(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : undefined;
}

/** `comm` from `/proc/<pid>/stat`, i.e. the executable name — never argv. */
export function commFromStat(stat: string): string | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close <= open) return undefined;
  return stat.slice(open + 1, close) || undefined;
}

/** The parent pid, field 4. */
export function ppidFromStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
}

export function processStartToken(pid: number, io: IdentityIo = {}): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const platform = io.platform ?? process.platform;
  const read = io.readFile ?? defaultRead;
  try {
    if (platform === "linux") {
      const procRoot = io.procRoot ?? "/proc";
      const boot = read(`${procRoot}/sys/kernel/random/boot_id`).trim();
      const ticks = startTicksFromStat(read(`${procRoot}/${pid}/stat`));
      if (!boot || !ticks) return undefined;
      return bound(`linux:${boot}:${ticks}`);
    }
    const lstart = (io.ps ?? defaultPs)(pid).trim();
    return lstart ? bound(`ps:${lstart.replace(/\s+/g, " ")}`) : undefined;
  } catch {
    return undefined;
  }
}

function bound(token: string): string {
  return token.length > RESOURCE_ID_MAX ? token.slice(0, RESOURCE_ID_MAX) : token;
}

/** The only identity a row, a record or a cross-check may be keyed by. */
export function processKey(pid: number, startToken: string): string {
  return `${pid}@${bound(startToken)}`;
}

/**
 * The chain of ancestors of `pid`, nearest first, with each one's identity.
 *
 * This is how the host decides whether a desktop shell claiming to own it
 * really does: a claim is believed only when the claimed process is genuinely
 * one of ours — the shell that started this host — as the operating system
 * describes it, not because a local connection said so.
 *
 * Bounded in depth, and empty when the platform cannot answer (Windows has no
 * `ps`), which leaves a report `unverified` rather than trusted.
 */
export function ancestorChain(pid: number, io: IdentityIo = {}, maxDepth = 16): Array<{ pid: number; startToken: string }> {
  const platform = io.platform ?? process.platform;
  const read = io.readFile ?? defaultRead;
  const chain: Array<{ pid: number; startToken: string }> = [];
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let parent: number | undefined;
    try {
      if (platform === "linux") {
        parent = ppidFromStat(read(`${io.procRoot ?? "/proc"}/${current}/stat`));
      } else if (platform === "win32") {
        return chain; // No cheap, dependency-free parent lookup: stay honest.
      } else {
        const options: ExecFileSyncOptions = { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] };
        const out = String(execFileSync("ps", ["-o", "ppid=", "-p", String(current)], options)).trim();
        parent = out ? Number(out) : undefined;
      }
    } catch {
      return chain;
    }
    if (parent === undefined || !Number.isInteger(parent) || parent <= 1 || seen.has(parent)) return chain;
    seen.add(parent);
    const token = processStartToken(parent, io);
    if (!token) return chain;
    chain.push({ pid: parent, startToken: token });
    current = parent;
  }
  return chain;
}

/** A process label: the executable's basename, sanitized and bounded. */
export function executableLabel(name: string | undefined): string {
  if (!name) return "unknown";
  const base = name.split(/[\\/]/).pop() ?? name;
  return sanitizeResourceLabel(base);
}
