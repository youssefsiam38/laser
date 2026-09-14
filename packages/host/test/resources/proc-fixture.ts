/**
 * A synthetic `/proc` tree.
 *
 * Real machines cannot give a test exact expected numbers, and a test that
 * asserts "some plausible amount of memory" proves nothing. This builds the
 * files the Linux collector reads, with values the test chose, so the
 * reconciliation assertion is an equality rather than a hope. The same fixture
 * is how the argv test proves a file was never opened: every read goes through
 * one function, and the test can watch it.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureProcess {
  pid: number;
  ppid: number;
  comm: string;
  /** Target of `exe`; only its basename may ever appear in a row. */
  exe?: string;
  startTicks: number;
  utimeTicks?: number;
  stimeTicks?: number;
  pssKb?: number;
  rssKb?: number;
  privateCleanKb?: number;
  privateDirtyKb?: number;
  hwmKb?: number;
  readBytes?: number;
  writeBytes?: number;
  /** Write no `smaps_rollup`, as the kernel does for a process we may not read. */
  rollupUnreadable?: boolean;
  /** Write no `io`, as the kernel does without permission. */
  ioUnreadable?: boolean;
  /** Written only so a test can prove the collector never reads it. */
  cmdline?: string;
  environ?: string;
}

export const FIXTURE_BOOT_ID = "3f2a1c44-0000-4000-8000-000000000001";
/** Seconds since boot, used for elapsed time. */
export const FIXTURE_UPTIME_SECONDS = 10_000;

export function writeProcFixture(root: string, processes: FixtureProcess[]): string {
  mkdirSync(join(root, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(root, "sys", "kernel", "random", "boot_id"), `${FIXTURE_BOOT_ID}\n`);
  writeFileSync(join(root, "uptime"), `${FIXTURE_UPTIME_SECONDS}.00 ${FIXTURE_UPTIME_SECONDS * 2}.00\n`);
  for (const entry of processes) writeProcess(root, entry);
  return root;
}

function writeProcess(root: string, entry: FixtureProcess): void {
  const dir = join(root, String(entry.pid));
  mkdirSync(dir, { recursive: true });

  // Everything after `)` is positional: state, ppid, … utime(12) stime(13) …
  // starttime(20). Zeros elsewhere; the collector reads only these.
  const after = new Array<number | string>(30).fill(0);
  after[0] = "S";
  after[1] = entry.ppid;
  after[11] = entry.utimeTicks ?? 0;
  after[12] = entry.stimeTicks ?? 0;
  after[19] = entry.startTicks;
  writeFileSync(join(dir, "stat"), `${entry.pid} (${entry.comm}) ${after.join(" ")}\n`);

  writeFileSync(
    join(dir, "status"),
    [`Name:\t${entry.comm}`, `VmHWM:\t   ${entry.hwmKb ?? 0} kB`, `VmRSS:\t   ${entry.rssKb ?? 0} kB`, ""].join("\n"),
  );

  if (!entry.rollupUnreadable) {
    writeFileSync(
      join(dir, "smaps_rollup"),
      [
        "55d0c0000000-7ffd00000000 ---p 00000000 00:00 0                          [rollup]",
        `Rss:               ${entry.rssKb ?? 0} kB`,
        `Pss:               ${entry.pssKb ?? 0} kB`,
        `Private_Clean:     ${entry.privateCleanKb ?? 0} kB`,
        `Private_Dirty:     ${entry.privateDirtyKb ?? 0} kB`,
        "",
      ].join("\n"),
    );
  }

  if (!entry.ioUnreadable) {
    writeFileSync(join(dir, "io"), [`read_bytes: ${entry.readBytes ?? 0}`, `write_bytes: ${entry.writeBytes ?? 0}`, ""].join("\n"));
  }

  if (entry.cmdline !== undefined) writeFileSync(join(dir, "cmdline"), entry.cmdline);
  if (entry.environ !== undefined) writeFileSync(join(dir, "environ"), entry.environ);

  if (entry.exe) {
    try {
      symlinkSync(entry.exe, join(dir, "exe"));
    } catch {
      // A filesystem without symlinks: the collector falls back to `comm`.
    }
  }
}
