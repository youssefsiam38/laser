import { open, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SAFETY } from './config.mjs';

const execFileAsync = promisify(execFile);
const parser = fileURLToPath(new URL('./heap-parser.mjs', import.meta.url));

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
  let bytes = 0;
  let capped = false;
  let writes = Promise.resolve();
  let tracking = false;
  const listener = ({ chunk }) => {
    const size = Buffer.byteLength(chunk);
    bytes += size;
    if (bytes > (options.byteCeiling ?? SAFETY.snapshotBytes)) { capped = true; return; }
    writes = writes.then(() => handle.write(chunk));
  };
  const subscription = client.on('HeapProfiler.addHeapSnapshotChunk', listener);
  const remove = typeof subscription === 'function' ? subscription : () => client.off?.('HeapProfiler.addHeapSnapshotChunk', listener);
  try {
    await client.send('HeapProfiler.startTrackingHeapObjects', { trackAllocations: false });
    tracking = true;
    await client.send('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.collectGarbage');
    const targets = {};
    for (const [label, objectId] of Object.entries(targetObjects)) targets[label] = await heapObjectId(client, objectId);
    await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, options.timeoutMs ?? 180_000);
    await writes;
    await handle.close();
    if (capped) return { available: false, reason: `raw snapshot exceeded ${options.byteCeiling ?? SAFETY.snapshotBytes} bytes`, rawBytes: bytes };
    const { stdout } = await execFileAsync(process.execPath, [
      `--max-old-space-size=${SAFETY.parserHeapMb}`, parser, file, JSON.stringify(targets),
    ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '' } });
    return { ...JSON.parse(stdout), rawBytes: bytes, parserHeapLimitMb: SAFETY.parserHeapMb };
  } catch (error) {
    await handle.close().catch(() => {});
    return { available: false, reason: error instanceof Error ? error.message : String(error), rawBytes: bytes };
  } finally {
    remove();
    // Tracking object moves costs the measured process memory of its own, so it
    // never outlives one capture. `disable` stops it without a second snapshot;
    // `enable` puts the domain back for the next one on this connection.
    if (tracking) {
      await client.send('HeapProfiler.disable').catch(() => {});
      await client.send('HeapProfiler.enable').catch(() => {});
    }
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function heapObjectId(client, objectId) {
  const result = await client.send('HeapProfiler.getHeapObjectId', { objectId });
  return Number(result.heapSnapshotObjectId);
}
