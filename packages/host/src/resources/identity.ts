/**
 * Process identity: `(pid, startToken)`.
 *
 * A pid is a slot, not a process. The kernel hands the same number to the next
 * program after ours ends, and the whole of RP-1 — a measurement, an owner, a
 * project label — would then describe a stranger. So every record and every row
 * carries a token for *this run* of the pid, and a record whose token no longer
 * matches is stale: it is pruned, never reinterpreted.
 *
 * The identity always comes from a collected process table, never from a
 * separate read of a single pid. That is deliberate: a second read is a second
 * moment, and between two moments a pid can change hands. It also keeps this
 * subsystem off the host's event loop — there is no synchronous file read and
 * no synchronous `ps` anywhere in it.
 *
 * These are the parsers the Linux collector uses, plus the two formatting
 * helpers every collector shares.
 */
import { RESOURCE_ID_MAX, sanitizeResourceLabel } from "@lasercode/protocol";

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

/** The only identity a row, a record or a cross-check may be keyed by. */
export function processKey(pid: number, startToken: string): string {
  return `${pid}@${startToken.length > RESOURCE_ID_MAX ? startToken.slice(0, RESOURCE_ID_MAX) : startToken}`;
}

/** A process label: the executable's basename, sanitized and bounded. */
export function executableLabel(name: string | undefined): string {
  if (!name) return "unknown";
  const base = name.split(/[\\/]/).pop() ?? name;
  return sanitizeResourceLabel(base);
}
