import { open, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SAFETY } from './config.mjs';

const execFileAsync = promisify(execFile);
const parser = fileURLToPath(new URL('./heap-parser.mjs', import.meta.url));

/**
 * One bounded inspector call. `InspectorClient` enforces its own timeout and
 * Playwright's `CDPSession` does not, so every call made here is raced against
 * one explicit deadline and the timer is always cleared.
 */
export async function sendBounded(client, method, params = {}, timeoutMs = 180_000) {
  let timer;
  try {
    return await Promise.race([
      client.send(method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms.`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * V8 only keeps a snapshot object id stable across a garbage collection while
 * it is tracking object moves. An id taken outside that window is stale as soon
 * as the forced collection — or the snapshot's own collection — moves the
 * object, and every target then comes back "absent" from a snapshot that does
 * in fact contain it. So: start tracking, resolve the ids inside that window,
 * take the snapshot, and stop through `HeapProfiler.disable`, which is the one
 * way to stop tracking without V8 serializing a second whole snapshot.
 */
export async function captureHeap(client, file, targetObjects = {}, options = {}) {
  const handle = await open(file, 'wx', 0o600);
  const timeoutMs = options.timeoutMs ?? 180_000;
  let bytes = 0;
  let capped = false;
  let writes = Promise.resolve();
  let tracking = false;
  let closed = false;
  const listener = ({ chunk }) => {
    const size = Buffer.byteLength(chunk);
    bytes += size;
    if (bytes > (options.byteCeiling ?? SAFETY.snapshotBytes)) { capped = true; return; }
    writes = writes.then(() => handle.write(chunk)).catch(error => { capped = true; writes = Promise.resolve(); throw error; });
  };
  const subscription = client.on('HeapProfiler.addHeapSnapshotChunk', listener);
  const remove = typeof subscription === 'function' ? subscription : () => client.off?.('HeapProfiler.addHeapSnapshotChunk', listener);
  const settleWrites = async () => {
    // Whatever happened, the queued writes are drained and the handle closed
    // exactly once: a failed capture must not leave a chunk write in flight
    // against a file this function is about to delete.
    try { await writes; } catch {}
    if (!closed) { closed = true; await handle.close().catch(() => {}); }
  };
  try {
    await sendBounded(client, 'HeapProfiler.startTrackingHeapObjects', { trackAllocations: false }, timeoutMs);
    tracking = true;
    await sendBounded(client, 'HeapProfiler.collectGarbage', {}, timeoutMs);
    await sendBounded(client, 'HeapProfiler.collectGarbage', {}, timeoutMs);
    const targets = {};
    for (const [label, objectId] of Object.entries(targetObjects)) {
      targets[label] = Number((await sendBounded(client, 'HeapProfiler.getHeapObjectId', { objectId }, timeoutMs)).heapSnapshotObjectId);
    }
    await sendBounded(client, 'HeapProfiler.takeHeapSnapshot', { reportProgress: false }, timeoutMs);
    await settleWrites();
    if (capped) return { available: false, reason: `raw snapshot exceeded ${options.byteCeiling ?? SAFETY.snapshotBytes} bytes`, rawBytes: bytes };
    const { stdout } = await execFileAsync(process.execPath, [
      `--max-old-space-size=${SAFETY.parserHeapMb}`, parser, file, JSON.stringify(targets),
    ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '' } });
    return { ...JSON.parse(stdout), rawBytes: bytes, parserHeapLimitMb: SAFETY.parserHeapMb };
  } catch (error) {
    await settleWrites();
    return { available: false, reason: error instanceof Error ? error.message : String(error), rawBytes: bytes };
  } finally {
    remove();
    await settleWrites();
    // Tracking object moves costs the measured process memory of its own, so it
    // never outlives one capture. `disable` stops it without a second snapshot;
    // `enable` puts the domain back for the next one on this connection.
    if (tracking) {
      await sendBounded(client, 'HeapProfiler.disable', {}, 30_000).catch(() => {});
      await sendBounded(client, 'HeapProfiler.enable', {}, 30_000).catch(() => {});
    }
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function heapObjectId(client, objectId) {
  const result = await sendBounded(client, 'HeapProfiler.getHeapObjectId', { objectId }, 30_000);
  return Number(result.heapSnapshotObjectId);
}
