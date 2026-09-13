import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * The Logs page while work is streaming in: rows arrive live, and nothing on
 * the page may blink, remount or jump while they do. Counts what a person
 * would see as flicker — the list root being replaced, a loading indicator
 * appearing, the viewport's scroll position moving on its own, and the
 * selected row's detail vanishing — over a burst of tool-heavy turns.
 */
export default async function logsFlicker(check) {
  const { page } = check;
  const width = check.state.width;
  const queries = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const value = JSON.parse(String(payload));
    if (value.method === 'pi/logs/query') queries.push(value.params);
  }));
  const touch = width === 390;
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const label = `${width}-${check.state.theme}`;
  const root = join(check.root, `logs-${label}`);
  const seeded = await seedFixture({ rpc: check.rpc }, { root, node: process.execPath, until }, 'tools');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  // Stream a long turn from the composer, so the session this page belongs to
  // is really streaming — the transcript mounted, deltas arriving — while the
  // Logs page is open over it. That is when a person sees this.
  await composer.click();
  await composer.pressSequentially('fixture-stream: keep talking for a while', { delay: 5 });
  const send = page.getByRole('button', { name: /Send/i }).first();
  if (await send.count()) await send.click(); else await composer.press('Enter');
  try { await page.getByText(/Streaming line 1:/).first().waitFor({ timeout: 20000 }); }
  catch (error) { await check.shot(`logs-send-failed-${label}`); console.log('composer value:', await composer.inputValue().catch(() => '?'), '| main text:', (await page.getByRole('main').innerText().catch(() => '')).slice(0, 400).replace(/\s+/g, ' ')); throw error; }
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Logs', exact: true }).first().click();
  const list = page.locator('[data-slot=logs-list], [role=list]').first();
  await page.getByText(/tool|provider|bash/i).first().waitFor({ timeout: 20000 });
  // The first page has landed and nothing is loading: only live rows from here.
  await until(async () => (await page.locator('[role=list] li').count()) > 0 && (await page.getByText('Loading log pages').count()) === 0, 'the first log page', 20000);
  await page.waitForTimeout(500);
  const queriesBefore = queries.length;

  // Observe from inside the page: remounts, loaders, scroll resets.
  await page.evaluate(() => {
    const main = document.body;
    const state = { listRemoved: 0, loaders: 0, scrollJumps: 0, rowsRemoved: 0, rowsAdded: 0, commits: 0, detailRemoved: 0 };
    window.__flicker = state;
    const viewport = () => main.querySelector('[data-slot=logs-viewport]') ?? [...main.querySelectorAll('div')].find(d => getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > d.clientHeight);
    let lastTop = viewport()?.scrollTop ?? 0;
    const observer = new MutationObserver(mutations => {
      state.commits++;
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[role=list]') || node.querySelector?.('[role=list]')) state.listRemoved++;
          if (node.matches('[role=listitem], [data-slot=log-row]')) state.rowsRemoved++;
          if (node.matches('[data-slot=log-detail]') || node.querySelector?.('[data-slot=log-detail]')) state.detailRemoved++;
        }
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[role=listitem], [data-slot=log-row]')) state.rowsAdded++;
          if (node.matches('[role=status]') || node.querySelector?.('[aria-label*="Loading"]') || /Loading log/.test(node.textContent ?? '')) state.loaders++;
        }
      }
      const v = viewport();
      if (v) {
        const top = v.scrollTop;
        // A jump that is not "follow to the bottom" and not a person's scroll.
        const atBottom = Math.abs(v.scrollHeight - v.clientHeight - top) <= 2;
        if (Math.abs(top - lastTop) > 40 && !atBottom) state.scrollJumps++;
        lastTop = top;
      }
    });
    observer.observe(main, { childList: true, subtree: true });
  });

  // Watch while that turn streams under the page, then a second one.
  await page.waitForTimeout(4000);
  await check.rpc('session/prompt', { path: seeded.path, content: [{ type: 'text', text: 'fixture-stream: and again' }] }).catch(() => {});
  await page.waitForTimeout(4000);
  await until(async () => !(await check.rpc('session/load', { path: seeded.path })).state.isStreaming, 'turns to settle', 90000);
  await page.waitForTimeout(1500);

  const stats = await page.evaluate(() => window.__flicker);
  await check.shot(`logs-${label}`);
  const reloads = queries.length - queriesBefore;
  console.log('logs flicker', JSON.stringify({ ...stats, reloads }));
  assert.equal(reloads, 0, `the page re-queried the store ${reloads} times while rows streamed in; a live page appends, it does not reload`);
  assert.equal(stats.listRemoved, 0, `the log list was replaced ${stats.listRemoved} times while rows streamed in`);
  assert.equal(stats.loaders, 0, `a loading indicator appeared ${stats.loaders} times while rows streamed in`);
  assert.equal(stats.scrollJumps, 0, `the viewport jumped ${stats.scrollJumps} times on its own`);
  return stats;
}
