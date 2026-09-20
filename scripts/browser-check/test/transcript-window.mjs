import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async function sustainedNavigation(check) {
  const page = check.page;
  await check.touch(check.state.touch || check.state.width === 390);
  // Theme and motion travel together in the matrix; this switch separates them
  // so a phone case can be measured with motion off without changing theme.
  await check.reducedMotion(process.env.TRANSCRIPT_REDUCED_MOTION === '1' || check.state.theme === 'light');
  const install = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(install, async () => { await install.getByRole('button', { name: 'Not now', exact: true }).click(); });
  const { entries } = await check.rpc('pi/session/entries', { path: check.fixture.path });
  const canonical = entries.filter(entry => entry.type === 'message').length;
  const turns = canonical / 2;
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await check.waitFor(`Checkpoint ${turns} is complete.`);
  assert.equal(await composer.isEnabled(), true);
  // Landing prefetch fills the screen; Find for an older checkpoint may still
  // need a whole-conversation read, but the estimated range must already be off screen.
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-slot=thread-viewport]');
    const reserve = document.querySelector('[data-slot="history-reserve"]');
    if (!viewport) return false;
    if (!reserve) return true;
    const view = viewport.getBoundingClientRect();
    const rect = reserve.getBoundingClientRect();
    return rect.bottom < view.top + 0.5;
  }, { timeout: 30000 });
  const target = page.locator('[data-window-message] [data-message-id]').filter({ hasText: 'Checkpoint 12 is complete.' });
  await composer.click(); await composer.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.waitFor();
  await find.fill('Checkpoint 12 is complete.');
  assert.equal(await find.inputValue(), 'Checkpoint 12 is complete.');
  // Checkpoint 12 is above the landing window. Find's "Load all messages"
  // pages the branch on screen to its root (D-341); the control goes away
  // when the branch is complete, and it must — a button that stays up after
  // being pressed is a defect this script fails on, not one it waits out.
  const all = page.getByRole('button', { name: 'Load all messages', exact: true });
  if (await all.count()) { await all.click(); await all.waitFor({ state: 'detached', timeout: 60000 }); }
  await target.waitFor({ state: 'visible', timeout: 20000 });
  // Find lands the match inside the thread: its top within the scroller and
  // above the composer, which floats over the list beside the scroller.
  await page.waitForFunction(() => {
    const main = document.querySelector('main');
    const viewport = main?.querySelector('[data-slot="thread-viewport"]');
    const match = [...(viewport?.querySelectorAll('[data-message-id]') ?? [])].find(n => n.textContent.includes('Checkpoint 12 is complete.'));
    if (!viewport || !match) return false;
    const rect = match.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    const footer = main.querySelector('[data-slot="thread-footer"]')?.getBoundingClientRect();
    return rect.top >= view.top && rect.top < (footer?.top ?? view.bottom);
  });
  await find.press('Escape');
  await navigationPairs(check, entries, turns);
  const mounted = await page.locator('[data-window-message]').count();
  assert(mounted < 80, `mounted ${mounted} of ${canonical}`);
  const rhythm = await page.evaluate(() => {
    const row = document.querySelector('[data-window-message]');
    // The rhythm above the first row is the list header's (docs/transcript-reading.md).
    const messages = document.querySelector('[data-slot="thread-messages"]') ?? document.querySelector('[data-slot="transcript-head"]');
    return [getComputedStyle(row).paddingBottom, getComputedStyle(messages).paddingTop, getComputedStyle(row.querySelector('[data-message-id]')).contentVisibility];
  });
  assert.equal(rhythm[0], rhythm[1], 'mounted rows retain the token message rhythm');
  assert.equal(rhythm[2], 'visible', 'measure real mounted content, not skipped intrinsic sizes');
  const ticks = await page.locator('[data-slot="conversation-map-tick"]').count();
  assert(ticks <= 225, `pixel-budget map has ${ticks} ticks`);
  const latest = page.getByRole('button', { name: 'Jump to latest', exact: true });
  if (await latest.isVisible()) await latest.click();
  await check.waitFor(`Checkpoint ${turns} is complete.`);
  assert.equal(await composer.isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await writeFile(join(check.root, `window-${check.state.width}-${check.state.theme}.json`), JSON.stringify({ canonical, mounted, ticks, metrics: await check.metrics() }, null, 2));
  await check.shot('sustained-navigation');
}

const seeded = new Map();
export async function prompt(check, path, number) {
  const { accepted } = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: `Review checkpoint ${number}: verify the implementation and explain the next step.` }] });
  assert(accepted);
  const until = Date.now() + 120000;
  while ((await check.rpc('session/load', { path })).state.isStreaming) {
    assert(Date.now() < until, 'synthetic prompt settlement');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function companions(check, entries, turns) {
  if (seeded.has(check.root)) return seeded.get(check.root);
  const short = (await check.rpc('session/new', { cwd: check.fixture.project })).state.path;
  await check.rpc('pi/model/set', { path: short, model: { provider: 'stub', id: 'stub-1' } });
  await prompt(check, short, 900001); await prompt(check, short, 900002);
  await check.rpc('pi/session/rename', { path: short, name: 'C short' });
  const last = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'user');
  const mirror = (await check.rpc('pi/session/fork', { path: check.fixture.path, entryId: last.id })).state.path;
  await prompt(check, mirror, turns);
  await check.rpc('pi/session/rename', { path: mirror, name: 'C mirror' });
  const mirrored = await check.rpc('pi/session/entries', { path: mirror });
  assert.equal(mirrored.entries.filter(e => e.type === 'message').length, turns * 2);
  const value = { short, mirror }; seeded.set(check.root, value); return value;
}
export async function row(check, title) {
  const page = check.page;
  const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await sessions.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const button = page.getByRole('button', { name: new RegExp(`^(?:Finished, unread )?${escaped}$`) });
  await button.waitFor(); return button;
}
async function open(check, title, text, record = false) {
  const button = await row(check, title);
  await check.page.evaluate(({ title, text }) => {
    window.__cArrival = null; window.__cVisible = null; window.__cStart = null;
    const tick = () => {
      if (window.__cStart !== null) {
        const main = document.querySelector('main');
        const viewport = main?.querySelector('[data-slot="thread-viewport"]');
        // The composer and its footer float over the list, beside the scroller
        // rather than inside it (docs/transcript-reading.md).
        const footer = main?.querySelector('[data-slot="thread-footer"]');
        const message = [...(viewport?.querySelectorAll('[data-message-id]') ?? [])].find(n => n.textContent.includes(text));
        const rect = message?.getBoundingClientRect();
        const limit = footer?.getBoundingClientRect().top ?? viewport?.getBoundingClientRect().bottom;
        const correct = main?.querySelector('h1')?.textContent === title && rect && rect.bottom > viewport.getBoundingClientRect().top && rect.top < limit;
        if (correct) {
          window.__cVisible ??= performance.now() - window.__cStart;
          const input = main.querySelector('textarea[aria-label="Message"]');
          const inputRect = input?.getBoundingClientRect();
          const hit = inputRect && document.elementFromPoint(inputRect.x + inputRect.width / 2, inputRect.y + inputRect.height / 2);
          if (input && !input.disabled && inputRect.height && hit && input.contains(hit)) {
            window.__cArrival = { resident: window.__cVisible, interactive: performance.now() - window.__cStart, mounted: viewport.querySelectorAll('[data-window-message]').length };
            return;
          }
        }
      }
      window.__cFrame = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(window.__cFrame); window.__cFrame = requestAnimationFrame(tick);
  }, { title, text });
  await button.evaluate(node => node.addEventListener('pointerdown', () => { window.__cStart = performance.now(); }, { once: true }));
  if (check.state.touch) await button.tap(); else await button.click();
  await check.page.waitForFunction(() => window.__cArrival !== null);
  const result = await check.page.evaluate(() => window.__cArrival);
  if (record) {
    const composer = check.page.getByRole('textbox', { name: 'Message', exact: true });
    const draft = await composer.inputValue();
    await check.page.evaluate(() => {
      window.__cTyped = null;
      const input = document.querySelector('main textarea[aria-label="Message"]');
      input.addEventListener('input', () => requestAnimationFrame(() => {
        window.__cTyped = { elapsed: performance.now() - window.__cStart, value: input.value };
      }), { once: true });
    });
    // Actual supported input, not dispatchEvent or a synthetic React update.
    // Total includes automation/readiness round trips; it is conservative,
    // separate from the resident and enabled/hit-testable-input endpoints.
    await composer.fill(`${draft}x`);
    await check.page.waitForFunction(() => window.__cTyped !== null);
    const typed = await check.page.evaluate(() => window.__cTyped);
    assert.equal(typed.value, `${draft}x`);
    result.actualInput = typed.elapsed;
    await composer.fill(draft);
  }
  if (check.state.width < 1024) await check.page.getByRole('region', { name: 'Sessions', exact: true }).waitFor({ state: 'hidden' });
  return record ? { destination: title, ...result } : undefined;
}
async function loadAll(check) {
  const composer = check.page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.click(); await composer.press('ControlOrMeta+f');
  const input = check.page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  const all = check.page.getByRole('button', { name: 'Load all messages', exact: true });
  // Pages the branch to its root (D-341); the control must go away when it has.
  if (await all.count()) { await all.click(); await all.waitFor({ state: 'detached', timeout: 60000 }); }
  await input.press('Escape');
}
function stats(samples, field) {
  const sorted = samples.map(s => s[field]).sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], n: sorted.length };
}
async function navigationPairs(check, entries, turns) {
  const page = check.page, title = `${check.fixture.name} conversation 1`;
  await companions(check, entries, turns);
  // D-236: an ordinary return opens at the recent tail, so what is measured is
  // a tail load after a history of this size — not a restored deep position.
  await open(check, 'C short', 'Checkpoint 900002 is complete.');
  await open(check, title, `Checkpoint ${turns} is complete.`);
  const latest = await page.evaluate(() => {
    const view = document.querySelector('[data-slot="thread-viewport"]');
    return view.scrollHeight - view.clientHeight - view.scrollTop;
  });
  assert(latest <= 4, `the return opens at the end of the conversation (${latest}px short of it)`);
  await open(check, 'C mirror', `Checkpoint ${turns} is complete.`);
  await loadAll(check);
  await open(check, title, `Checkpoint ${turns} is complete.`);
  const shortLong = [], longLong = [];
  // A phone case takes three pairs in the ordinary matrix; a controlled
  // measurement of one case asks for the same twenty the desktop takes.
  const requested = Number(process.env.TRANSCRIPT_PAIRS);
  const pairs = Number.isFinite(requested) && requested > 0 ? requested : check.state.width === 1360 ? 20 : 3;
  for (let i = 0; i < pairs; i++) {
    shortLong.push(await open(check, 'C short', 'Checkpoint 900002 is complete.', true));
    shortLong.push(await open(check, title, `Checkpoint ${turns} is complete.`, true));
    longLong.push(await open(check, 'C mirror', `Checkpoint ${turns} is complete.`, true));
    longLong.push(await open(check, title, `Checkpoint ${turns} is complete.`, true));
  }
  const result = { canonical: turns * 2, pairs, latest, shortLong: { resident: stats(shortLong, 'resident'), interactive: stats(shortLong, 'interactive'), actualInput: stats(shortLong, 'actualInput'), samples: shortLong }, longLong: { resident: stats(longLong, 'resident'), interactive: stats(longLong, 'interactive'), actualInput: stats(longLong, 'actualInput'), samples: longLong } };
  await writeFile(join(check.root, `switches-${check.state.width}-${check.state.theme}.json`), JSON.stringify(result, null, 2));
  // Typing readiness must not wait for the sheet's exit animation: the
  // conversation is drawn (resident) and the composer takes a tap at once,
  // while the sheet keeps fading. A closing overlay that still hit-tests put
  // ~200 ms between the two on a phone (M16-T36, P3). The margin is generous
  // so ordinary machine noise never fails a run that is not the defect.
  for (const lane of [result.shortLong, result.longLong]) {
    const gap = lane.interactive.median - lane.resident.median;
    assert(gap <= 150, `the composer became typable ${Math.round(gap)}ms after the conversation was drawn; readiness is waiting on an animation`);
  }
  if (process.env.TRANSCRIPT_SWITCH_PROFILE === '1' && turns >= 1000 && check.state.width === 1360 && check.state.theme === 'light' && (result.longLong.resident.median > 250 || result.longLong.resident.p95 > 400)) {
    // Explicit one-off attribution, after all samples; ordinary reruns never
    // silently collect another profile of an already attributed budget miss.
    const cdp = await check.context.newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await open(check, 'C mirror', `Checkpoint ${turns} is complete.`);
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(join(check.root, 'resident-switch.cpuprofile'), JSON.stringify(profile));
    await cdp.detach();
    await open(check, title, `Checkpoint ${turns} is complete.`);
  }
}
