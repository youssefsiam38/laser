import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

const results = [];
const prompt = 'Review checkpoint 6: verify the implementation and explain the next step.';

export default async function historyActions(check) {
  const { page } = check;
  const requests = [];
  const paging = [];
  const wire = [];
  const captureSocket = socket => {
    const pending = new Map();
    socket.on('framesent', ({ payload }) => {
      const value = JSON.parse(String(payload));
      if (!value.method) return;
      const request = { method: value.method, params: value.params };
      requests.push(request);
      pending.set(value.id, request);
    });
    socket.on('framereceived', ({ payload }) => {
      const value = JSON.parse(String(payload));
      const request = pending.get(value.id);
      if (!request) return;
      request.settled = true;
      if (request.method === 'pi/session/entries') request.returned = value.result?.entries?.length;
      pending.delete(value.id);
      if (request.method === 'pi/session/fork') wire.push({ editorText: value.result?.editorText, path: value.result?.state?.path });
    });
  };
  page.on('websocket', captureSocket);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  await check.touch(check.state.width === 390);
  await check.reducedMotion(check.state.theme === 'light');
  await check.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Reuse the shared real-RPC fixture adapter, but give this mutation-heavy
  // case its own project/session. No inherited branch or remembered draft.
  const caseName = `History actions ${check.state.width} ${check.state.theme}`;
  check.fixture = await seedFixture({ rpc: check.rpc }, {
    root: join(check.root, `case-${check.state.width}-${check.state.theme}`), node: process.execPath, until,
  }, 'long');
  await check.rpc('pi/session/rename', { path: check.fixture.path, name: caseName });
  const entries = (await check.rpc('pi/session/entries', { path: check.fixture.path })).entries;
  assert.equal(entries.filter(entry => entry.type === 'message').length, 240);
  const originalLeaf = entries.filter(entry => entry.type === 'message').at(-1).id;
  const selectCase = async () => {
    if (check.state.width === 390) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: caseName }).first().click();
    await page.getByRole('main').getByRole('heading', { name: caseName, exact: true }).waitFor();
  };
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const old = () => page.locator('[data-role=user]').filter({ hasText: prompt });
  const entryReads = () => requests.filter(request => request.method === 'pi/session/entries');
  const allReads = () => entryReads().filter(request => request.params.window?.all);
  const noAllSince = count => assert.equal(allReads().length, count, 'the action must not fetch the complete history');
  const loadedCount = async () => {
    const label = await page.getByRole('button', { name: /^History \d+(?: loaded)?$/ }).innerText();
    return Number(label.match(/\d+/)?.[0]);
  };
  let loadRun = 0;
  const loadAll = async () => {
    loadRun += 1;
    const button = page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
    const loadingButton = page.getByRole('main').getByRole('button', { name: 'Loading earlier messages…', exact: true });
    // One press is one bounded page. Wait for that page to commit before the
    // next press, just as a person waits for the loading label to clear.
    await old().or(button).first().waitFor();
    const pages = [];
    while (await button.count()) {
      const before = await loadedCount();
      const readCount = entryReads().length;
      // Put the real control on screen without manufacturing a wheel/key
      // gesture, which is itself another supported request for an older page.
      await page.locator('[data-slot=thread-viewport]').evaluate(element => { element.scrollTop = 0; });
      await button.waitFor();
      await button.click();
      const request = await until(() => entryReads().length > readCount && entryReads().at(-1), 'one earlier-history request');
      await until(() => request.settled, 'the earlier-history response');
      await until(async () => (await loadedCount()) > before || (!(await button.count()) && !(await loadingButton.count())), 'one earlier-history page to commit');
      const after = await loadedCount();
      assert.ok(after > before, `one press must load entries (${before} -> ${after})`);
      assert.deepEqual(Object.keys(request.params.window).sort(), ['before', 'limit']);
      assert.equal(request.params.window.limit, 40);
      pages.push({ before, after, window: request.params.window, returned: request.returned });
      assert.ok(pages.length <= 10, '240 messages must not require more than ten presses');
    }
    assert.equal(pages.length, 5, '240 messages load from a 40-message tail in five presses');
    if (loadRun === 1) assert.deepEqual(pages.map(page => page.after - page.before), [40, 40, 40, 40, 44]);
    paging.push(pages);
    // Loaded rows outside the viewport are intentionally not mounted. Move to
    // the beginning before asking for the checkpoint-six action row.
    await page.locator('[data-slot=thread-viewport]').evaluate(element => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await old().waitFor();
    return pages;
  };
  const reset = async () => {
    await check.rpc('pi/session/navigate', { path: check.fixture.path, entryId: originalLeaf });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor();
    await selectCase();
    await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
    await loadAll();
  };
  const menu = async name => {
    // Leaf changes restore the viewport after the replacement rows commit.
    // Wait for that scroll to settle before bringing an older control back.
    await page.locator('[data-slot=thread-viewport]').evaluate(element => new Promise((resolve, reject) => {
      let last = element.scrollTop, stable = performance.now();
      const deadline = stable + 10000;
      const tick = () => {
        const now = performance.now();
        if (element.scrollTop !== last) { last = element.scrollTop; stable = now; }
        if (now - stable >= 500) resolve();
        else if (now >= deadline) reject(new Error('Transcript scrolling did not settle'));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    const more = old().getByRole('button', { name: 'More', exact: true });
    if (check.state.touch) await more.tap(); else await more.click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  await reset();
  assert.equal(await loadedCount(), 244, 'all 240 messages and their four retained context records are loaded');

  // Non-mutating neighbours must resolve the older prompt, not the tail ordinal.
  let count = allReads().length;
  await menu('Copy session path');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), check.fixture.path);
  const olderPromptText = await old().innerText();
  assert.ok(olderPromptText.includes('Review checkpoint 6:'), 'the selected row belongs to checkpoint 6');
  assert.ok(!olderPromptText.includes('Review checkpoint 7:'), 'the selected row is not the next prompt');
  await menu('View API request');
  const dialog = page.getByRole('dialog', { name: 'API request', exact: true });
  await dialog.getByRole('heading', { name: 'Only this request’s summary was kept', exact: true }).waitFor();
  assert.equal(await dialog.getByText('12', { exact: true }).count(), 1, 'the request belongs to checkpoint 6');
  assert.equal(await dialog.getByText('14', { exact: true }).count(), 0, 'not the next prompt request');
  await check.shot('older-request');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  noAllSince(count);
  count = allReads().length;
  await menu('Fork from here');
  await page.waitForFunction(expected => document.querySelector('textarea[aria-label="Message"]')?.value === expected, prompt);
  assert.equal(await composer.inputValue(), prompt);
  assert.equal(await page.locator('[data-message-id]').count(), 10);
  assert.equal(wire.at(-1).editorText, prompt);
  noAllSince(count);
  await check.shot('fork-prompt');

  await selectCase();
  await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '', 'fork prompt did not leak into the original composer');
  await loadAll();
  count = allReads().length;
  await old().getByRole('button', { name: 'Edit', exact: true }).click();
  const editedText = `Review checkpoint ${9999 + results.length}: older-message edit`;
  const editor = page.getByRole('textbox', { name: 'Edited message', exact: true });
  await editor.fill(editedText);
  await page.locator('[data-role=user]').filter({ has: editor }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(`Checkpoint ${9999 + results.length} is complete.`, { exact: true }).waitFor();
  const other = page.getByRole('button', { name: 'Load other versions', exact: true });
  if (await other.count()) { await other.scrollIntoViewIfNeeded(); await other.click(); }
  const edited = () => page.locator('[data-role=user]').filter({ hasText: editedText });
  await edited().getByRole('button', { name: 'Previous version', exact: true }).click();
  await old().waitFor();
  const next = old().getByRole('button', { name: 'Next version', exact: true });
  await next.waitFor();
  await old().getByLabel('Version 1 of 2', { exact: true }).waitFor();
  assert.equal(await next.isEnabled(), true);
  assert.equal(await other.count(), 0, 'known versions remain loaded');
  await old().scrollIntoViewIfNeeded();
  await check.shot('previous-version-controls');
  await next.focus();
  await next.press('Enter');
  await edited().waitFor();
  await edited().getByRole('button', { name: 'Previous version', exact: true }).waitFor();
  await edited().getByLabel('Version 2 of 2', { exact: true }).waitFor();
  noAllSince(count);
  await check.shot('next-version');
  await edited().getByRole('button', { name: 'Previous version', exact: true }).click();
  await old().waitFor();

  count = allReads().length;
  await menu('Jump to this entry');
  await page.waitForFunction(expected => document.querySelector('textarea[aria-label="Message"]')?.value === expected, prompt);
  assert.equal(await composer.inputValue(), prompt);
  assert.equal(await page.locator('[data-message-id]').count(), 10);
  noAllSince(count);
  await check.shot('older-jump');
  await composer.fill('');
  await reset();
  count = allReads().length;
  const reply = page.locator('[data-role=assistant]').filter({ hasText: 'Checkpoint 6 is complete.' });
  await reply.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-id]').length === 12 && !document.querySelector('[data-streaming=true]'));
  assert.equal(await old().count(), 1);
  assert.equal(await page.getByText('Checkpoint 6 is complete.', { exact: true }).count(), 1);
  assert.equal(await composer.inputValue(), '');
  noAllSince(count);
  await check.shot('older-retry');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await check.snapshot();
  page.off('websocket', captureSocket);
  results.push({ ...check.state, project: check.fixture.project, path: check.fixture.path, wire: wire.slice(), forkPrompt: prompt, versionsRetained: true, versionLabels: ['1 / 2', '2 / 2'], neighbours: ['Edit', 'Jump', 'Retry', 'Copy session path', 'View API request'], paging, requests: requests.map(({ settled: _settled, ...request }) => request) });
  writeFileSync(join(check.root, 'history-actions.json'), JSON.stringify(results, null, 2));
  await check.rpc('pi/session/navigate', { path: check.fixture.path, entryId: originalLeaf });
}
