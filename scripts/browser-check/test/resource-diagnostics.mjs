import assert from 'node:assert/strict';

import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * Settings → Advanced → Resources (M18-T3, RP-3).
 *
 * The browser gate for the diagnostics surface: a person can explain the
 * application's memory without a terminal, the three roles are visibly
 * separate, every missing counter says why instead of showing a zero, the
 * host only samples while this surface is open, and nothing here can signal a
 * process. Every assertion reads the real host through the built app — the
 * numbers come from `/proc`, the retention bounds from the protocol, and the
 * disconnect is a real transport drop through CDP rather than a stubbed store.
 *
 * States this script proves in the browser: loading, first-sample "no trend
 * yet", partial/unavailable coverage (no renderer process exists outside the
 * packaged desktop, and no owner reports retained bytes until RP-4…RP-7), an
 * injected critical local heap state with its refusal and recovery guidance,
 * disconnected-with-last-sample, disconnected-on-mount, reduced motion, and
 * the redacted export. The refresh-failure state needs a host that answers an
 * error, which no production route offers; it stays covered by
 * `packages/ui/test/settings/resource-diagnostics.test.tsx`, as does the
 * hidden-document poll guard, which headless Chrome cannot enter.
 */

/** Poll cadence of the surface (`RESOURCE_POLL_MS`), in ms. */
const POLL_MS = 5_000;

/** What only the first case of a run can observe, whichever case that is. */
let firstCase = true;

export default async function resourceDiagnostics(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  const label = `${check.state.width}-${check.state.theme}`;
  const first = firstCase;
  firstCase = false;
  await check.touch(phone);

  const watch = await watchPage(check);
  const frames = [];
  const onFrame = event => frames.push(event.response.payloadData);
  check.cdp.on('Network.webSocketFrameSent', onFrame);
  const snapshotCalls = from => frames.slice(from).filter(payload => payload.includes('"resource/snapshot"')).length;

  const activate = activator(check);
  await dismissInstallPrompt(check);

  const root = page.locator('[data-slot=resource-diagnostics]');
  const openResources = async () => {
    if (phone && (await page.getByRole('button', { name: 'Sessions', exact: true }).isVisible())) {
      await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
    }
    await activate(page.getByRole('button', { name: 'Settings', exact: true }).first());
    await activate(page.getByRole('button', { name: 'Advanced', exact: true }));
  };

  // ---------------------------------------------------------------- loading
  // Every mount collects a fresh snapshot from the host, and the designed
  // loading state is what a person sees while it does — for as long as one
  // collection takes, which is too short to poll for. So the page records it:
  // a mutation observer armed before the surface opens cannot miss a frame,
  // and cannot quietly observe nothing either, because the assertion is in
  // every case rather than at the end of a matrix.
  await page.evaluate(label => {
    const seen = () => document.body.textContent.includes(label);
    window.__loadingSeen = seen();
    window.__loadingObserver?.disconnect();
    window.__loadingObserver = new MutationObserver(() => { if (seen()) window.__loadingSeen = true; });
    window.__loadingObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, 'Loading resource diagnostics');
  await openResources();
  await root.waitFor();
  const loadingSeen = await page.evaluate(() => {
    window.__loadingObserver.disconnect();
    return window.__loadingSeen;
  });
  assert.equal(loadingSeen, true, 'the designed loading state was shown while this mount collected its snapshot');

  // ------------------------------------------------- role-separated summary
  const cards = {};
  for (const name of ['Whole application', 'Renderer', 'Host', 'Workers']) {
    const card = root.locator('div').filter({ hasText: new RegExp(`^${name}Current physical`) }).first();
    cards[name] = scrub(await card.innerText());
  }
  const bytes = /\b\d[\d,.]*\s?(B|KB|MB|GB)\b/;
  const valueOf = async name => scrub(await root.getByRole('img', { name: new RegExp(`^${name} current physical memory`) }).getAttribute('aria-label'));
  const hostValue = await valueOf('Host');
  const workersValue = await valueOf('Workers');
  const wholeValue = await valueOf('Whole application');
  for (const [name, value] of [['Host', hostValue], ['Workers', workersValue], ['Whole application', wholeValue]]) {
    assert.match(value, bytes, `${name} reports real physical memory: ${value}`);
  }
  // The rolling digits must not eat the space the formatter put in: a card read
  // "259.9MB" against "356.0 MB" in the row below it.
  const spaces = await root.locator('[data-slot=number-ticker]').first().evaluate(node => [...node.querySelectorAll('span')]
    .filter(span => span.textContent === ' ')
    .map(span => ({ whiteSpace: getComputedStyle(span).whiteSpace, width: span.getBoundingClientRect().width })));
  assert.equal(spaces.length, 1, 'the formatted value keeps its one space');
  assert.ok(spaces[0].width > 0, `the space is drawn, not collapsed: ${JSON.stringify(spaces[0])}`);
  assert.notEqual(hostValue.replace('Host', ''), workersValue.replace('Workers', ''), 'host and worker totals are different numbers, not one repeated total');
  // A browser is not the packaged desktop, so there is no renderer process to
  // measure. The card says exactly that instead of showing a zero.
  assert.match(cards.Renderer, /Unavailable · No process with this role was discovered/, `renderer is honest: ${cards.Renderer}`);
  assert.doesNotMatch(cards.Renderer, /Current physical 0 B/, 'an unmeasured role is never a zero');
  for (const [name, text] of Object.entries(cards)) {
    assert.match(text, /\d+ of \d+ processes measured/, `${name} states its coverage: ${text}`);
  }
  // The explanation keeps a readable measure: on a phone the two actions take
  // their own row rather than squeezing the prose into a two-word column.
  const header = await root.locator('header').evaluate(node => {
    const prose = node.querySelector('p');
    const actions = node.lastElementChild;
    return {
      prose: Math.round(prose.getBoundingClientRect().width),
      lines: Math.round(prose.getBoundingClientRect().height / parseFloat(getComputedStyle(prose).lineHeight)),
      sameRow: Math.abs(prose.getBoundingClientRect().top - actions.getBoundingClientRect().top) < 8,
    };
  });
  assert.ok(header.prose >= 280, `the summary keeps a readable measure (${header.prose}px wide, ${header.lines} lines)`);
  if (phone) assert.equal(header.sameRow, false, 'on a phone the actions sit under the explanation, not beside it');
  await check.shot(`resources-summary-${label}`);

  // ------------------------------------------ actor-local pressure protection
  const pressure = root.locator('[data-section=memory-pressure]');
  await pressure.waitFor();
  await pressure.scrollIntoViewIfNeeded();
  const initialPressure = scrub(await pressure.textContent());
  assert.match(initialPressure, /Application · (Not available|Normal|Memory is tight|Memory is critically low|Not measured yet)/, `the host state has an explicit answer: ${initialPressure.slice(0, 200)}`);
  assert.match(initialPressure, /This window · (Normal|Not measured yet)/, `the renderer has its own state before injection: ${initialPressure.slice(0, 240)}`);
  assert.match(initialPressure, /Nothing missing is treated as zero|JavaScript heap/, 'missing local evidence stays unavailable rather than becoming zero');
  assert.match(initialPressure, /Retained host journal/, 'host journal totals have one bounded subsection rather than being copied into history rows');

  // `performance.memory` is the real renderer sampler boundary. Replace its
  // values, not React state or markup, then use the controller's supported
  // visibility resample path twice: escalation deliberately requires two
  // agreeing samples. This proves the live controller → refusal → diagnostics
  // integration without adding a production test hook.
  const injected = await page.evaluate(() => {
    try {
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        value: { usedJSHeapSize: 900_000_000, totalJSHeapSize: 900_000_000, jsHeapSizeLimit: 1_000_000_000 },
      });
      document.dispatchEvent(new Event('visibilitychange'));
      return performance.memory?.usedJSHeapSize === 900_000_000;
    } catch {
      return false;
    }
  });
  assert.equal(injected, true, 'the browser case injected the renderer sampler, not surface text');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pressure.getByText('This window · Memory is critically low', { exact: true }).waitFor();
  const criticalPressure = scrub(await pressure.textContent());
  assert.match(criticalPressure, /Loading a whole conversation at once/, `the critical window names the paused operation: ${criticalPressure}`);
  assert.match(criticalPressure, /Load earlier messages a page at a time, then try again after memory recovers/, 'the refusal tells the person what to do');
  assert.match(criticalPressure, /Private resident memory|JavaScript heap/, 'the local card names evidence rather than calling it PSS');
  assert.doesNotMatch(criticalPressure, /whole_transcript|admission_refused|desktop_renderer|epoch|generation/, 'the pressure surface exposes no wire enums or internal identities');
  assert.ok(await pressure.locator('[data-section=pressure-actions] table').count() === 1, 'the latest local reason is a semantic table');
  await check.shot(`resources-pressure-critical-${label}`);

  // --------------------------------------------------- history and the chart
  const trend = root.locator('[data-slot=chart]');
  const noTrend = page.getByText('Collecting another complete sample before drawing a trend', { exact: false });
  if (first) {
    // The host's first sample is the one this mount just caused: one point is
    // not a trend, and the surface says so rather than drawing a flat line.
    assert.ok(await noTrend.isVisible(), 'the first sample shows the designed no-trend state');
    await check.shot(`resources-no-trend-${label}`);
    await trend.waitFor({ timeout: POLL_MS * 3 });
  }
  await trend.waitFor();
  const chartLabel = await trend.getByRole('img').getAttribute('aria-label');
  assert.match(chartLabel, /Complete physical samples:/, `the chart names its series: ${chartLabel}`);
  assert.match(chartLabel, bytes, `the chart describes real samples: ${chartLabel}`);
  const retention = scrub(await root.locator('section[aria-labelledby=resource-history-title]').innerText());
  assert.match(retention, /3,600 samples · 20,000 rows · 64\.0 MB/, `the protocol's own bounds: ${retention}`);
  assert.match(retention, /1h 00m/, `the age bound in words: ${retention}`);
  assert.match(retention, /samples only while a diagnostics viewer asks/, `why history looks the way it does: ${retention}`);
  assert.match(retention, /evict independently/, `four independent bounds, said plainly: ${retention}`);

  // ------------------------------------------------- retained state, honestly
  const table = root.locator('[data-section=retained-state]');
  const rows = table.locator('tbody tr');
  assert.ok(await rows.count() >= 10, 'every retained store has a row, reported or not');
  const retained = scrub(await table.innerText());
  assert.match(retained, /Worker session runtimes/, `the stores RP-4…RP-7 will fill are named now: ${retained.slice(0, 200)}`);
  assert.match(retained, /not currently reported by/, 'unreported counters name their owner instead of guessing');
  assert.doesNotMatch(retained, /\bestimated\b|~\d/, 'nothing on this table is an estimate');
  // A missing counter is a sentence; the column it lands in has to hold one.
  const cells = await table.locator('tbody tr').last().evaluate(node => [...node.children]
    .filter(cell => cell.getClientRects().length)
    .map(cell => Math.round(cell.getBoundingClientRect().width)));
  assert.ok(Math.min(...cells) >= 96, `no retained-state column is too narrow to read (${cells.join(', ')}px)`);
  const ownerHeader = table.getByRole('columnheader', { name: 'Owner' });
  assert.equal(await ownerHeader.isVisible(), !phone, 'the owner column is a wide-screen column; the phone puts the owner under the store name');
  if (phone) assert.match(retained, /Host inventory/, 'the phone still says who owns each store');

  // ------------------------------------------------------- collection health
  const health = root.locator('section[aria-labelledby=resource-health-title]');
  const healthText = scrub(await health.innerText());
  assert.match(healthText, /Complete discovery within the bound/, `inventory completeness: ${healthText}`);
  assert.match(healthText, /Linux process details Working|Process details Working/i, `the collector that produced these rows: ${healthText}`);
  assert.match(healthText, /No desktop measurement is available yet/, `the desktop cross-check is absent in a browser, and says so: ${healthText}`);

  // ------------------------------------- disclosure, associations, no signals
  // The deepest row is the project worker: the one that actually hosts work.
  const trigger = root.getByRole('button', { name: /details for/ }).last();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const details = root.getByText('identity', { exact: true }).last();
  await details.waitFor();
  const sheet = details.locator('xpath=ancestor::div[@data-slot="spec-sheet"][1]');
  const detailText = scrub(await sheet.innerText());
  assert.match(detailText, /physical \((PSS|private resident)\)/i, `the row says which counter it used: ${detailText}`);
  assert.match(detailText, /resident \(not additive\)/i, 'resident is present but never additive');
  // Every value is readable where it is: stacked under its label on a phone,
  // compact beside it when the sheet has room, and never cut off behind a
  // `title` a touch screen cannot open.
  const sheetRows = await sheet.evaluate(node => [...node.querySelectorAll('dd')].map(value => {
    const label = value.previousElementSibling ?? value.parentElement?.querySelector('dt');
    const style = getComputedStyle(value);
    return {
      text: value.textContent.slice(0, 40),
      stacked: label.getBoundingClientRect().bottom <= value.getBoundingClientRect().top + 1,
      width: Math.round(value.getBoundingClientRect().width),
      size: Math.round(parseFloat(style.fontSize) * 10) / 10,
      clipped: style.textOverflow === 'ellipsis' && value.scrollWidth > value.clientWidth + 1,
    };
  }));
  for (const detail of sheetRows) {
    assert.equal(detail.clipped, false, `nothing in a process row is cut off: ${detail.text}`);
    assert.ok(detail.size >= 12, `process details stay above the legibility floor (${detail.size}px on "${detail.text}")`);
    assert.equal(detail.stacked, phone, `${phone ? 'a phone stacks' : 'a wide sheet keeps two columns'}: ${detail.text}`);
  }
  if (phone) {
    const narrowest = Math.min(...sheetRows.map(detail => detail.width));
    assert.ok(narrowest >= 200, `a stacked value gets the whole row to read on (${narrowest}px)`);
  }
  await page.keyboard.press('Enter');
  await details.waitFor({ state: 'hidden' });
  await activate(trigger);
  await details.waitFor();

  const associated = root.getByText('Associated work', { exact: false }).last();
  await associated.waitFor();
  const openChat = root.getByRole('button', { name: 'Open chat', exact: true }).last();
  assert.ok(await openChat.isVisible(), 'a worker hosting a session offers the session, not the process');
  const controls = await root.getByRole('button').evaluateAll(nodes => nodes.map(node => (node.textContent ?? '').trim()));
  assert.equal(controls.filter(text => /kill|signal|SIGTERM|PID/i.test(text)).length, 0, `no raw process control: ${controls.join(' | ')}`);
  assert.equal(controls.filter(text => /^End agent|^Stop$/.test(text)).length, 0, 'lifecycle actions are local-only; this view is a browser');
  await check.shot(`resources-process-${label}`);

  // ------------------------------------ the host samples only while asked to
  const pollFrom = frames.length;
  await page.waitForTimeout(POLL_MS * 2 + 1_000);
  const whileOpen = snapshotCalls(pollFrom);
  assert.ok(whileOpen >= 2, `the open surface polls about every ${POLL_MS}ms (saw ${whileOpen} in ${POLL_MS * 2 + 1000}ms)`);
  await page.keyboard.press('Escape');
  await root.waitFor({ state: 'detached' });
  const closedFrom = frames.length;
  await page.waitForTimeout(POLL_MS * 2 + 1_000);
  assert.equal(snapshotCalls(closedFrom), 0, 'a closed surface asks the host for nothing');
  await openResources();
  await root.waitFor();

  // ------------------------------------------------------------ reduced motion
  // Anything still moving, with how long it is told to move for. The product's
  // contract is that reduce collapses every duration, so the evidence is the
  // timing rather than the absence of an animation object.
  const timedMotion = () => page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    moving: document.getAnimations()
      .filter(animation => animation.playState === 'running')
      .map(animation => ({
        what: `${animation.animationName ?? animation.transitionProperty} on ${animation.effect?.target?.tagName}.${String(animation.effect?.target?.getAttribute?.('class') ?? '').slice(0, 60)}`,
        ms: Number(animation.effect?.getComputedTiming?.().duration ?? 0),
      })),
  }));
  // The disclosure's own chevron is the movement on this surface; what it is
  // *told* to take is a computed value, so both directions are read rather
  // than raced for.
  const chevronMs = () => root.getByRole('button', { name: /details for/ }).last().locator('svg').first()
    .evaluate(node => (parseFloat(getComputedStyle(node).transitionDuration) || 0) * 1000);
  const movingMs = await chevronMs();
  assert.ok(movingMs >= 50, `the disclosure is animated to begin with (${movingMs}ms)`);

  await check.reducedMotion(true);
  const refresh = root.getByRole('button', { name: /Refresh/ });
  await activate(refresh);
  await activate(trigger);
  const reducedMs = await chevronMs();
  assert.ok(reducedMs <= 1, `reduce collapses the disclosure's own duration (${reducedMs}ms, was ${movingMs}ms)`);
  const reduced = await timedMotion();
  assert.equal(reduced.reduced, true, 'the case really is in prefers-reduced-motion');
  assert.deepEqual(
    reduced.moving.filter(entry => entry.ms > 1).map(entry => entry.what),
    [],
    `reduce collapses every duration on this surface: ${JSON.stringify(reduced.moving)}`,
  );
  await page.getByText('Last sampled', { exact: false }).first().waitFor();
  await check.shot(`resources-reduced-motion-${label}`);
  await check.reducedMotion(false);
  // …and the movement comes back with the preference, so the assertion above
  // is a fallback and not a surface that never animates.
  assert.ok(await chevronMs() >= 50, 'the fallback is the preference, not a surface with no motion in it');
  await activate(trigger);

  // ------------------------------------------------------- a real disconnect
  await watch.offline(true);
  const strip = page.locator('[data-slot=connection-state]');
  await strip.waitFor();
  assert.equal(await strip.getAttribute('data-phase'), 'dropped', 'the socket really dropped');
  await page.getByText('The host is disconnected. These values are the last sample received.', { exact: false }).waitFor();
  assert.match(await valueOf('Host'), bytes, 'the last good sample stays on screen while disconnected');
  assert.equal(await root.getByText('Could not read resource diagnostics').count(), 0, 'a disconnect is not dressed up as a refresh error');
  await check.shot(`resources-disconnected-${label}`);
  // Mounting the surface with no connection is its own designed state.
  await activate(page.getByRole('tab', { name: 'Configuration', exact: true }));
  await activate(page.getByRole('tab', { name: 'Resources', exact: true }));
  await page.getByText('Resource diagnostics need a host connection', { exact: false }).waitFor();
  await check.shot(`resources-disconnected-mount-${label}`);
  const reconnectFrom = frames.length;
  await watch.offline(false);
  await root.waitFor({ timeout: 30_000 });
  await strip.waitFor({ state: 'detached', timeout: 30_000 });
  assert.ok(snapshotCalls(reconnectFrom) >= 1, 'coming back refreshes once, without waiting for the next poll');
  assert.match(await valueOf('Host'), bytes, 'the surface is live again after the reconnect');
  watch.reconnected();

  // -------------------------------------------------------- redacted export
  await activate(root.getByRole('button', { name: /Download redacted report/ }));
  await page.getByText('Redacted resource report downloaded', { exact: false }).waitFor({ state: 'attached' });
  if (first) {
    const exported = await check.rpc('resource/export', {});
    const document_ = exported.document;
    assert.equal(typeof JSON.parse(document_), 'object', 'the export is the host document, byte for byte');
    for (const secret of [check.fixture.project, check.fixture.path, check.root]) {
      assert.ok(!document_.includes(secret), 'the export carries no filesystem path');
    }
    assert.doesNotMatch(document_, /cmdline|argv|environ/, 'the export carries no command line or environment');
  }

  // ------------------------------------------------- legibility and overflow
  const layout = await root.evaluate(node => {
    const sizes = [];
    const eyebrows = [];
    const clipped = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const element = text.parentElement;
      if (!element || !element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      const size = Math.round(parseFloat(style.fontSize) * 10) / 10;
      (element.closest('.eyebrow') ? eyebrows : sizes).push(size);
      // Text cut off with no ellipsis and no scroller of its own is clipped.
      const scroller = element.closest('[data-slot=data-table], [data-slot=scroll-area]');
      if (style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis' && element.scrollWidth > element.clientWidth + 1 && !scroller) {
        clipped.push(`${element.className}: ${element.textContent.slice(0, 40)}`);
      }
    }
    return {
      minFontSize: Math.min(...sizes),
      maxEyebrow: eyebrows.length ? Math.max(...eyebrows) : 0,
      clipped,
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  assert.ok(layout.minFontSize >= 12, `no data below 12px (smallest ${layout.minFontSize}px)`);
  assert.ok(layout.maxEyebrow <= 11, `category labels stay on the eyebrow size (${layout.maxEyebrow}px)`);
  assert.deepEqual(layout.clipped, [], 'nothing is clipped without an ellipsis or a scroller');
  assert.equal(layout.pageOverflowsX, false, 'the page never scrolls sideways');

  if (phone) {
    const small = await root.evaluate(node => [...node.querySelectorAll('button, a[href]')]
      .filter(element => element.getClientRects().length)
      .map(element => ({ text: (element.textContent ?? '').trim().slice(0, 32), height: Math.round(element.getBoundingClientRect().height) }))
      .filter(entry => entry.height < 44));
    assert.deepEqual(small, [], 'every control on a touch screen clears the 44px floor');
  }

  // ------------------------------------------- the association really routes
  await activate(trigger);
  await activate(root.getByRole('button', { name: 'Open chat', exact: true }).last());
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  assert.equal(await root.count(), 0, 'opening the chat leaves Settings behind');

  watch.assertClean();
  check.cdp.off('Network.webSocketFrameSent', onFrame);
  console.log(`resources ${label}: whole ${wholeValue} · host ${hostValue} · workers ${workersValue} · polls while open ${whileOpen} · chevron ${movingMs}ms/${reducedMs}ms`);
}
