import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * D-236: opening a conversation again starts at its recent tail, whatever was
 * paged in before. Older messages are still one control away, a question this
 * session is waiting on is still answerable, and an explicit destination (a
 * saved search result) still goes exactly where it says.
 */
export default async function reentry(check) {
  const { page } = check;
  const width = check.state.width;
  const touch = width === 390;
  const entryReads = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const value = JSON.parse(String(payload));
    if (value.method === 'pi/session/entries') entryReads.push(value.params);
  }));
  await check.touch(touch);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const label = `${width}-${check.state.theme}`;
  const root = join(check.root, `reentry-${label}`);
  const seeded = await seedFixture({ rpc: check.rpc }, { root, node: process.execPath, until }, 'long');
  const second = await seedFixture({ rpc: check.rpc }, { root: `${root}-b`, node: process.execPath, until }, 'long');
  const names = { first: `Re-entry A ${label}`, second: `Re-entry B ${label}`, asking: `Re-entry question ${label}` };
  await check.rpc('pi/session/rename', { path: seeded.path, name: names.first });
  await check.rpc('pi/session/rename', { path: second.path, name: names.second });

  // A session whose tool call is waiting for a person, in the same project.
  await check.rpc('mcp/save', { cwd: seeded.project, scope: 'global', server: { name: 'fixture', transport: { kind: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../../../packages/worker/test/mcp/fixtures/stdio-server.mjs', import.meta.url))] }, tools: { alwaysLoad: true, approve: true }, startup: 'on-demand' } });
  await check.rpc('mcp/inspect', { cwd: seeded.project, scope: 'global', name: 'fixture' });
  const asking = (await check.rpc('session/new', { cwd: seeded.project })).state.path;
  await check.rpc('pi/model/set', { path: asking, model: { provider: 'stub', id: 'stub-1' } });
  await check.rpc('pi/session/rename', { path: asking, name: names.asking });
  // The turn stops at the approval, so this request is not awaited: the card
  // arriving in the transcript is what this case is waiting for.
  const asked = check.rpc('session/prompt', { path: asking, content: [{ type: 'text', text: 'fixture-asking: please approve the fixture call' }] }).catch(() => {});

  // The app's socket predates this script; reload so its frames are observed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  const open = async name => {
    if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
    await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  };
  const openLong = async name => { await open(name); await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor(); };
  const earlierControl = () => page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
  const viewport = () => page.locator('[data-slot=thread-viewport]');
  /** The oldest message this surface has actually loaded, not merely mounted. */
  const oldestLoaded = async () => {
    // Scrolling to the start mounts its way there; read it once it has settled.
    let last;
    await until(async () => {
      await viewport().evaluate(element => { element.scrollTop = 0; });
      const row = page.locator('[data-role=user]').first();
      if (!await row.count()) return false;
      const value = /Review checkpoint (\d+):/.exec(await row.innerText())?.[1];
      const settled = value !== undefined && value === last;
      last = value;
      return settled;
    }, 'the top of the loaded transcript', 20000);
    return last;
  };
  const expand = async () => {
    for (let step = 0; step < 12 && await earlierControl().count(); step++) {
      const before = await oldestLoaded();
      await earlierControl().scrollIntoViewIfNeeded();
      await earlierControl().click();
      await until(async () => await oldestLoaded() !== before || await earlierControl().count() === 0, 'an earlier page to load', 20000);
    }
    assert.equal(await earlierControl().count(), 0, 'the whole conversation is loaded');
    assert.equal(await oldestLoaded(), '1', 'the first prompt is loaded');
  };

  await openLong(names.first);
  await expand();
  const expandedDom = await page.locator('[data-window-message]').count();
  assert(expandedDom < 80, `the expanded transcript stays bounded (${expandedDom} rows)`);

  // Ordinary re-entry: away and back.
  await openLong(names.second);
  entryReads.length = 0;
  await openLong(names.first);
  await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor({ state: 'visible' });
  const oldest = page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 1:' });
  assert.equal(await oldest.count(), 0, 'the old reading position is not restored');
  assert.equal(await earlierControl().count(), 1, 'older messages remain one control away');
  const windows = entryReads.filter(params => params.path === seeded.path).map(params => params.window);
  assert.deepEqual(windows, [{ tail: 40 }], `one authoritative tail read per return, got ${JSON.stringify(windows)}`);
  const returnedTop = await oldestLoaded();
  assert.equal(returnedTop, '101', `re-entry loads the last 40 messages, not from checkpoint ${returnedTop}`);
  const returnedDom = await page.locator('[data-window-message]').count();
  assert(returnedDom < 80, `the returned transcript stays bounded (${returnedDom} rows)`);

  // The same conversation is reachable again, with nothing duplicated or lost.
  await expand();
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-window-message]')].map(row => row.dataset.windowMessage));
  assert.equal(new Set(ids).size, ids.length, 'no message is mounted twice');

  // Repeat with the other long conversation: the rule is not a one-off.
  await openLong(names.second);
  await expand();
  await openLong(names.first);
  await openLong(names.second);
  assert.equal(await oldestLoaded(), '101', 'the second conversation also returns to its recent tail');

  // A question this session is waiting on survives its own re-entry.
  await open(names.asking);
  const allow = page.getByRole('button', { name: 'Allow once', exact: true });
  await allow.waitFor();
  await openLong(names.first);
  await open(names.asking);
  // The question is still here, and still the one thing this session waits on.
  await allow.waitFor();
  await allow.click();
  await allow.waitFor({ state: 'detached' });
  await until(async () => !(await check.rpc('session/load', { path: asking })).state.isStreaming, 'the approved tool call to finish', 30000);
  assert.equal(await page.getByText('Allow this?', { exact: true }).count(), 0, 'the answered question is gone');
  await asked;

  // An explicit destination still overrides the default latest position.
  await openLong(names.second);
  await composer.click();
  await composer.fill('an unsent draft');
  await composer.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('Review checkpoint 3:');
  const all = page.getByRole('button', { name: 'Load all messages', exact: true });
  if (await all.count()) { await all.click(); await all.waitFor({ state: 'detached' }); }
  await page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 3:' }).first().waitFor({ state: 'visible' });
  await find.press('Escape');
  assert.equal(await composer.inputValue(), 'an unsent draft', 'the draft survives re-entry and find');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  writeFileSync(join(check.root, `reentry-${label}.json`), JSON.stringify({ returnedTop, expandedDom, returnedDom, windows, question: 'answerable after re-entry' }, null, 2));
  await check.snapshot(); await check.shot('reentry');
}
