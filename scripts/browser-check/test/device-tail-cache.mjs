import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * Conversations this device keeps, against a real host and a real database
 * (RP-10, M18-T10).
 *
 * Run with the shared app target and `--fixture projects`, because the cache is
 * fed by what the renderer *releases*: a device only holds a tail once a
 * transcript has been let go of, which needs more conversations open than the
 * renderer's own budget (RP-5). Visiting nine of them is the real product path
 * that produces cached records.
 *
 * What is proved here, and could not be proved in a unit test:
 *
 *  1. **The key is opaque.** Rows are keyed by the host's own environment key
 *     and the session's own id — that id is *required* there — and nothing in
 *     any key, index or field carries a path, the host's raw environment id, a
 *     device id, or content.
 *  2. **Readiness precedes the connection.** The database is opened and read
 *     after the environment is described and **before** the first
 *     `session/load` frame leaves the page, which is what makes a local-first
 *     paint a guarantee rather than a race.
 *  3. **Damage cannot block the host.** Rows rewritten through the page — a
 *     broken checksum, a foreign environment, an impossible size, a future
 *     date — are discarded on the next start, and the conversation still loads.
 *  4. **The clear really clears**, and reports rather than assuming.
 *  5. **The surface is legible and operable** at both widths, both themes,
 *     with a pointer, a thumb, a keyboard and reduced motion.
 *
 * Everything hostile is seeded through the page, never through a shipped seam.
 */

/** Sessions to visit: past the renderer's six-view budget, so tails are released. */
const VISITS = 9;

export default async function deviceTailCache(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  const label = `${check.state.width}-${check.state.theme}${check.state.touch ? '-touch' : ''}`;
  await check.touch(phone);

  const { ENVIRONMENT_KEY_PATTERN, SESSION_REVISION_PATTERN, storageKey } = await import('../../../packages/protocol/dist/index.js');
  const database = storageKey('tails');

  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  const described = await check.rpc('environment/describe', {});
  const environmentKey = described.environment.environmentKey;
  assert.match(environmentKey, ENVIRONMENT_KEY_PATTERN, 'the host publishes an opaque environment key');
  const rawEnvironmentId = JSON.parse(readFileSync(join(check.root, 'state/environment.json'), 'utf8')).id;
  assert.match(rawEnvironmentId, /^[0-9a-f-]{36}$/, 'the host minted a raw environment id it keeps to itself');

  /** Every row in the database, as the page can see it. */
  const rows = () => page.evaluate(async name => {
    const open = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('open failed'));
    });
    if (!open.objectStoreNames.contains('records')) {
      open.close();
      return { keyPath: null, indexes: [], rows: [] };
    }
    const store = open.transaction('records', 'readonly').objectStore('records');
    const keyPath = store.keyPath;
    const indexes = [...store.indexNames];
    const [keys, values] = await Promise.all([
      new Promise(resolve => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
      }),
      new Promise(resolve => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
      }),
    ]);
    open.close();
    return {
      keyPath,
      indexes,
      rows: values.map((row, index) => ({
        key: keys[index],
        ...row,
        // The body is a plaintext string in a browser: carried as text, and
        // measured rather than shipped whole.
        bodyKind: row.body?.kind,
        bodyBytes: row.body?.kind === 'plain' ? row.body.text.length : (row.body?.data?.byteLength ?? 0),
        bodyText: row.body?.kind === 'plain' ? row.body.text : '',
        body: undefined,
      })),
    };
  }, database);

  const writeRows = (mutation, payload) => page.evaluate(async ({ name, mutation, payload }) => {
    const open = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('open failed'));
    });
    const transaction = open.transaction('records', 'readwrite');
    const store = transaction.objectStore('records');
    const existing = await new Promise(resolve => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
    });
    // eslint-disable-next-line no-new-func
    const apply = new Function('store', 'rows', 'payload', mutation);
    apply(store, existing, payload);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(new Error('write failed'));
      transaction.onabort = () => reject(new Error('write aborted'));
    });
    open.close();
  }, { name: database, mutation, payload });

  // ------------------------------------------------- 1. records really appear
  /**
   * Poll from here, not in the page: a `waitForFunction` whose body is `async`
   * hands back a promise, and a promise is truthy — it would "succeed"
   * immediately and prove nothing.
   */
  const until = async (what, predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await page.waitForTimeout(250);
    }
  };

  const sidebar = () => page.getByRole('region', { name: 'Sessions', exact: true });
  const openSidebar = async () => {
    const sessions = sidebar();
    if (!await sessions.isVisible()) await activate(page.getByRole('button', { name: /^Sessions$|Show sessions/ }).first());
    await sessions.waitFor({ state: 'visible' });
    return sessions;
  };
  /**
   * Every row the sidebar is actually showing, identified by its own title
   * attribute — the first line is the conversation's name and the second is
   * its project, so two conversations that share a name are still distinct.
   */
  const visibleRows = async () => {
    const sessions = await openSidebar();
    return sessions.locator('[data-slot="aui_thread-list-item-trigger"]').evaluateAll(nodes => nodes.map(node => node.title));
  };
  const select = async row => {
    const sessions = await openSidebar();
    const trigger = sessions.getByTitle(row, { exact: true }).first();
    await trigger.waitFor({ state: 'visible' });
    await activate(trigger);
    const name = row.split('\n')[0];
    await page.waitForFunction(name => document.querySelector('h1')?.textContent === name, name);
    await composer.waitFor({ state: 'visible' });
    if (page.viewportSize().width < 1024) await sessions.waitFor({ state: 'hidden' });
  };

  // The sidebar pages its own list, and on a phone it closes after every
  // choice and reopens on its first page \u2014 so the next conversation is
  // discovered each time round rather than assumed from one early reading.
  // "Load more" is pressed only when nothing unvisited is on screen.
  const visited = new Set();
  while (visited.size < VISITS) {
    let candidates = await visibleRows();
    let next = candidates.find(row => !visited.has(row));
    for (let expansion = 0; next === undefined && expansion < 6; expansion += 1) {
      const more = (await openSidebar()).getByRole('button', { name: 'Load more', exact: true }).first();
      if (await more.count() === 0) break;
      await activate(more);
      await page.waitForTimeout(500);
      candidates = await visibleRows();
      next = candidates.find(row => !visited.has(row));
    }
    if (next === undefined) break;
    await select(next);
    visited.add(next);
  }
  assert.ok(
    visited.size >= VISITS,
    `this fixture offers enough conversations to push the renderer past its own budget (${visited.size})`,
  );

  // Releases are delivered off the frame, and the write after that.
  await until('a released tail to reach this device', async () => (await rows()).rows.length > 0);

  const stored = await rows();
  assert.deepEqual(stored.keyPath, ['environmentKey', 'sessionId'], 'rows are keyed by opaque environment and session identity');
  assert.deepEqual(stored.indexes, ['by-path'], 'the path is an index, never key material');
  assert.ok(stored.rows.length > 0, `visiting ${VISITS} conversations leaves tails on this device (${stored.rows.length})`);
  assert.ok(stored.rows.length <= 24, `the record count stays inside the bound (${stored.rows.length})`);

  const sessionIds = new Set();
  for (const row of stored.rows) {
    assert.equal(row.key[0], environmentKey, 'every key hangs from the host\u2019s own environment key');
    assert.ok(typeof row.key[1] === 'string' && row.key[1].length > 0, 'the opaque session id is required in the key');
    assert.ok(!row.key[1].includes('/'), `no path in key material: ${row.key[1]}`);
    sessionIds.add(row.key[1]);
    assert.match(row.revision, SESSION_REVISION_PATTERN, 'each record carries the revision it can be validated by');
    assert.equal(row.schema, 'tail-cache/1');
    assert.ok(row.bytes > 0 && row.bytes <= 256 * 1024, `each record stays inside its own byte bound (${row.bytes})`);
    const keyText = JSON.stringify(row.key);
    for (const [what, secret] of [['raw environment id', rawEnvironmentId], ['project path', check.fixture.project], ['session path', check.fixture.path]]) {
      assert.ok(!keyText.includes(secret), `no ${what} in key material`);
    }
    // Identity fields may name the path (it is how a navigation finds a row);
    // nothing may carry the host's private identity or a device id.
    const rowText = JSON.stringify({ ...row, bodyText: undefined });
    assert.ok(!rowText.includes(rawEnvironmentId), 'no raw environment id anywhere in a row');
    assert.ok(!/deviceId|actorId/.test(rowText), `no device or actor identity in a row: ${rowText.slice(0, 200)}`);
  }
  assert.equal(sessionIds.size, stored.rows.length, 'one record per conversation, never two');
  const totalBytes = stored.rows.reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(totalBytes <= 8 * 1024 * 1024, `the whole cache stays inside its byte bound (${totalBytes})`);

  const estimate = await page.evaluate(() => navigator.storage?.estimate?.().then(value => ({ usage: value.usage, quota: value.quota })) ?? null);
  console.log(`device cache ${label}: ${stored.rows.length} records \u00b7 ${totalBytes} plaintext bytes \u00b7 usage ${estimate?.usage ?? 'unknown'} of ${estimate?.quota ?? 'unknown'}`);

  // ------------- 2. this device is ready before the connection opens its work
  await page.addInitScript(() => {
    const probe = { steps: [] };
    globalThis.__tailProbe = probe;
    const at = what => probe.steps.push({ what, at: performance.now() });
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function patched(...args) {
      if (String(args[0]).endsWith('-tails')) at('db-open');
      const request = open.apply(this, args);
      request.addEventListener?.('success', () => {
        if (String(args[0]).endsWith('-tails')) at('db-ready');
      });
      return request;
    };
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function patched(...args) {
      const request = getAll.apply(this, args);
      if (this.name === 'records') {
        at('db-read');
        request.addEventListener?.('success', () => at('db-rows'));
      }
      return request;
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function patched(data) {
      try {
        const frame = JSON.parse(data);
        if (frame.method) at(`send:${frame.method}`);
      } catch {
        // Not our JSON-RPC: nothing to record.
      }
      return send.call(this, data);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => globalThis.__tailProbe?.steps.some(step => step.what === 'send:session/load'), undefined, { timeout: 60_000 });
  const steps = await page.evaluate(() => globalThis.__tailProbe.steps.map(step => step.what));
  const first = what => steps.indexOf(what);
  assert.ok(first('send:environment/describe') >= 0, 'the environment is asked for');
  assert.ok(first('db-read') >= 0, 'this device’s cache is read during startup');
  assert.ok(
    first('db-read') > first('send:environment/describe'),
    `the cache is read only after the environment is known: ${steps.join(' → ')}`,
  );
  assert.ok(
    first('db-rows') < first('send:session/load'),
    `the cache is read before the first conversation is asked of the host: ${steps.join(' → ')}`,
  );
  console.log(`readiness ${label}: ${steps.slice(0, 8).join(' → ')}`);

  // ------------------------------------- 3. damage cannot block the authority
  const survivor = (await rows()).rows[0];
  assert.ok(survivor, 'a record survived the reload');
  await writeRows(`
    const first = rows[0];
    // A broken checksum, a row from another environment, an impossible size
    // and a date from the future: four different kinds of damage at once.
    store.put({ ...first, checksum: 'deadbeef-1' });
    store.put({ ...first, environmentKey: payload.foreign, sessionId: 'foreign-session', path: '/foreign/session.jsonl' });
    store.put({ ...first, sessionId: 'oversize-session', path: '/oversize/session.jsonl', bytes: 99999999 });
    store.put({ ...first, sessionId: 'future-session', path: '/future/session.jsonl', capturedAt: new Date(Date.now() + 86400000).toISOString() });
  `, { foreign: 'e1.ZZZZZZZZZZZZZZZZZZZZZZ' });
  const damaged = await rows();
  assert.equal(damaged.rows.length, stored.rows.length + 3, 'the damage is really in the database');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor({ timeout: 60_000 });
  // The conversation still loads from its host, whatever this device held.
  await page.getByText('is complete.', { exact: false }).first().waitFor({ timeout: 60_000 });
  await until('the damaged rows to be discarded', async () => {
    const now = await rows();
    return !now.rows.some(row => ['foreign-session', 'oversize-session', 'future-session'].includes(row.sessionId))
      && !now.rows.some(row => row.checksum === 'deadbeef-1');
  });
  const cleaned = await rows();
  for (const gone of ['foreign-session', 'oversize-session', 'future-session']) {
    assert.ok(!cleaned.rows.some(row => row.sessionId === gone), `${gone} was discarded rather than read`);
  }
  assert.ok(!cleaned.rows.some(row => row.checksum === 'deadbeef-1'), 'the corrupt record was discarded');
  await check.shot(`device-cache-after-damage-${label}`);

  // ------------------------------- 4. nothing of a transcript is in a SW cache
  const cachedTranscript = await page.evaluate(async () => {
    if (typeof caches === 'undefined') return false;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (/\/ws|session|entries/.test(request.url)) return request.url;
      }
    }
    return false;
  });
  assert.equal(cachedTranscript, false, `no transcript request is in a service-worker cache: ${cachedTranscript}`);

  // --------------------------------------- 5. the surface, and the real clear
  const section = page.locator('[data-slot=device-cache-setting]');
  const showing = async (timeout = 5_000) => section.waitFor({ timeout }).then(() => true, () => false);
  // The install reminder can appear over any surface and swallow the choice
  // that opened this one (its handler dismisses it, but the tap is gone), so
  // getting here is retried rather than assumed.
  for (let attempt = 0; attempt < 3 && !(await showing(attempt === 0 ? 2_000 : 5_000)); attempt += 1) {
    const tab = page.getByRole('button', { name: 'This device', exact: true });
    if (await tab.count() === 0) {
      if (phone) await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
      await activate(page.getByRole('button', { name: 'Settings', exact: true }).first());
    }
    const reachable = page.getByRole('button', { name: 'This device', exact: true });
    await reachable.waitFor({ timeout: 15_000 });
    // The tab strip scrolls inside itself on a phone, so it is reached the way
    // a keyboard reaches it: focus the tab, then press it. A tap on a strip
    // that is still settling lands on the tab next door.
    await reachable.scrollIntoViewIfNeeded();
    await reachable.focus();
    await reachable.press('Enter');
  }
  await section.waitFor();
  const surface = scrub(await section.innerText());
  assert.match(surface, /Conversations on this device/, `the section names itself: ${surface}`);
  assert.match(surface, /kept here/, `it says what is kept: ${surface}`);
  assert.match(surface, /kept by this browser, unencrypted/, `a browser is never called encrypted: ${surface}`);
  assert.ok(!/IndexedDB|AES|RP-10|tail-cache/.test(surface), `no implementation vocabulary on screen: ${surface}`);

  const shape = await section.evaluate(node => {
    // `dt` is the eyebrow: 11px is its sanctioned size and it is a category
    // label, never a value (globals.css, DESIGN.md). Everything a person reads
    // as information is held to the 12px floor.
    const rows = [...node.querySelectorAll('p, dd, h3')].map(element => {
      const style = getComputedStyle(element);
      return {
        text: element.textContent.trim().slice(0, 60),
        size: Math.round(parseFloat(style.fontSize) * 10) / 10,
        // Really cut off, not merely allowed to be: the spec sheet truncates
        // long values on purpose and keeps them in a title. What must never
        // happen is a value that does not fit the width it was given.
        clipped: element.scrollWidth > element.clientWidth + 2,
      };
    });
    const labels = [...node.querySelectorAll('dt')].map(element => ({
      text: element.textContent.trim(),
      size: Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10,
      transform: getComputedStyle(element).textTransform,
    }));
    const button = node.querySelector('button').getBoundingClientRect();
    return { rows, labels, button: Math.round(button.height), overflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  for (const row of shape.rows) {
    assert.ok(row.size >= 12, `nothing drops below the legibility floor (${row.size}px: ${row.text})`);
    assert.equal(row.clipped, false, `nothing is cut off: ${row.text}`);
  }
  for (const label of shape.labels) {
    assert.equal(label.size, 11, `a row label is the eyebrow and nothing else (${label.size}px: ${label.text})`);
    assert.equal(label.transform, 'uppercase', `and it reads as a category, not a value: ${label.text}`);
  }
  assert.equal(shape.overflowsX, false, 'the section never makes the page scroll sideways');
  if (phone) assert.ok(shape.button >= 44, `the clear clears the coarse-pointer floor (${shape.button}px)`);
  await check.shot(`device-cache-settings-${label}`);

  // Reduced motion: the surface holds still, and nothing is animating.
  await check.reducedMotion(true);
  const animations = await section.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);
  assert.equal(animations, 0, 'nothing in the section animates under reduced motion');
  await check.shot(`device-cache-reduced-${label}`);
  await check.reducedMotion(false);

  // The keyboard path is the same path: focus, Enter, confirm.
  const clear = section.getByRole('button', { name: /Clear cached conversations/ });
  await clear.focus();
  assert.equal(await clear.evaluate(element => document.activeElement === element), true, 'the clear takes focus');
  await clear.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const dialogText = scrub(await dialog.innerText());
  assert.match(dialogText, /Anything you have typed and not sent is kept/, `the confirmation says what is safe: ${dialogText}`);
  await activate(dialog.getByRole('button', { name: /Clear cached conversations/ }));
  await until('the clear to empty this device', async () => (await rows()).rows.length === 0);
  const emptied = await rows();
  assert.equal(emptied.rows.length, 0, 'the clear really cleared');
  assert.match(scrub(await section.innerText()), /0 of \d+/, 'and the surface says so');
  await check.shot(`device-cache-cleared-${label}`);

  await page.keyboard.press('Escape');
  await composer.waitFor();
  watch.assertClean();
}
