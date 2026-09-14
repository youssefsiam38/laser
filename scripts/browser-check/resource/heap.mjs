import { open, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SAFETY } from './config.mjs';

const execFileAsync = promisify(execFile);
const parser = fileURLToPath(new URL('./heap-parser.mjs', import.meta.url));

export async function captureHeap(client, file, targets = {}, options = {}) {
  const handle = await open(file, 'wx', 0o600);
  let bytes = 0;
  let capped = false;
  let writes = Promise.resolve();
  const listener = ({ chunk }) => {
    const size = Buffer.byteLength(chunk);
    bytes += size;
    if (bytes > (options.byteCeiling ?? SAFETY.snapshotBytes)) { capped = true; return; }
    writes = writes.then(() => handle.write(chunk));
  };
  const subscription = client.on('HeapProfiler.addHeapSnapshotChunk', listener);
  const remove = typeof subscription === 'function' ? subscription : () => client.off?.('HeapProfiler.addHeapSnapshotChunk', listener);
  try {
    await client.send('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, options.timeoutMs ?? 180_000);
    await writes;
    await handle.close();
    if (capped) return { available: false, reason: `raw snapshot exceeded ${options.byteCeiling ?? SAFETY.snapshotBytes} bytes`, rawBytes: bytes };
    const { stdout } = await execFileAsync(process.execPath, [
      `--max-old-space-size=${SAFETY.parserHeapMb}`, parser, file, JSON.stringify(targets),
    ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '' } });
    return { ...JSON.parse(stdout), rawBytes: bytes, parserHeapLimitMb: SAFETY.parserHeapMb };
  } catch (error) {
    await handle.close().catch(() => {});
    return { available: false, reason: error instanceof Error ? error.message : String(error), rawBytes: bytes };
  } finally {
    remove();
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function heapObjectId(client, objectId) {
  const result = await client.send('HeapProfiler.getHeapObjectId', { objectId });
  return Number(result.heapSnapshotObjectId);
}
