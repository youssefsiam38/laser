import { readFile } from 'node:fs/promises';
import { SAFETY } from './config.mjs';

function value(line, name) {
  const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(line ?? '');
  return match ? Number(match[1]) * 1024 : null;
}

export async function processSample(pid, expectedStartToken) {
  const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
  const firstStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const firstFields = firstStat.slice(firstStat.lastIndexOf(')') + 2).split(' ');
  const startToken = `linux:${boot.trim()}:${firstFields[19]}`;
  if (expectedStartToken && startToken !== expectedStartToken) throw new Error(`Process changed identity before resource sampling.`);
  const [rollup, status, io, finalStat] = await Promise.all([
    readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => null),
    readFile(`/proc/${pid}/status`, 'utf8').catch(() => null),
    readFile(`/proc/${pid}/io`, 'utf8').catch(() => null),
    readFile(`/proc/${pid}/stat`, 'utf8'),
  ]);
  const fields = finalStat.slice(finalStat.lastIndexOf(')') + 2).split(' ');
  const finalStartToken = `linux:${boot.trim()}:${fields[19]}`;
  if (finalStartToken !== startToken) throw new Error('Process changed identity during resource sampling.');
  const privateClean = value(rollup, 'Private_Clean');
  const privateDirty = value(rollup, 'Private_Dirty');
  const ioValue = name => Number(new RegExp(`^${name}:\\s+(\\d+)$`, 'm').exec(io ?? '')?.[1] ?? NaN);
  const available = n => Number.isFinite(n) ? n : null;
  return {
    pid, startToken,
    pssBytes: value(rollup, 'Pss'),
    privateResidentBytes: privateClean === null && privateDirty === null ? null : (privateClean ?? 0) + (privateDirty ?? 0),
    residentBytes: value(rollup, 'Rss') ?? value(status, 'VmRSS'),
    peakResidentBytes: value(status, 'VmHWM'),
    cpuSeconds: (Number(fields[11]) + Number(fields[12])) / 100,
    readBytes: available(ioValue('read_bytes')), writeBytes: available(ioValue('write_bytes')),
  };
}

export async function memoryAvailableBytes() {
  return value(await readFile('/proc/meminfo', 'utf8'), 'MemAvailable');
}

export async function enforceSafety(samples) {
  const available = await memoryAvailableBytes();
  if (available !== null && available < SAFETY.minimumAvailableBytes) throw new Error(`Safety refusal: MemAvailable ${available} is below ${SAFETY.minimumAvailableBytes}.`);
  for (const row of samples) if ((row.pssBytes ?? 0) > SAFETY.processPssBytes) throw new Error(`Safety refusal: process ${row.pid} PSS crossed ${SAFETY.processPssBytes}.`);
  const known = samples.map(row => row.pssBytes).filter(Number.isFinite);
  if (known.length === samples.length && known.reduce((sum, bytes) => sum + bytes, 0) > SAFETY.totalPssBytes) throw new Error(`Safety refusal: complete proportional physical page total crossed ${SAFETY.totalPssBytes}.`);
  return { availableBytes: available, completePssCoverage: known.length === samples.length };
}

export function memoryLabels() {
  return {
    pssBytes: 'proportional set size: private resident pages plus this process proportional share of resident shared pages; additive only with complete process coverage',
    privateResidentBytes: 'private resident pages from Private_Clean plus Private_Dirty; separate from proportional shared pages',
    residentBytes: 'resident set size for one process, including shared mappings at full size; overlaps other rows and is never summed as physical use',
    peakResidentBytes: 'kernel peak resident set size for one process; includes shared mappings and is not additive',
    jsHeapUsedBytes: 'live JavaScript heap reported by V8 or Chromium; not a separate physical-memory bucket',
    externalBytes: 'V8 external memory; may overlap native allocations and arrayBuffers is a subset',
    nativeBytes: 'allowlisted native allocator totals when available; not assigned to a DOM owner',
    unassignedPrivateResidentBytes: 'private resident minus JS heap used; includes V8 slack, native allocations and external memory and is not precise attribution',
  };
}
