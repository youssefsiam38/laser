const ALLOCATORS = /^(?:malloc|partition_alloc|v8|blink_gc|skia|gpu)(?:\/|$)/;

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^(?:0x)?[0-9a-f]+$/i.test(value)) return Number.parseInt(value.replace(/^0x/i, ''), 16);
  if (value && typeof value === 'object') return numeric(value.value);
  return null;
}

function aggregate(trace) {
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

export async function captureMemoryInfra(browserCdp, action, { byteCeiling = 64 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  let stream;
  try {
    let resolveComplete;
    const completed = new Promise(resolve => { resolveComplete = resolve; });
    browserCdp.once('Tracing.tracingComplete', resolveComplete);
    await browserCdp.send('Tracing.start', { categories: 'disabled-by-default-memory-infra', transferMode: 'ReturnAsStream' });
    await action();
    const dump = await browserCdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    await browserCdp.send('Tracing.end');
    ({ stream } = await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('memory trace completion timed out')), timeoutMs))]));
    let text = '';
    while (true) {
      const part = await browserCdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
      text += part.data;
      if (Buffer.byteLength(text) > byteCeiling) throw new Error(`memory trace exceeded ${byteCeiling} bytes`);
      if (part.eof) break;
    }
    await browserCdp.send('IO.close', { handle: stream });
    stream = undefined;
    const allocators = aggregate(JSON.parse(text));
    text = '';
    return { available: dump.success !== false, allocators, physicalImageOwnerBytes: null,
      limitation: 'Chrome native allocator totals are aggregate and cannot be assigned to one decoded DOM image' };
  } catch (error) {
    if (stream) await browserCdp.send('IO.close', { handle: stream }).catch(() => {});
    await browserCdp.send('Tracing.end').catch(() => {});
    return { available: false, reason: error instanceof Error ? error.message : String(error), allocators: [], physicalImageOwnerBytes: null };
  }
}
