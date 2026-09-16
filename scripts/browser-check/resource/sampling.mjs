/**
 * What one phase measures, and in what order.
 *
 * The order is the whole point. `/proc` rows and the renderer's own counters
 * are read first, before any inspector work, because `Runtime.queryObjects`,
 * `HeapProfiler.collectGarbage` and a heap snapshot all collect garbage in the
 * process being measured. A number taken after them is a post-collection
 * number, so this module labels what it took and when: `natural` for the rows
 * read before any instrumentation, `postGc` for the rows read after the
 * capture, and `postGc` again for anything — such as TailBuffer discovery —
 * that can only be obtained by querying the heap.
 *
 * Coverage is equally explicit. Expected processes are `(pid, startToken)`
 * identities, verified every phase; a process that legitimately exited is
 * recorded as exited, a process that is there but cannot be read is recorded as
 * unreadable, and any unreadable expected row makes the totals null, the
 * coverage incomplete and the safety verdict inconclusive rather than letting a
 * partial sum look like a complete one.
 */
import { processSample, enforceSafety } from './process-sampler.mjs';
import { descendantPids } from './inspector.mjs';

export const SCOPE = 'host process tree and the renderer of the measured page';

class PhysicalMemoryUnavailable extends Error {}
const settleExitingProcess = () => new Promise(resolve => setTimeout(resolve, 50));

export class ProcessCensus {
  constructor({ hostPid, sample = processSample, descendants = descendantPids } = {}) {
    this.hostPid = hostPid;
    this.sample = sample;
    this.descendants = descendants;
    /** pid -> startToken, for every process this run has already measured. */
    this.identities = new Map();
  }

  /**
   * One census: every host-tree process plus the measured renderer, each read
   * against the identity it had when this run first saw it.
   */
  async take({ rendererPid = null, requiredPids = [] } = {}) {
    const pids = [...await this.descendants(this.hostPid)];
    if (rendererPid !== null && !pids.includes(rendererPid)) pids.push(rendererPid);
    const rows = [];
    const unreadable = [];
    const exited = [];
    const replaced = [];
    const record = row => {
      // A readable stat row is not complete Linux memory evidence when
      // smaps_rollup could not supply either required physical metric. Treat
      // that process as unreadable so totals and the safety verdict cannot
      // silently proceed from a partial census.
      if (!Number.isFinite(row.pssBytes) || !Number.isFinite(row.privateResidentBytes)) {
        throw new PhysicalMemoryUnavailable('Linux proportional or private-resident memory is unavailable for a sampled process.');
      }
      this.identities.set(row.pid, row.startToken);
      rows.push(row);
    };
    for (const pid of pids) {
      const known = this.identities.get(pid) ?? null;
      try {
        const row = await this.sample(pid, known ?? undefined);
        record(row);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof PhysicalMemoryUnavailable) {
          // A process in its exit window can retain a readable stat row after
          // smaps_rollup has gone away. Re-sample once after a bounded settle:
          // ENOENT is then an honest exit; another metric-less row remains an
          // unreadable safety refusal.
          await settleExitingProcess();
          try { const row = await this.sample(pid, known ?? undefined); record(row); }
          catch (retry) {
            const retryReason = retry instanceof Error ? retry.message : String(retry);
            if (/ENOENT|ESRCH|no such file/i.test(retryReason)) { exited.push(pid); this.identities.delete(pid); }
            else unreadable.push({ pid, reason: retryReason });
          }
          continue;
        }
        if (/changed identity/.test(reason)) {
          // A new process reusing a pid is a different process, not a bad read.
          replaced.push(pid);
          this.identities.delete(pid);
          try { const row = await this.sample(pid); record(row); }
          catch (retry) { unreadable.push({ pid, reason: retry instanceof Error ? retry.message : String(retry) }); }
          continue;
        }
        if (/ENOENT|ESRCH|no such file/i.test(reason)) { exited.push(pid); this.identities.delete(pid); continue; }
        unreadable.push({ pid, reason });
      }
    }
    const measuredPids = new Set(rows.map(row => row.pid));
    const missingRequired = requiredPids.filter(pid => pid !== null && !measuredPids.has(pid));
    const complete = unreadable.length === 0 && missingRequired.length === 0;
    return {
      rows, unreadable, exited, replaced, missingRequired,
      coverage: {
        scope: SCOPE,
        expected: pids.length,
        measured: rows.length,
        complete,
        unreadableProcesses: unreadable.length,
        exitedProcesses: exited.length,
        replacedProcesses: replaced.length,
        includedRoles: ['host', 'host descendants (workers and their children)', 'renderer of the measured page'],
        excludedRoles: ['browser process and its other children', 'GPU process', 'operating system and desktop processes'],
        note: 'totals cover this scope only and are never the whole application',
      },
    };
  }
}

function sum(rows, key) {
  return rows.every(row => Number.isFinite(row[key])) ? rows.reduce((total, row) => total + row[key], 0) : null;
}

/** Totals that refuse to look complete when the census was not. */
export function censusTotals(census) {
  const complete = census.coverage.complete;
  return {
    processCount: census.rows.length,
    totalPssBytes: complete ? sum(census.rows, 'pssBytes') : null,
    totalPrivateResidentBytes: complete ? sum(census.rows, 'privateResidentBytes') : null,
    coverage: census.coverage,
    unreadableProcesses: census.unreadable.length,
  };
}

/**
 * The safety verdict for one census. Incomplete coverage is inconclusive, and
 * inconclusive is refused: a ceiling cannot be enforced against a total that is
 * missing a process which is still running.
 */
export async function verdictFor(census, { enforce = enforceSafety } = {}) {
  if (!census.coverage.complete) {
    const detail = census.unreadable.length
      ? `${census.unreadable.length} expected process rows could not be read`
      : `${census.missingRequired.length} required processes were absent from the census`;
    throw new Error(`Safety refusal: process coverage is inconclusive — ${detail}.`);
  }
  return { ...await enforce(census.rows), coverage: census.coverage };
}
