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
  const phone = width === 390;
  const touch = check.state.touch;
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
  if (phone) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
  await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  if (real) await page.waitForTimeout(1500); else await page.getByText('Checkpoint 1000 is complete.', { exact: true }).waitFor();
  const viewport = page.locator('[data-slot=thread-viewport]');
  const initialGeometry = await viewport.evaluate(el => {
    const reserveHeight = document.querySelector('[data-slot="history-reserve"]')?.getBoundingClientRect().height ?? 0;
    const contentHeight = document.querySelector('[data-slot="thread-messages"]')?.scrollHeight ?? 0;
    return {
      height: el.scrollHeight,
      loadedHeight: Math.max(0, contentHeight - reserveHeight),
      reserveHeight,
      gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    };
  });
  assert.ok(initialGeometry.gap <= 2, `recent tail opened ${initialGeometry.gap}px from the bottom`);
  // A page arriving is nothing the person watches: the unloaded range is
  // placeholder rows with no words, and a page replaces those pixels in place.
  // Observe the semantic signals in the page for the whole journey: the
  // transcript region is busy while a page is in flight, one sr-only status
  // says so, no visible copy does, and the overdue mark may appear only after
  // one slow motion step of a page that is still in flight.
  let placeholderShot;
  const capturePlaceholder = `__capturePlaceholder${width}${check.state.theme[0]}${touch ? 't' : 'p'}`;
  await page.exposeFunction(capturePlaceholder, () => {
    placeholderShot ??= check.shot(`scroll-placeholder-${label}`);
    return placeholderShot;
  });
  await page.evaluate(capture => {
    const motionSlow = (() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-slow').trim();
      const value = Number.parseFloat(raw);
      return raw.endsWith('ms') ? value : value * 1000;
    })();
    window.__earlierHistory = { pages: 0, busy: false, busySince: undefined, statusSeen: false, visibleCopy: [], indicator: [], motionSlow };
    const observe = () => {
      const state = window.__earlierHistory;
      const region = document.querySelector('[data-slot="thread-messages"]');
      const busy = region?.getAttribute('aria-busy') === 'true';
      if (busy && !state.busy) { state.pages += 1; state.busySince = performance.now(); }
      if (!busy) state.busySince = undefined;
      state.busy = busy;
      for (const status of document.querySelectorAll('main [role="status"]')) {
        if (status.textContent?.trim() === 'Loading earlier messages') {
          state.statusSeen = true;
          if (!status.classList.contains('sr-only')) state.visibleCopy.push('status not sr-only');
        }
      }
      const reserve = document.querySelector('[data-slot="history-reserve"]');
      if (reserve && reserve.textContent.trim()) state.visibleCopy.push(`reserve text: ${reserve.textContent.trim().slice(0, 40)}`);
      if (document.querySelector('[data-slot="history-reserve-loading"]')) state.visibleCopy.push('loading card');
      const indicator = document.querySelector('[data-slot="history-reserve-indicator"]');
      if (indicator && !state.indicatorActive) {
        state.indicator.push({ afterBusyMs: state.busySince === undefined ? null : Math.round(performance.now() - state.busySince), text: indicator.textContent.trim() });
      }
      state.indicatorActive = Boolean(indicator);
      const viewport = region?.closest('[data-slot="thread-viewport"]');
      const reserveRect = reserve?.getBoundingClientRect();
      const viewportRect = viewport?.getBoundingClientRect();
      if (!state.captured && reserveRect && viewportRect && reserveRect.bottom > viewportRect.top + 40 && reserveRect.top < viewportRect.bottom) {
        state.captured = true;
        void window[capture]();
      }
    };
    observe();
    new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }, capturePlaceholder);
  const box = await viewport.boundingBox();
  assert.ok(box, 'the transcript viewport is on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const input = process.env.SCROLL_INPUT ?? (touch ? 'touch' : 'wheel');
  const upward = async (amount) => {
    if (input === 'keyboard') {
      await viewport.focus();
      await page.keyboard.press(amount < 600 ? 'ArrowUp' : 'PageUp');
    } else if (input === 'touch') {
      const current = await viewport.boundingBox();
      assert.ok(current, 'the transcript viewport has touch geometry');
      const x = current.x + current.width / 2;
      const start = current.y + current.height * 0.3;
      const distance = Math.min(amount, current.height * 0.55);
      await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 1 }] });
      for (let step = 1; step <= 6; step += 1) {
        await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + distance * step / 6, id: 1 }] });
        await page.waitForTimeout(12);
      }
      await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.wheel(0, -amount);
  };
  // Every mounted message, in DOM order: its id, and for the synthetic fixture its checkpoint number.
  const rows = async () => page.locator('[data-window-message]').evaluateAll((els, inspectCheckpoints) => els.map(el => ({
    id: el.getAttribute('data-window-message'),
    n: inspectCheckpoints ? /Review checkpoint (\d+):/.exec(el.innerText)?.[1] : undefined,
  })), !real);
  const problems = [];
  let oldest;
  // The checkpoint the person is actually looking at: the first user row whose bottom is below the viewport's top.
  const visible = async () => real ? undefined : viewport.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll('[data-role=user]')) {
      if (row.getBoundingClientRect().bottom > top) return /Review checkpoint (\d+):/.exec(row.innerText)?.[1];
    }
    return undefined;
  });
  // What the reader is actually looking at: the first mounted row whose bottom
  // is below the viewport's top, and where that row sits on screen. Geometry
  // read from the DOM, so it measures the same pixels the person sees rather
  // than the controller's own account of them.
  const geometry = () => viewport.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll('[data-window-message]')];
    const anchor = rows.find(row => row.getBoundingClientRect().bottom > top);
    return {
      top: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
      reserve: document.querySelector('[data-slot="history-reserve"]')?.getBoundingClientRect().height ?? 0,
      loading: Boolean(document.querySelector('[data-slot="history-reserve-loading"]')),
      anchorId: anchor?.getAttribute('data-window-message'),
      anchorScreen: anchor ? anchor.getBoundingClientRect().top - top : undefined,
    };
  });
  const trail = [];
  const arrivals = [];
  const anchorDeltas = [];
  let priorRange = initialGeometry.height;
  // Paced like a person reading: a wheel notch, then a pause long enough for
  // the page to arrive and the viewport's reading window to close (SLOW=1),
  // or the trackpad bursts the blank-window check uses.
  const slow = process.env.SLOW === '1';
  for (let round = 0; round < (slow || real ? 400 : 120) && !pageErrors.length; round++) {
    if (slow || real) {
      const before = await geometry();
      await upward(500);
      // The wheel is applied asynchronously; give it a frame so the samples
      // below contain only what the app did, never the person's own movement.
      await page.waitForTimeout(40);
      const samples = [await geometry()];
      for (const wait of [60, 150, 250, 200]) { await page.waitForTimeout(wait); samples.push(await geometry()); }
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        // Rows below the reader are re-measured as they mount, so the range
        // breathes by a line or two. What may not happen is the range losing a
        // page of history while somebody reads into it.
        assert.ok(sample.height + sample.client >= priorRange,
          `scroll range collapsed ${Math.round(priorRange)}→${Math.round(sample.height)} during upward reading`);
        const previous = index > 0 ? samples[index - 1] : undefined;
        if (previous) {
          // Nothing but the person moves the reader between settle samples: the
          // row they are on holds its place on screen through an arriving page,
          // its measurement, and the removal of the estimated range at the root
          // (M16-T83 invariants 1–4).
          if (sample.anchorId && sample.anchorId === previous.anchorId) {
            const moved = sample.anchorScreen - previous.anchorScreen;
            // A late notch of the person's own wheel moves the row on screen by
            // exactly the scroll and changes nothing else; that is them, not us.
            const ownMovement = Math.abs(sample.top - previous.top) > 1
              && Math.abs(sample.height - previous.height) <= 0.5
              && Math.abs(sample.reserve - previous.reserve) <= 0.5
              && Math.abs(moved + (sample.top - previous.top)) <= 1;
            if (!ownMovement) anchorDeltas.push(Math.round(moved));
            assert.ok(ownMovement || Math.abs(moved) <= 1,
              `the reading anchor moved ${Math.round(moved)}px on its own (${Math.round(previous.top)}/${Math.round(previous.height)}→${Math.round(sample.top)}/${Math.round(sample.height)}, row ${sample.anchorId})`);
          }
          // Reading upwards never ends at the newest turn.
          assert.ok(sample.top < sample.height - sample.client - 2 || previous.top >= previous.height - previous.client - 2,
            `upward reading was thrown back to the live edge (${Math.round(previous.top)}/${Math.round(previous.height)}→${Math.round(sample.top)}/${Math.round(sample.height)})`);
          // The top of the range means the beginning of the conversation.
          if (sample.top === 0 && previous.top > 1) {
            assert.ok(sample.reserve === 0 && !sample.loading,
              `upward reading was written to the top while ${Math.round(sample.reserve)}px of earlier history was still claimed`);
          }
          // A page arrives either as new range or as estimate it took the place
          // of; both are arrivals the assertions above had to hold across.
          if (sample.height > previous.height + 0.5 || previous.reserve - sample.reserve > 0.5) {
            arrivals.push({ rangeDelta: Math.round(sample.height - previous.height), reserveDelta: Math.round(previous.reserve - sample.reserve), topDelta: Math.round(sample.top - previous.top) });
          }
        }
        priorRange = sample.height;
      }
      if (process.env.TRACE) console.log(`wheel ${round}: before ${Math.round(before.top)}/${Math.round(before.height)} → ${samples.map(sample => `${Math.round(sample.top)}/${Math.round(sample.height)} res=${Math.round(sample.reserve)}`).join(' → ')} · top row ${await visible()}`);
    }
    else { for (let step = 0; step < 12; step++) { await upward(900); await page.waitForTimeout(30); } await page.waitForTimeout(250); }
    const mounted = await rows();
    const ids = mounted.map(r => r.id);
    const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
    if (dupIds.length) problems.push(`round ${round}: message ids mounted twice: ${[...new Set(dupIds)].join(',')}`);
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
    if (placeholderShot) await placeholderShot;
    const top = await viewport.evaluate(el => el.scrollTop) === 0;
    if (real && top && !await page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true }).count()) break;
    if (!real && oldest === '1' && top) break;
  }
  const finalGeometry = await viewport.evaluate(el => ({
    height: el.scrollHeight,
    top: el.scrollTop,
    statusSeen: window.__earlierHistory.statusSeen,
    statusSignals: window.__earlierHistory.pages,
    visibleCopy: [...new Set(window.__earlierHistory.visibleCopy)],
    indicator: window.__earlierHistory.indicator,
    motionSlow: window.__earlierHistory.motionSlow,
    reserve: document.querySelectorAll('[data-slot="history-reserve"]').length,
  }));
  const earlierRemaining = await page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true }).count();
  await check.shot(`scroll-repeat-${label}`);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.deepEqual(problems, [], problems.join('\n'));
  if (real) {
    assert.ok(initialGeometry.reserveHeight > 0, 'the real conversation did not expose unloaded-history range');
    assert.ok(initialGeometry.height > initialGeometry.loadedHeight, 'the real thumb described only loaded rows');
    assert.equal(finalGeometry.top, 0, 'the real conversation did not reach its beginning');
    assert.equal(earlierRemaining, 0, 'the real conversation still has an earlier page to load');
    assert.equal(finalGeometry.reserve, 0, 'the real conversation claimed unloaded range at its root');
    assert.equal(finalGeometry.statusSeen, true, 'the real conversation never exposed an earlier-page busy status');
    assert.ok(arrivals.length > 0, 'the real conversation observed no earlier-page arrival to verify');
    assert.ok(initialGeometry.height > finalGeometry.height * 0.2, `real initial range ${initialGeometry.height}px understated loaded history ${finalGeometry.height}px beyond the documented bound`);
    assert.ok(initialGeometry.height < finalGeometry.height * 8, `real initial range ${initialGeometry.height}px overstated loaded history ${finalGeometry.height}px beyond the documented bound`);
  }
  if (!real && !slow) {
    assert.equal(oldest, '1');
    assert.equal(finalGeometry.top, 0, 'the scrollbar reaches the real beginning');
    assert.equal(finalGeometry.reserve, 0, 'no unloaded range remains at the real beginning');
    assert.equal(finalGeometry.statusSeen, true, 'earlier-page loading exposed an accessible busy status');
    assert.ok(initialGeometry.height > finalGeometry.height * 0.75, `initial thumb range ${initialGeometry.height}px did not represent ${finalGeometry.height}px of history`);
    assert.ok(initialGeometry.height < finalGeometry.height * 1.35, `initial thumb range ${initialGeometry.height}px overstated ${finalGeometry.height}px of history`);
  }
  assert.ok(placeholderShot, 'the unloaded-history placeholder was never on screen');
  await placeholderShot;
  assert.deepEqual(finalGeometry.visibleCopy, [], `arriving history showed visible copy: ${finalGeometry.visibleCopy.join('; ')}`);
  for (const mark of finalGeometry.indicator) {
    assert.equal(mark.text, '', 'the overdue mark carries no copy');
    assert.ok(mark.afterBusyMs !== null && mark.afterBusyMs >= finalGeometry.motionSlow - 20,
      `the overdue mark appeared ${mark.afterBusyMs}ms into a page, before the ${finalGeometry.motionSlow}ms threshold`);
  }
  if (slow && !real) assert.ok(trail.length > 100 && Number(trail.at(-1)) < 500, `paced reading covered ${trail.length} notches down to checkpoint ${trail.at(-1)}`);
  const worstAnchor = anchorDeltas.reduce((worst, delta) => Math.max(worst, Math.abs(delta)), 0);
  console.log('scroll-up evidence:', JSON.stringify({ rounds: trail.length, first: trail[0], last: trail.at(-1), arrivals: arrivals.length,
    anchorSamples: anchorDeltas.length, worstAnchorDelta: worstAnchor, statusSignals: finalGeometry.statusSignals, overdueMarks: finalGeometry.indicator.length, motionSlow: finalGeometry.motionSlow, input, real: Boolean(real) }));
  return { ok: true };
}
