import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Isolated synthetic metadata only. Pass a saved baseline module or built host module.
const { browseExplorer } = await import(pathToFileURL(resolve(process.argv[2] ?? 'packages/host/dist/directory-explorer.js')).href);
const results = [];
for (const count of [5000, 20000, 60000]) {
  const cwd = mkdtempSync(join(tmpdir(), 'directory-bench-'));
  try {
    for (let i = 0; i < count; i++) writeFileSync(join(cwd, `entry-${String((i * 7919) % count).padStart(6, '0')}`), '');
    const gaps = [];
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
    await sleep(20);
    const start = performance.now();
    const listing = await browseExplorer(cwd, { mode: 'explorer', cwd, prefix: '', limit: 80 });
    const elapsedMs = performance.now() - start;
    // Include the first timer AFTER settlement, or the worst final stall disappears.
    await sleep(20); clearInterval(timer);
    const tail = await browseExplorer(cwd, { mode: 'explorer', cwd, prefix: '', offset: count - 1, limit: 1 });
    const finalName = `entry-${String(count - 1).padStart(6, '0')}`;
    assert.deepEqual(tail.entries.map(entry => entry.name), [finalName]);
    assert.equal(tail.truncated, false); assert.equal(tail.nextOffset, undefined);
    const filtered = await browseExplorer(cwd, { mode: 'explorer', cwd, prefix: finalName.toUpperCase(), limit: 1 });
    assert.deepEqual(filtered.entries.map(entry => entry.name), [finalName]);
    assert.equal(filtered.commonPrefix, finalName);
    results.push({ count, elapsedMs, heartbeatMs: 5, ticks: gaps.length, maxGapMs: Math.max(...gaps), tailReached: finalName,
      maxDelayMs: Math.max(...gaps) - 5, commonPrefix: listing.commonPrefix, nextOffset: listing.nextOffset,
      pageSha256: createHash('sha256').update(JSON.stringify(listing.entries.map(e => [e.name, e.kind]))).digest('hex') });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ node: process.version, module: process.argv[2], results }, null, 2));
