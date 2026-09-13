import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

const results = [];

/**
 * The API request inspector while the session behind it streams (M16-T35).
 *
 * A person opens a message's ⋯ → View API request and leaves it open. Work
 * keeps arriving in that session: deltas, a new user message, and — when the
 * turn settles — a fresh read of the session's entries. None of that is about
 * the capture on screen, so nothing in the open dialog may blink: no loader
 * coming back, no capture chosen for the person, no second fetch of a body
 * that did not change.
 *
 * The counters are what a person would see, watched from inside the dialog
 * with a MutationObserver, plus the `pi/logs/*` traffic on the wire.
 */
export default async function apiRequestFlicker(check) {
  const { page } = check;
  const width = check.state.width;
  const calls = [];
  const onSocket = socket => socket.on('framesent', ({ payload }) => {
    const value = JSON.parse(String(payload));
    if (value.method === 'pi/logs/query' || value.method === 'pi/logs/content') calls.push({ method: value.method, params: value.params });
  });
  page.on('websocket', onSocket);
  const touch = width === 390;
  await check.touch(touch);
  /** A transcript row off the fold is mounted but not painted (the window uses
   * `content-visibility`), so scroll it into view from the page itself and
   * then wait for its controls to become actionable. */
  const bring = async row => {
    await row.waitFor({ state: 'attached' });
    await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await row.getByRole('button', { name: 'More', exact: true }).waitFor();
  };
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  // On a phone the install invitation can arrive at any moment and covers the
  // dialog. A person dismisses it; it is not what this check watches, and the
  // observer below is scoped to the dialog, so it is not what it counts.
  const dismissInstall = async () => {
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });
    if (await notNow.count()) await notNow.click({ timeout: 5000 }).catch(() => {});
  };
  const label = `${width}-${check.state.theme}`;
  // Its own project and session: this case streams new turns into the session
  // it opens the inspector on, so it cannot inherit another case's history.
  const caseName = `API request ${label}`;
  const seeded = await seedFixture({ rpc: check.rpc }, { root: join(check.root, `case-${label}`), node: process.execPath, until }, 'tools');
  await check.rpc('pi/session/rename', { path: seeded.path, name: caseName });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  // Open the session this case seeded: the inspector must be looking at the
  // session the turn below streams into, not at whatever was selected last.
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: caseName }).first().click();
  await page.getByRole('main').getByRole('heading', { name: caseName, exact: true }).waitFor();
  // The tools fixture ends on the goal it set; that prompt is the newest one.
  await page.getByText('Verify the fixture implementation.').first().waitFor({ timeout: 30000 });

  // The newest prompt: the one whose window has no next user message yet, so
  // a turn arriving after it is exactly what used to move its identity.
  await dismissInstall();
  const target = page.locator('[data-role=user]').last();
  await bring(target);
  const targetText = (await target.innerText()).trim();
  const more = target.getByRole('button', { name: 'More', exact: true });
  if (touch) await more.tap(); else await more.click();
  await page.getByRole('menuitem', { name: 'View API request', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'API request', exact: true });
  const captures = dialog.locator('select[aria-label="Captured request"]');
  await dialog.locator('[data-slot=request-viewport]').waitFor({ timeout: 30000 });
  await captures.waitFor();
  const selectedBefore = await captures.inputValue();
  const optionsBefore = await captures.locator('option').count();
  assert.ok(optionsBefore > 0, `the inspector found no capture for "${targetText}"; this check needs a captured request to watch`);
  const bodyBefore = (await dialog.locator('[data-slot=request-viewport]').innerText()).slice(0, 200);
  await check.shot(`api-request-open-${label}`);

  // Everything from here is flicker: the dialog is already showing a capture.
  const quiet = calls.length;
  await page.evaluate(() => {
    const dialog = document.querySelector('[role=dialog]');
    const state = { loaders: 0, bodyRemoved: 0, captureBarRemoved: 0, selectionChanges: 0, commits: 0 };
    window.__inspector = state;
    const picker = () => dialog.querySelector('select[aria-label="Captured request"]');
    state.selected = picker()?.value;
    state.options = picker()?.options.length;
    const observer = new MutationObserver(mutations => {
      state.commits++;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[data-slot=generation-loader]') || node.querySelector?.('[data-slot=generation-loader]')) state.loaders++;
        }
        for (const node of mutation.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[data-slot=request-viewport]') || node.querySelector?.('[data-slot=request-viewport]')) state.bodyRemoved++;
          if (node.matches('select[aria-label="Captured request"]') || node.querySelector?.('select[aria-label="Captured request"]')) state.captureBarRemoved++;
        }
      }
      const current = picker();
      if (!current) return;
      if (current.value !== state.selected) { state.selectionChanges++; state.selected = current.value; }
      state.options = current.options.length;
    });
    observer.observe(dialog, { childList: true, subtree: true });
  });

  // A real streaming turn in the session the dialog belongs to. The composer
  // is behind a modal, so this is the same prompt over the host's own RPC.
  await check.rpc('session/prompt', { path: seeded.path, content: [{ type: 'text', text: 'fixture-stream: keep talking for a while' }] });
  await page.waitForTimeout(4000);
  await until(async () => !(await check.rpc('session/load', { path: seeded.path })).state.isStreaming, 'the turn to settle', 90000);
  // Settling is when the transcript re-reads its entries; give that commit,
  // and anything it would trigger in the dialog, room to happen.
  await page.waitForTimeout(2000);

  await dismissInstall();
  const streaming = await page.evaluate(() => window.__inspector);
  const reloads = calls.slice(quiet);
  await check.shot(`api-request-streamed-${label}`);
  console.log('api request flicker', JSON.stringify({ ...streaming, reloads: reloads.map(call => call.method), target: targetText }));
  assert.equal(reloads.length, 0, `the open inspector re-issued ${reloads.length} log request(s) (${reloads.map(call => call.method).join(', ')}) for a capture that did not change`);
  assert.equal(streaming.loaders, 0, `a loader appeared ${streaming.loaders} times inside the open inspector while the session streamed`);
  assert.equal(streaming.bodyRemoved, 0, `the request body was torn down ${streaming.bodyRemoved} times while the session streamed`);
  assert.equal(streaming.captureBarRemoved, 0, `the capture picker was replaced ${streaming.captureBarRemoved} times while the session streamed`);
  assert.equal(streaming.selectionChanges, 0, 'the selected capture changed under the person');
  assert.equal(await captures.inputValue(), selectedBefore, 'the selected capture is no longer the one the person was reading');
  assert.equal(await captures.locator('option').count(), optionsBefore, 'the capture list changed under the person');
  assert.equal((await dialog.locator('[data-slot=request-viewport]').innerText()).slice(0, 200), bodyBefore, 'the request body changed under the person');

  // Deliberate change still works: Refresh asks again for the same message,
  // keeps what is on screen while it does, and offers what it finds.
  const beforeRefresh = calls.length;
  await dialog.getByRole('button', { name: 'Refresh captured requests', exact: true }).click();
  await until(async () => calls.length > beforeRefresh, 'Refresh to ask the host again', 15000);
  await page.waitForTimeout(1000);
  const refreshed = await page.evaluate(() => window.__inspector);
  const query = calls.slice(beforeRefresh).find(call => call.method === 'pi/logs/query');
  assert.ok(query, 'Refresh did not re-query the captures');
  assert.equal(query.params.sessionPath, seeded.path, 'Refresh asked for a different session');
  assert.equal(refreshed.loaders, 0, 'Refresh blanked the inspector instead of keeping what it was showing');
  assert.equal(refreshed.bodyRemoved, 0, 'Refresh tore down the request body it was already showing');
  assert.equal(await captures.inputValue(), selectedBefore, 'Refresh chose a different capture for the person');
  assert.ok((await captures.locator('option').count()) >= optionsBefore, 'Refresh dropped captures it had already offered');

  // And a different message is still a different request.
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  // The prompt that arrived while the dialog was open: a different message,
  // and the one the frozen target deliberately does not follow.
  const other = page.locator('[data-role=user]').filter({ hasText: 'fixture-stream: keep talking' }).last();
  // The long answer pushed its own prompt out of the transcript's window;
  // scroll back up the way a person would until that row is mounted again.
  const viewport = page.locator('[data-slot=thread-viewport]');
  await until(async () => {
    if (await other.count()) return true;
    await viewport.evaluate(element => element.scrollBy(0, -2000));
    await page.waitForTimeout(250);
    return (await other.count()) > 0;
  }, 'the prompt that arrived while the inspector was open', 45000);
  await bring(other);
  const otherText = (await other.innerText()).trim();
  assert.notEqual(otherText, targetText, 'the streamed turn did not add a second prompt to open the inspector on');
  const otherMore = other.getByRole('button', { name: 'More', exact: true });
  if (touch) await otherMore.tap(); else await otherMore.click();
  await page.getByRole('menuitem', { name: 'View API request', exact: true }).click();
  await dialog.locator('[data-slot=request-viewport]').waitFor({ timeout: 30000 });
  await dialog.getByRole('button', { name: /^Conversation / }).click();
  await dialog.getByRole('heading', { name: 'Conversation', exact: true }).waitFor();
  const conversation = await dialog.innerText();
  assert.ok(conversation.includes('fixture-stream: keep talking for a while'), `opening the inspector on "${otherText}" showed another message's request`);
  await check.shot(`api-request-other-message-${label}`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  page.off('websocket', onSocket);
  results.push({ ...check.state, path: seeded.path, target: targetText, other: otherText, streaming, refreshed, optionsBefore, selectedBefore });
  writeFileSync(join(check.root, 'api-request-flicker.json'), JSON.stringify(results, null, 2));
  return streaming;
}
