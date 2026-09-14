const ALLOCATORS = /^(?:malloc|partition_alloc|v8|blink_gc|skia|gpu)(?:\/|$)/;

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^(?:0x)?[0-9a-f]+$/i.test(value)) return Number.parseInt(value.replace(/^0x/i, ''), 16);
  if (value && typeof value === 'object') return numeric(value.value);
  return null;
}

export function aggregate(trace) {
  const totals = new Map();
  for (const event of trace.traceEvents ?? []) {
    const allocators = event.args?.dumps?.allocators;
    if (!allocators || typeof allocators !== 'object') continue;
    for (const [name, row] of Object.entries(allocators)) {
      if (!ALLOCATORS.test(name)) continue;
      const bytes = numeric(row?.attrs?.size) ?? numeric(row?.size);
      if (bytes !== null) totals.set(name, Math.max(totals.get(name) ?? 0, bytes));
    }
  }
  return [...totals].map(([owner, bytes]) => ({ owner, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 30);
}

/**
 * One bounded Chrome memory dump, taken in the shortest trace window that can
 * carry it. Tracing is never left running across the measured workload: the
 * detailed level of detail walks every allocator in every process and costs the
 * renderer far more memory than the thing being measured, which is the opposite
 * of an observation. The least intrusive level that still names real allocator
 * owners is the one used, and the level that produced the rows is reported.
 */
export async function dumpAllocators(browserCdp, { byteCeiling = 16 * 1024 * 1024, timeoutMs = 60_000, levels = ['background', 'light'], minimumOwners = 5 } = {}) {
  const attempts = [];
  for (const levelOfDetail of levels) {
    let stream;
    try {
      let resolveComplete;
      const completed = new Promise(resolve => { resolveComplete = resolve; });
      browserCdp.once('Tracing.tracingComplete', resolveComplete);
      await browserCdp.send('Tracing.start', { categories: 'disabled-by-default-memory-infra', transferMode: 'ReturnAsStream' });
      const dump = await browserCdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail });
      await browserCdp.send('Tracing.end');
      let timer;
      try {
        ({ stream } = await Promise.race([completed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('memory trace completion timed out')), timeoutMs); })]));
      } finally { clearTimeout(timer); }
      let text = '';
      let traceBytes = 0;
      while (true) {
        const part = await browserCdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
        text += part.data;
        traceBytes = Buffer.byteLength(text);
        if (traceBytes > byteCeiling) throw new Error(`memory trace exceeded ${byteCeiling} bytes at level ${levelOfDetail}`);
        if (part.eof) break;
      }
      await browserCdp.send('IO.close', { handle: stream });
      stream = undefined;
      const allocators = aggregate(JSON.parse(text));
      text = '';
      attempts.push({ levelOfDetail, owners: allocators.length, traceBytes, dumped: dump.success !== false });
      if (dump.success !== false && allocators.length >= minimumOwners) {
        return { available: true, levelOfDetail, traceBytes, attempts, allocators, physicalImageOwnerBytes: null,
          limitation: 'Chrome native allocator totals are aggregate and cannot be assigned to one decoded DOM image' };
      }
    } catch (error) {
      attempts.push({ levelOfDetail, owners: 0, error: error instanceof Error ? error.message : String(error) });
      if (stream) await browserCdp.send('IO.close', { handle: stream }).catch(() => {});
      await browserCdp.send('Tracing.end').catch(() => {});
    }
  }
  return { available: false, reason: `no bounded memory dump produced ${minimumOwners} allocator owners`, attempts, allocators: [], physicalImageOwnerBytes: null };
}

/** Run the measured workload with no tracing on, then take one bounded dump. */
export async function captureMemoryInfra(browserCdp, action, options = {}) {
  await action();
  return dumpAllocators(browserCdp, options);
}
