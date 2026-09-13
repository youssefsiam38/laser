import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * Reading upwards in a long conversation must never blank the app.
 *
 * Before 0.6.1 it did: the bounded transcript unmounts many rows per scroll
 * burst, each `MessagePrimitive.Root` reported "not hovering" as it left, and
 * that many state dispatches in one cleanup exceeded React's nested-update
 * limit — an uncaught throw that unmounted the whole tree. This scrolls the
 * way a person does: with the wheel, pointer over the transcript, to the very
 * top, page after page. It fails on the first uncaught page error or an empty
 * main region, and only passes once the first message is on screen.
 */
export default async function scrollUpBlank(check) {
  const { page } = check;
  const width = check.state.width;
  const touch = width === 390;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error?.stack ?? error)));
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const label = `${width}-${check.state.theme}`;
  const root = join(check.root, `scroll-${label}`);
  const seeded = await seedFixture({ rpc: check.rpc }, { root, node: process.execPath, until }, 'huge');
  let name = `Scroll up ${label}`;
  await check.rpc('pi/session/rename', { path: seeded.path, name });
  // SCROLL_SESSION=<a real session .jsonl>: copied beside the seeded one with
  // its cwd rewritten to the fixture project, never printed. The synthetic
  // fixture did not reproduce the 0.6.0 black window; a real conversation with
  // tool results, reasoning and a compaction did, every time.
  if (process.env.SCROLL_SESSION) {
    const lines = readFileSync(process.env.SCROLL_SESSION, 'utf8').split('\n').filter(Boolean);
    const header = JSON.parse(lines[0]); header.cwd = seeded.project; delete header.parentSession; lines[0] = JSON.stringify(header);
    const copy = join(dirname(seeded.path), `real-${basename(process.env.SCROLL_SESSION)}`);
    writeFileSync(copy, lines.join('\n') + '\n');
    await until(async () => (await check.rpc('pi/session/list', { cwd: seeded.project })).sessions.some(s => s.path === copy), 'the real session in the catalog', 30000);
    name = `Real ${label}`; await check.rpc('pi/session/rename', { path: copy, name });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
  await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  if (process.env.SCROLL_SESSION) await page.waitForTimeout(1500);
  else await page.getByText('Checkpoint 1000 is complete.', { exact: true }).waitFor();

  const viewport = page.locator('[data-slot=thread-viewport]');
  const box = await viewport.boundingBox();
  assert.ok(box, 'the transcript viewport is on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const mainText = async () => (await page.getByRole('main').innerText().catch(() => '')).trim();
  const oldest = async () => {
    const row = page.locator('[data-role=user]').first();
    if (!await row.count()) return undefined;
    return /Review checkpoint (\d+):/.exec(await row.innerText())?.[1];
  };
  const seen = [];
  for (let round = 0; round < 120 && !pageErrors.length; round++) {
    // Wheel up in bursts, the way a trackpad reads history.
    for (let step = 0; step < 12; step++) {
      if (touch) {
        // A finger drag downwards reads upwards: touchstart, a moving touchmove, then the scroll.
        await viewport.evaluate((el, { x, y }) => {
          const at = (clientY) => new Touch({ identifier: 1, target: el, clientX: x, clientY });
          el.dispatchEvent(new TouchEvent('touchstart', { touches: [at(y)], bubbles: true }));
          el.dispatchEvent(new TouchEvent('touchmove', { touches: [at(y + 120)], bubbles: true }));
          el.scrollTop -= 900;
          el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
        }, { x: box.x + box.width / 2, y: box.y + box.height * 0.3 });
      }
      else await page.mouse.wheel(0, -900);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(250);
    if (!(await mainText())) break;
    seen.push(await oldest());
    if (seen.at(-1) === '1' && await viewport.evaluate(el => el.scrollTop) === 0) break;
    if (process.env.SCROLL_SESSION && await viewport.evaluate(el => el.scrollTop) === 0 && !await page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true }).count()) break;
  }
  await check.shot(`scroll-up-${label}`);
  assert.equal(pageErrors.length, 0, `uncaught page errors while scrolling up:\n${pageErrors.join('\n\n')}`);
  assert.ok((await mainText()).length > 0, `the main region went blank while scrolling up (oldest seen: ${seen.join(',')})`);
  const earlier = page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
  if (process.env.SCROLL_SESSION) assert.equal(await earlier.count(), 0, `earlier pages remain after ${seen.length} rounds of wheel at the top`);
  else assert.equal(await oldest(), '1', `did not reach the first message in ${seen.length} rounds (oldest seen: ${seen.join(',')})`);
  return { rounds: seen.length };
}
