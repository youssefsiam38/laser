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
  const wire = [];
  const captureSocket = socket => {
    const pending = new Map();
    socket.on('framesent', ({ payload }) => {
      const value = JSON.parse(String(payload));
      if (!value.method) return;
      requests.push({ method: value.method, params: value.params });
      pending.set(value.id, value.method);
    });
    socket.on('framereceived', ({ payload }) => {
      const value = JSON.parse(String(payload));
      if (pending.get(value.id) === 'pi/session/fork') wire.push({ editorText: value.result?.editorText, path: value.result?.state?.path });
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
  const originalLeaf = entries.filter(entry => entry.type === 'message').at(-1).id;
  const selectCase = async () => {
    if (check.state.width === 390) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: caseName }).first().click();
    await page.getByRole('main').getByRole('heading', { name: caseName, exact: true }).waitFor();
  };
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const old = () => page.locator('[data-role=user]').filter({ hasText: prompt });
  const allReads = () => requests.filter(request => request.method === 'pi/session/entries' && request.params.window?.all);
  const noAllSince = count => assert.equal(allReads().length, count, 'the action must not fetch the complete history');
  const loadAll = async () => {
    const button = page.getByRole('main').getByRole('button', { name: 'Load complete history', exact: true });
    // A destination may still be replacing its tail when the sidebar click
    // returns. Wait for either the loaded prompt or its explicit load control.
    await old().or(button).first().waitFor();
    if (await button.count()) {
      await button.scrollIntoViewIfNeeded();
      await button.focus();
      await button.press('Enter');
    }
    await old().waitFor();
    await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
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
  assert.equal(await page.locator('[data-message-id]').count(), 240);

  // Non-mutating neighbours must resolve the older prompt, not the tail ordinal.
  let count = allReads().length;
  await menu('Copy session path');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), check.fixture.path);
  await menu('View API request');
  const dialog = page.getByRole('dialog', { name: 'API request', exact: true });
  await dialog.getByRole('button', { name: 'Search request', exact: true }).waitFor();
  await dialog.getByRole('button', { name: /^Conversation / }).click();
  await dialog.getByRole('heading', { name: 'Conversation', exact: true }).waitFor();
  assert.ok((await dialog.innerText()).includes('Review checkpoint 6:'), 'the request belongs to checkpoint 6');
  assert.ok(!(await dialog.innerText()).includes('Review checkpoint 7:'), 'not the next prompt request');
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
  results.push({ ...check.state, project: check.fixture.project, path: check.fixture.path, wire: wire.slice(), forkPrompt: prompt, versionsRetained: true, versionLabels: ['1 / 2', '2 / 2'], neighbours: ['Edit', 'Jump', 'Retry', 'Copy session path', 'View API request'], requests: requests.slice() });
  writeFileSync(join(check.root, 'history-actions.json'), JSON.stringify(results, null, 2));
  await check.rpc('pi/session/navigate', { path: check.fixture.path, entryId: originalLeaf });
}
