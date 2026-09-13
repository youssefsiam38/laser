import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * D-236: opening a conversation again starts at its recent tail, whatever was
 * paged in before. Older messages are still one scroll away, and an explicit
 * destination (a saved search result) still goes exactly where it says.
 */
export default async function reentry(check) {
  const { page } = check;
  const width = check.state.width;
  const entryReads = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const value = JSON.parse(String(payload));
    if (value.method === 'pi/session/entries') entryReads.push(value.params);
  }));
  await check.touch(width === 390);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const root = join(check.root, `reentry-${width}-${check.state.theme}`);
  const seeded = await seedFixture({ rpc: check.rpc }, { root, node: process.execPath, until }, 'long');
  const second = await seedFixture({ rpc: check.rpc }, { root: `${root}-b`, node: process.execPath, until }, 'long');
  const names = { first: `Re-entry A ${width}`, second: `Re-entry B ${width}` };
  await check.rpc('pi/session/rename', { path: seeded.path, name: names.first });
  await check.rpc('pi/session/rename', { path: second.path, name: names.second });

  // The app's socket predates this script; reload so its frames are observed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const open = async name => {
    if (width === 390) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
    await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
  };
  const slider = page.getByRole('slider', { name: /^Conversation map:/ });
  const turns = async () => Number(await slider.getAttribute('aria-valuemax'));
  const loaded = () => page.locator('[data-window-message]').count();
  const earlierControl = () => page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
  const expand = async () => {
    // The map counts canonical turns; the oldest row is far outside the
    // mounted window until something navigates to it.
    for (let step = 0; step < 12 && await turns() < 120; step++) {
      await until(async () => await earlierControl().count() === 1, 'the earlier-messages control', 15000);
      const before = await turns();
      await earlierControl().scrollIntoViewIfNeeded();
      await earlierControl().click();
      await until(async () => await turns() > before, 'an earlier page to load', 15000);
    }
    assert.equal(await turns(), 120, 'the whole conversation is loaded');
  };
  const goToFirstTurn = async () => {
    await slider.focus(); await slider.press('Home'); await slider.press('Enter');
    await page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 1:' }).first().waitFor({ state: 'visible' });
  };

  await open(names.first);
  await expand();
  const oldest = page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 1:' }).first();
  await goToFirstTurn();
  const expandedDom = await loaded();
  assert(expandedDom < 80, `the expanded transcript stays bounded (${expandedDom} rows)`);

  // Ordinary re-entry: away and back.
  await open(names.second);
  entryReads.length = 0;
  await open(names.first);
  const returned = await turns();
  assert.equal(returned, 20, `re-entry shows the recent tail, not ${returned} turns`);
  await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor({ state: 'visible' });
  await assert.rejects(oldest.waitFor({ state: 'visible', timeout: 1000 }), 'the old reading position is not restored');
  const returnedDom = await loaded();
  assert(returnedDom < 80, `the returned transcript stays bounded (${returnedDom} rows)`);
  const windows = entryReads.filter(params => params.path === seeded.path).map(params => params.window);
  assert(windows.length > 0, 'the re-entry read the session again');
  assert(windows.every(window => window?.tail === 40), `re-entry reads the recent tail, got ${JSON.stringify(windows)}`);
  assert.equal(await earlierControl().count(), 1, 'older messages remain one scroll away');

  // The same conversation is reachable again, with nothing duplicated or lost.
  await expand();
  await goToFirstTurn();
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-window-message]')].map(row => row.dataset.windowMessage));
  assert.equal(new Set(ids).size, ids.length, 'no message is mounted twice');

  // Repeat with the other long conversation: the rule is not a one-off.
  await open(names.second);
  await expand();
  await open(names.first);
  await open(names.second);
  assert.equal(await turns(), 20, 'the second conversation also returns to its recent tail');

  // An explicit destination still overrides the default latest position.
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.click();
  await composer.fill('an unsent draft');
  await composer.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('Review checkpoint 3:');
  const all = page.getByRole('button', { name: 'Load all messages', exact: true });
  if (await all.count()) { await all.click(); await all.waitFor({ state: 'detached' }); }
  const target = page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 3:' }).first();
  await target.waitFor({ state: 'visible' });
  await find.press('Escape');
  assert.equal(await composer.inputValue(), 'an unsent draft', 'the draft survives re-entry and find');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  writeFileSync(join(check.root, `reentry-${width}-${check.state.theme}.json`), JSON.stringify({ returned, expandedDom, returnedDom, windows }, null, 2));
  await check.snapshot(); await check.shot('reentry');
}
