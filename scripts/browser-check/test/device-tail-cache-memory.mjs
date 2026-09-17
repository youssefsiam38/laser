import assert from 'node:assert/strict';

import { activator, dismissInstallPrompt, watchPage } from './support.mjs';

/**
 * What the device cache costs, measured twice on the same workload (RP-10).
 *
 * The same 24 conversations are visited in both passes. What differs is one
 * thing only:
 *
 * - **cache on** — the ordinary product path;
 * - **cache absent by refusal** — the page's `indexedDB` is removed before the
 *   app loads, which is the product's own refused-storage path. That is what
 *   this pass is, and what the report calls it. It is **not** evidence about a
 *   host policy of `transcripts: "disabled"`: that is a different state, with
 *   its own refusal and its own focused tests, and nothing here is claimed
 *   about it.
 *
 * For each pass: the renderer's JS heap after a collection (`Runtime.getHeapUsage`
 * through CDP), the origin's storage estimate, and the cache's own exact
 * counters read from the database. The heap difference must sit inside the hot
 * set's declared ceiling plus a stated accounting allowance — anything larger
 * would mean the cache is holding more than it says.
 *
 * Run once, at desktop width. It changes no fixture, no workload and no
 * ceiling; the matrices in `device-tail-cache.mjs` own the rest.
 */

/** Conversations visited in each pass. The workload, identical both times. */
const VISITS = 24;
/** The hot set's own ceiling (`TAIL_HARD_LIMITS.hotBytes`). */
const HOT_BYTES = 2 * 1024 * 1024;
/**
 * What else a cache-on pass legitimately holds: the recency index, the counters
 * and the queue, plus the noise of two long runs of the same React app.
 */
const ACCOUNTING_ALLOWANCE = 24 * 1024 * 1024;

export default async function deviceTailCacheMemory(check) {
  const { page } = check;
  const { storageKey } = await import('../../../packages/protocol/dist/index.js');
  const database = storageKey('tails');
  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  // Enough conversations for the workload, created through the host's own
  // RPCs rather than by changing a fixture.
  const existing = await check.rpc('pi/session/list', { cwd: check.fixture.project });
  for (let index = (existing.sessions?.length ?? 0); index < VISITS; index += 1) {
    const { state } = await check.rpc('session/new', { cwd: check.fixture.project });
    await check.rpc('pi/session/rename', { path: state.path, name: `Memory probe ${index + 1}` });
    await check.rpc('session/prompt', {
      path: state.path,
      content: [{ type: 'text', text: `Review checkpoint ${index + 1}: verify the implementation and explain the next step.` }],
    });
    const deadline = Date.now() + 30_000;
    while ((await check.rpc('session/load', { path: state.path })).state.isStreaming) {
      assert.ok(Date.now() < deadline, 'the synthetic turn settles');
      await page.waitForTimeout(25);
    }
  }

  const openSidebar = async () => {
    const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
    if (!await sessions.isVisible()) await activate(page.getByRole('button', { name: /^Sessions$|Show sessions/ }).first());
    await sessions.waitFor({ state: 'visible' });
    return sessions;
  };

  /** Visit `VISITS` conversations through the app's own navigation. */
  const workload = async () => {
    const visited = new Set();
    while (visited.size < VISITS) {
      const sessions = await openSidebar();
      const titles = await sessions.locator('[data-slot="aui_thread-list-item-trigger"]').evaluateAll(nodes => nodes.map(node => node.title));
      let next = titles.find(title => !visited.has(title));
      for (let expansion = 0; next === undefined && expansion < 8; expansion += 1) {
        const more = (await openSidebar()).getByRole('button', { name: /^Load(?: \d+)? more$/ }).first();
        if (await more.count() === 0) break;
        await activate(more);
        await page.waitForTimeout(400);
        const grown = await (await openSidebar()).locator('[data-slot="aui_thread-list-item-trigger"]').evaluateAll(nodes => nodes.map(node => node.title));
        next = grown.find(title => !visited.has(title));
      }
      if (next === undefined) break;
      const trigger = (await openSidebar()).getByTitle(next, { exact: true }).first();
      await trigger.waitFor({ state: 'visible' });
      await activate(trigger);
      await composer.waitFor({ state: 'visible' });
      visited.add(next);
    }
    return visited.size;
  };

  /** Heap after a real collection, in bytes. */
  const heapAfterGc = async () => {
    await check.cdp.send('HeapProfiler.enable').catch(() => {});
    await check.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await page.waitForTimeout(500);
    const usage = await check.cdp.send('Runtime.getHeapUsage');
    return Math.round(usage.usedSize);
  };

  const storedState = () => page.evaluate(async name => {
    // The cache-off pass removes the factory, so this asks for it rather
    // than assuming the property is absent.
    if (!globalThis.indexedDB) return { records: 0, bytes: 0, usage: null };
    const open = await new Promise(resolve => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    let records = 0;
    let bytes = 0;
    if (open && open.objectStoreNames.contains('records')) {
      const rows = await new Promise(resolve => {
        const request = open.transaction('records', 'readonly').objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      records = rows.length;
      for (const row of rows) bytes += row.bytes ?? 0;
    }
    open?.close();
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    return { records, bytes, usage: estimate ? { usage: estimate.usage, quota: estimate.quota } : null };
  }, database);

  /** One pass: fresh page, the same workload, then the numbers. */
  const pass = async (mode) => {
    if (mode === 'off') {
      // The product's own refused-storage path, and nothing more is claimed
      // from it: no database means no durable cache, so the cache refuses.
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'indexedDB', { get: () => undefined, configurable: true });
      });
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor({ timeout: 60_000 });
    const visits = await workload();
    assert.equal(visits, VISITS, `the same workload in both passes (${mode}: ${visits})`);
    // Let the deferred writes settle before measuring either side.
    await page.waitForTimeout(2_000);
    const heap = await heapAfterGc();
    const stored = await storedState();
    console.log(
      `cache ${mode}: heap ${heap} B after GC · ${stored.records} records · ${stored.bytes} plaintext bytes`
      + ` · usage ${stored.usage?.usage ?? 'unavailable'} of ${stored.usage?.quota ?? 'unavailable'}`,
    );
    return { heap, stored };
  };

  const on = await pass('on');
  assert.ok(on.stored.records > 0, `the cache-on pass really cached something (${on.stored.records})`);
  assert.ok(on.stored.bytes <= 8 * 1024 * 1024, `and stayed inside its byte bound (${on.stored.bytes})`);

  const off = await pass('off');
  assert.equal(off.stored.records, 0, 'the refused pass kept nothing at all');

  const delta = on.heap - off.heap;
  console.log(`heap delta: ${delta} B (cache on ${on.heap} B, cache absent by refusal ${off.heap} B)`);
  assert.ok(
    delta <= HOT_BYTES + ACCOUNTING_ALLOWANCE,
    `holding the cache costs no more than the hot set says it does: ${delta} B against ${HOT_BYTES + ACCOUNTING_ALLOWANCE} B`,
  );
  await check.shot('device-cache-memory');
  watch.assertClean();
}
