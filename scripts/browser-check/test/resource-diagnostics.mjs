import assert from 'node:assert/strict';

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
 * packaged desktop, and no owner reports retained bytes until RP-4…RP-7),
 * disconnected-with-last-sample, disconnected-on-mount, reduced motion, and
 * the redacted export. The refresh-failure state needs a host that answers an
 * error, which no production route offers; it stays covered by
 * `packages/ui/test/settings/resource-diagnostics.test.tsx`, as does the
 * hidden-document poll guard, which headless Chrome cannot enter.
 */

/** Poll cadence of the surface (`RESOURCE_POLL_MS`), in ms. */
const POLL_MS = 5_000;

let listening = false;
let caseNumber = 0;
let loadingSeen = 0;
let exportChecked = false;
/** True while this script has the network switched off on purpose. */
let unplugged = false;
const console_ = [];
/** The browser's own message for a socket that cannot reach a host we unplugged. */
const DISCONNECT_NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|WebSocket connection to/;

const scrub = text => text.replace(/\s+/g, ' ').trim();

export default async function resourceDiagnostics(check) {
  const { page } = check;
  caseNumber += 1;
  const phone = check.state.width <= 600;
  const label = `${check.state.width}-${check.state.theme}`;
  await check.touch(phone);

  if (!listening) {
    listening = true;
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = scrub(message.text());
      if (unplugged && DISCONNECT_NOISE.test(text)) return;
      console_.push(text);
    });
    page.on('pageerror', error => console_.push(`pageerror: ${error.message}`));
    await check.cdp.send('Network.enable');
  }
  const frames = [];
  const onFrame = event => frames.push(event.response.payloadData);
  check.cdp.on('Network.webSocketFrameSent', onFrame);
  const snapshotCalls = from => frames.slice(from).filter(payload => payload.includes('"resource/snapshot"')).length;

  const activate = async locator => {
    await locator.scrollIntoViewIfNeeded();
    if (check.state.touch) await locator.tap(); else await locator.click();
  };
  const installPrompt = page.getByRole('button', { name: 'Not now', exact: true });
  await page.addLocatorHandler(installPrompt, button => button.click());

  const root = page.locator('[data-slot=resource-diagnostics]');
  const openResources = async () => {
    if (phone && (await page.getByRole('button', { name: 'Sessions', exact: true }).isVisible())) {
      await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
    }
    await activate(page.getByRole('button', { name: 'Settings', exact: true }).first());
    await activate(page.getByRole('button', { name: 'Advanced', exact: true }));
  };

  // ---------------------------------------------------------------- loading
  await openResources();
  // The first mount collects a fresh snapshot from the host; the designed
  // loading state is what a person sees while it does.
  const loader = page.getByText('Loading resource diagnostics', { exact: false });
  if (await loader.isVisible().catch(() => false)) loadingSeen += 1;
  await root.waitFor();

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

  // --------------------------------------------------- history and the chart
  const trend = root.locator('[data-slot=chart]');
  const noTrend = page.getByText('Collecting another complete sample before drawing a trend', { exact: false });
  if (caseNumber === 1) {
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
  const table = root.locator('[data-slot=data-table]');
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
  const detailText = scrub(await details.locator('xpath=ancestor::div[@data-slot="spec-sheet"][1]').innerText());
  assert.match(detailText, /physical \((PSS|private resident)\)/i, `the row says which counter it used: ${detailText}`);
  assert.match(detailText, /resident \(not additive\)/i, 'resident is present but never additive');
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
  await check.reducedMotion(true);
  const refresh = root.getByRole('button', { name: /Refresh/ });
  await activate(refresh);
  await activate(trigger);
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
  // …and with motion back on, the same disclosure really does move, so the
  // assertion above is a fallback and not a surface that never animates.
  await activate(trigger);
  let animated = [];
  for (let attempt = 0; attempt < 20 && animated.length === 0; attempt += 1) {
    animated = (await timedMotion()).moving.filter(entry => entry.ms > 1);
    if (animated.length === 0) await page.waitForTimeout(50);
  }
  assert.ok(animated.length > 0, 'without the reduce preference the disclosure animates');
  await activate(trigger);

  // ------------------------------------------------------- a real disconnect
  const offline = async on => check.cdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  unplugged = true;
  await offline(true);
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
  await offline(false);
  await root.waitFor({ timeout: 30_000 });
  await strip.waitFor({ state: 'detached', timeout: 30_000 });
  assert.ok(snapshotCalls(reconnectFrom) >= 1, 'coming back refreshes once, without waiting for the next poll');
  assert.match(await valueOf('Host'), bytes, 'the surface is live again after the reconnect');
  unplugged = false;

  // -------------------------------------------------------- redacted export
  await activate(root.getByRole('button', { name: /Download redacted report/ }));
  await page.getByText('Redacted resource report downloaded', { exact: false }).waitFor({ state: 'attached' });
  if (!exportChecked) {
    exportChecked = true;
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

  assert.deepEqual(console_, [], `no console errors: ${console_.join(' | ')}`);
  check.cdp.off('Network.webSocketFrameSent', onFrame);
  if (caseNumber === 4) assert.ok(loadingSeen >= 1, 'the designed loading state was seen at least once');
  console.log(`resources ${label}: whole ${wholeValue} · host ${hostValue} · workers ${workersValue} · polls while open ${whileOpen} · loading seen ${loadingSeen}`);
}
