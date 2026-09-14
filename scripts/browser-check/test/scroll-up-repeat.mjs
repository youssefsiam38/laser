import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * Reading upwards must show every message once. Each wheel burst records the
 * checkpoints visible in the mounted rows, in order; a checkpoint that appears
 * twice in the DOM, or a sequence that runs backwards, is a repeated page.
 */
export default async function scrollUpRepeat(check) {
  const { page } = check;
  const width = check.state.width;
  const touch = width === 390;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error?.stack ?? error)));
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const label = `${width}-${check.state.theme}`;
  const seeded = await seedFixture({ rpc: check.rpc }, { root: join(check.root, `repeat-${label}`), node: process.execPath, until }, 'huge');
  let name = `Repeat ${label}`;
  await check.rpc('pi/session/rename', { path: seeded.path, name });
  const real = process.env.SCROLL_SESSION;
  if (real) {
    const lines = readFileSync(real, 'utf8').split('\n').filter(Boolean);
    const header = JSON.parse(lines[0]); header.cwd = seeded.project; delete header.parentSession; lines[0] = JSON.stringify(header);
    const copy = join(dirname(seeded.path), `real-${basename(real)}`);
    writeFileSync(copy, lines.join('\n') + '\n');
    await until(async () => (await check.rpc('pi/session/list', { cwd: seeded.project })).sessions.some(s => s.path === copy), 'the real session in the catalog', 30000);
    name = `Real ${label}`; await check.rpc('pi/session/rename', { path: copy, name });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
  await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  if (real) await page.waitForTimeout(1500); else await page.getByText('Checkpoint 1000 is complete.', { exact: true }).waitFor();
  const viewport = page.locator('[data-slot=thread-viewport]');
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Every mounted message, in DOM order: its id, and for the synthetic fixture its checkpoint number.
  const rows = async () => page.locator('[data-window-message]').evaluateAll(els => els.map(el => ({
    id: el.getAttribute('data-window-message'),
    text: el.innerText.slice(0, 60),
    n: /Review checkpoint (\d+):/.exec(el.innerText)?.[1],
  })));
  const problems = [];
  let oldest;
  // The checkpoint the person is actually looking at: the first user row whose bottom is below the viewport's top.
  const visible = async () => viewport.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll('[data-role=user]')) {
      if (row.getBoundingClientRect().bottom > top) return /Review checkpoint (\d+):/.exec(row.innerText)?.[1];
    }
    return undefined;
  });
  const trail = [];
  // Paced like a person reading: a wheel notch, then a pause long enough for
  // the page to arrive and the viewport's reading window to close (SLOW=1),
  // or the trackpad bursts the blank-window check uses.
  const slow = process.env.SLOW === '1';
  for (let round = 0; round < (slow ? 400 : 120) && !pageErrors.length; round++) {
    if (slow) {
      const before = await viewport.evaluate(el => [el.scrollTop, el.scrollHeight]);
      await page.mouse.wheel(0, -500);
      const samples = [];
      for (const wait of [60, 150, 250, 200]) { await page.waitForTimeout(wait); samples.push(await viewport.evaluate(el => `${Math.round(el.scrollTop)}/${el.scrollHeight}`)); }
      if (process.env.TRACE) console.log(`wheel ${round}: before ${before.join('/')} → ${samples.join(' → ')} · top row ${await visible()}`);
    }
    else { for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(30); } await page.waitForTimeout(250); }
    const mounted = await rows();
    const ids = mounted.map(r => r.id);
    const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
    if (dupIds.length) problems.push(`round ${round}: message ids mounted twice: ${[...new Set(dupIds)].join(',')}`);
    const texts = mounted.map(r => r.text).filter(t => t.length > 20);
    const dupText = texts.filter((v, i) => texts.indexOf(v) !== i);
    if (dupText.length) problems.push(`round ${round}: same content mounted twice: ${[...new Set(dupText)].slice(0, 3).join(' | ')}`);
    const seen = mounted.map(r => r.n).filter(Boolean);
    for (let i = 1; i < seen.length; i++) if (Number(seen[i]) <= Number(seen[i - 1])) { problems.push(`round ${round}: out of order at ${seen[i - 1]}→${seen[i]}`); break; }
    oldest = seen[0];
    const now = await visible();
    // Reading upwards, what is at the top of the screen only ever gets older.
    // A later checkpoint reappearing means the view was moved back down and
    // the person is being shown the same section again.
    if (now && trail.length && Number(now) > Number(trail.at(-1)) + 1) problems.push(`round ${round}: view jumped back from checkpoint ${trail.at(-1)} to ${now}`);
    // One wheel notch reads a message or two. A whole page per notch means the
    // view was left at the top of the page that just arrived (0.6.2).
    if (slow && now && trail.length && Number(trail.at(-1)) - Number(now) > 6) problems.push(`round ${round}: one notch skipped from checkpoint ${trail.at(-1)} to ${now}`);
    trail.push(now);
    const top = await viewport.evaluate(el => el.scrollTop) === 0;
    if (real && top && !await page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true }).count()) break;
    if (!real && oldest === '1' && top) break;
  }
  await check.shot(`scroll-repeat-${label}`);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.deepEqual(problems, [], problems.join('\n'));
  if (!real) assert.equal(oldest, '1');
  console.log('scroll-up trail:', trail.join(','));
  return { ok: true };
}
