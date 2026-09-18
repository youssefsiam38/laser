import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const action = number => `History action ${String(number).padStart(3, '0')}`;
const messageText = entry => typeof entry?.message?.content === 'string'
  ? entry.message.content
  : (entry?.message?.content ?? []).map(part => part?.text ?? '').join('\n');

async function settled(check, path) {
  const deadline = Date.now() + 120_000;
  while (((await check.rpc('session/load', { path })).state.isStreaming) || (await check.rpc('session/load', { path })).state.isCompacting) {
    assert(Date.now() < deadline, 'the live history turn settles');
    await sleep(25);
  }
}

const bytesOf = value => {
  const match = /([\d.]+)\s*(B|KB|MB|GB)/i.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[match[2].toLowerCase()];
};

export default async function liveHistoryRetention(check) {
  const { page, fixture } = check;
  assert.equal(fixture.name, 'history', 'use the dedicated history fixture');
  const touch = check.state.touch === true;
  const mobile = check.state.width === 390;
  await check.touch(touch);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  // Each matrix lane creates one real user turn with ninety real bash calls and
  // results. It does not replay a many-prompt synthetic transcript.
  const created = await check.rpc('session/new', { cwd: fixture.project });
  const path = created.state.path;
  await check.rpc('pi/model/set', { path, model: { provider: 'stub', id: 'stub-1' } });
  const started = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: 'Run one tool-heavy history turn' }] });
  assert.equal(started.accepted, true, 'the tool-heavy turn is accepted');
  await settled(check, path);
  const seeded = await check.rpc('pi/session/entries', { path });
  const users = seeded.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
  const tools = seeded.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult');
  assert.equal(users.length, 1, 'the history has one user message');
  assert.equal(messageText(users[0]), 'Run one tool-heavy history turn');
  assert.equal(tools.length, 90, 'the history has ninety real tool results');
  for (const index of [0, 44, 89]) assert(messageText(tools[index]).includes(`${action(index + 1)} output line 120`), `tool result ${index + 1} retains its output`);

  const title = `Live history ${check.state.width} ${check.state.theme}`;
  await check.rpc('pi/session/rename', { path, name: title });
  const canonical = await check.rpc('pi/session/entries', { path });
  const canonicalIds = canonical.entries.map(entry => entry.id).filter(Boolean);
  const initialWindow = await check.rpc('pi/session/entries', { path, window: { tail: 40 } });
  assert(initialWindow.window?.before, 'the one-turn fixture is split into bounded pages');
  assert(initialWindow.entries.length < canonicalIds.length, 'the initial read is a real bounded tail');

  // Producer-level boundary proof uses the same revision the UI must send.
  const boundary = canonicalIds.at(-40);
  const boundaryIndex = canonicalIds.indexOf(boundary);
  const pageBefore = await check.rpc('pi/session/entries', {
    path,
    window: { beforeEntry: boundary, limit: 40 },
    baseRevision: initialWindow.window.revision,
  });
  assert(pageBefore.entries.length <= 200, 'beforeEntry respects the producer row ceiling');
  assert.deepEqual(pageBefore.entries.map(entry => entry.id), canonicalIds.slice(boundaryIndex - pageBefore.entries.length, boundaryIndex),
    'beforeEntry is exclusive and contiguous');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
  const selectSession = async (name) => {
    const item = sessions.locator('[data-slot="aui_thread-list-item-trigger"]').filter({ hasText: name }).first();
    if (mobile && !await item.isVisible()) await page.getByRole('button', { name: /^(Sessions|Show sessions)$/ }).click();
    await item.click();
    await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  };
  await selectSession(title);
  await page.getByText('Tool-heavy history turn complete.', { exact: false }).first().waitFor();

  const viewport = page.locator('[data-slot="thread-viewport"]');
  const rootPrompt = page.locator('[data-role="user"]').filter({ hasText: 'Run one tool-heavy history turn' });
  const earlier = () => page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
  const loadingEarlier = () => page.getByRole('main').getByRole('button', { name: 'Loading earlier messages…', exact: true });
  const settleRender = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settleScroll = () => viewport.evaluate(element => new Promise(resolve => {
    let previous = element.scrollTop; let stable = 0;
    const frame = () => {
      const current = element.scrollTop;
      stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) resolve(current); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  const activateEarlier = async (mode, ready) => {
    const control = earlier();
    const handle = await control.elementHandle();
    assert(handle, `the ${mode} earlier control is mounted`);
    if (mode !== 'programmatic') await control.scrollIntoViewIfNeeded();
    await settleRender();
    if (ready) await ready();
    if (mode === 'programmatic') await handle.evaluate(element => element.click());
    else if (mode === 'tap') await control.tap();
    else if (mode === 'keyboard') { await control.focus(); await control.press('Enter'); }
    else if (mode === 'wheel') { await viewport.hover(); await page.mouse.wheel(0, -1200); }
    else await control.click();
    await page.waitForFunction(element => !element.isConnected || element.textContent?.includes('Loading earlier messages'), handle, { timeout: 10_000 });
    await loadingEarlier().waitFor({ state: 'hidden', timeout: 30_000 });
    await settleRender();
  };
  const driveViewportToRoot = async () => {
    if (touch) {
      const box = await viewport.boundingBox();
      assert(box, 'the touch viewport has bounds');
      const cdp = await page.context().newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      const startY = Math.round(box.y + Math.min(80, box.height / 4));
      const endY = Math.round(box.y + box.height - Math.min(30, box.height / 8));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: endY }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settleRender();
      }
      await cdp.detach();
    } else {
      await viewport.hover();
      await page.mouse.wheel(0, -100_000);
      await settleRender();
    }
  };
  const pageDiagnostics = async () => {
    const windows = [];
    let result = await check.rpc('pi/session/entries', { path, window: { tail: 40 } });
    for (let count = 0; count < 12; count += 1) {
      windows.push({ ids: result.entries.map(entry => entry.id).filter(Boolean), complete: result.window?.complete, before: result.window?.before });
      if (!result.window?.before) break;
      result = await check.rpc('pi/session/entries', { path, window: { before: result.window.before, limit: 40 }, baseRevision: result.window.revision });
    }
    const viewportState = await viewport.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      mounted: [...element.querySelectorAll('[data-window-message]')].map(row => row.getAttribute('data-window-message')) }));
    return { windows, viewportState };
  };
  let pages = 0;
  const pageToRoot = async (mode) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await driveViewportToRoot();
      if (await rootPrompt.count()) { await rootPrompt.scrollIntoViewIfNeeded(); await rootPrompt.waitFor(); return; }
      if (await earlier().count()) { await activateEarlier(mode); pages += 1; continue; }
      if (await loadingEarlier().count()) { await loadingEarlier().waitFor({ state: 'hidden', timeout: 30_000 }); continue; }
      await Promise.race([
        rootPrompt.waitFor({ state: 'attached', timeout: 2_000 }),
        earlier().waitFor({ timeout: 2_000 }),
        loadingEarlier().waitFor({ timeout: 2_000 }),
      ]).catch(() => undefined);
      if (await rootPrompt.count() || await earlier().count() || await loadingEarlier().count()) continue;
      break;
    }
    assert.fail(`canonical root is unavailable: ${JSON.stringify(await pageDiagnostics())}`);
  };

  await viewport.evaluate(element => { element.scrollTop = 0; });
  await settleRender();
  await earlier().waitFor();

  // Each matrix lane spends its one oversized-turn page through a different
  // supported input; real-touch lanes always use tap.
  const activation = touch ? 'tap' : check.state.width === 390 ? 'keyboard' : check.state.theme === 'light' ? 'wheel' : 'click';
  const liveRequest = check.rpc('session/prompt', {
    path,
    content: [{ type: 'text', text: `fixture-stream: revision evolves while paging ${check.state.width} ${check.state.theme}` }],
  });
  const streamDeadline = Date.now() + 20_000;
  while (!(await check.rpc('session/load', { path })).state.isStreaming) {
    assert(Date.now() < streamDeadline, 'the append enters its streaming phase');
    await sleep(25);
  }
  let concurrentAnchor;
  let concurrentMarker;
  await activateEarlier(activation, async () => {
    concurrentMarker = page.getByText('Tool-heavy history turn complete.', { exact: false }).first();
    await concurrentMarker.waitFor();
    concurrentAnchor = await concurrentMarker.evaluate(node => ({ top: node.getBoundingClientRect().top, text: node.textContent }));
  });
  pages += 1;
  await concurrentMarker.waitFor();
  const concurrentAfter = await concurrentMarker.evaluate(node => ({ top: node.getBoundingClientRect().top, text: node.textContent }));
  const concurrentAnchorDelta = concurrentAfter.top - concurrentAnchor.top;
  assert.equal(concurrentAfter.text, concurrentAnchor.text, 'concurrent prepend preserves the anchored visible content');
  assert(Math.abs(concurrentAnchorDelta) <= 48, `concurrent prepend moved the visible anchor more than one control row: ${concurrentAnchorDelta}px`);
  assert.equal((await check.rpc('session/load', { path })).state.isStreaming, true, 'the anchored prepend completes while output still appends');
  const live = await liveRequest;
  assert.equal(live.accepted, true, 'the live append is accepted');
  await settled(check, path);

  // Continue through producer-split gaps with keyboard or real touch, then
  // scroll the virtualized transcript before asserting the canonical root.
  await pageToRoot(touch ? 'tap' : 'keyboard');
  const wheelUsed = activation === 'wheel';

  // Root, intermediate and latest calls are visible and interactive in the
  // expanded aggregate; producer checks above pin their actual output bodies.
  await rootPrompt.hover();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await rootPrompt.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Run one tool-heavy history turn/, 'the oldest message action still targets the right row');
  const aggregate = page.getByRole('button', { name: /Ran 90 commands/ });
  await aggregate.waitFor();
  if (await aggregate.getAttribute('aria-expanded') !== 'true') {
    if (touch) await aggregate.tap(); else await aggregate.click();
  }
  const outputMarkers = new Map();
  for (const number of [1, 45, 90]) {
    const row = page.locator('[data-slot="tool-call"]').filter({ hasText: action(number) }).first();
    await row.scrollIntoViewIfNeeded();
    await row.waitFor();
    const trigger = row.locator('[data-slot="tool-fallback-trigger"]');
    if (await trigger.getAttribute('aria-expanded') !== 'true') {
      if (touch) await trigger.tap(); else await trigger.click();
    }
    const marker = row.getByText(`${action(number)} output line 120 stays reachable after paging.`, { exact: false }).first();
    await marker.waitFor();
    outputMarkers.set(number, marker);
  }

  // Preserve the person's open intermediate output through compaction before
  // reload is allowed to prove recovery from the newly accepted revision.
  const middleOutput = outputMarkers.get(45);
  await middleOutput.scrollIntoViewIfNeeded();
  if (touch) {
    const box = await viewport.boundingBox();
    assert(box, 'the touch viewport has bounds before compaction');
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 32 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await viewport.hover();
    await page.mouse.wheel(0, -32);
  }
  await settleScroll();
  const compactAnchorBefore = await middleOutput.evaluate(node => ({ top: node.getBoundingClientRect().top, text: node.textContent }));

  // A real compaction keeps the active reading position. A deliberate session
  // re-entry (not a page reload) accepts the bounded current tail; paging then
  // reaches the root against the post-compaction revision.
  await check.rpc('pi/session/compact', { path, instructions: 'Summarize the tool-heavy fixture without dropping canonical history.' });
  await settled(check, path);
  await settleRender();
  await settleScroll();
  await middleOutput.waitFor();
  const compactAnchorAfter = await middleOutput.evaluate(node => ({ top: node.getBoundingClientRect().top, text: node.textContent }));
  const compactionAnchorDelta = compactAnchorAfter.top - compactAnchorBefore.top;
  assert.equal(compactAnchorAfter.text, compactAnchorBefore.text, 'compaction preserves the open intermediate output');
  assert(Math.abs(compactionAnchorDelta) <= 8, `compaction moved the active reading anchor ${compactionAnchorDelta}px before reload`);
  const holding = await check.rpc('session/new', { cwd: fixture.project });
  const holdingTitle = `History re-read ${check.state.width} ${check.state.theme}`;
  await check.rpc('pi/model/set', { path: holding.state.path, model: { provider: 'stub', id: 'stub-1' } });
  const holdingPrompt = await check.rpc('session/prompt', { path: holding.state.path, content: [{ type: 'text', text: 'Keep this session available for an explicit history re-read' }] });
  assert.equal(holdingPrompt.accepted, true, 'the re-read destination is accepted');
  await settled(check, holding.state.path);
  await check.rpc('pi/session/rename', { path: holding.state.path, name: holdingTitle });
  await selectSession(holdingTitle);
  await selectSession(title);
  await page.getByText('Streaming line 40:', { exact: false }).first().waitFor();
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await settleRender();
  await earlier().waitFor();
  await activateEarlier(activation);
  pages += 1;
  await pageToRoot(touch ? 'tap' : 'keyboard');
  assert.equal(await earlier().count() + await loadingEarlier().count(), 0, `all canonical history is reachable after compaction (${pages})`);

  const after = await check.rpc('pi/session/entries', { path });
  const afterIds = after.entries.map(entry => entry.id).filter(Boolean);
  assert.deepEqual(afterIds.slice(0, canonicalIds.length), canonicalIds, 'append and compaction preserve canonical identity and order');
  assert.equal(afterIds.length, new Set(afterIds).size, 'canonical identities remain unique');
  assert(after.entries.some(entry => entry.type === 'compaction'), 'the run includes a real compaction entry');

  // Visible product diagnostics, not a test-only store probe: the active view
  // may exceed the former 1.5 MiB dormant-view share while the person reads it.
  if (mobile && await page.getByRole('button', { name: 'Sessions', exact: true }).isVisible()) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const diagnostics = page.locator('[data-slot="resource-diagnostics"]');
  await diagnostics.waitFor();
  const cacheRow = diagnostics.locator('tr').filter({ hasText: 'Cached conversation views' });
  const cacheText = await cacheRow.innerText();
  const retainedBytes = bytesOf(cacheText);
  assert(retainedBytes > 1_572_864, `visible Resources diagnostics report the active view above the former per-view target: ${cacheText}`);

  const evidence = {
    oneUserMessages: users.length,
    toolResults: tools.length,
    canonicalBefore: canonicalIds.length,
    canonicalAfter: afterIds.length,
    pages,
    recoveredRows: pageBefore.entries.length,
    boundary,
    activation,
    concurrentAnchorDelta,
    renderedOutputs: [1, 45, 90],
    compactionAnchorDelta,
    compactionPreserved: true,
    postCompactionWithoutReload: true,
    retainedBytes,
    cacheText,
    viewport: check.state.width,
    theme: check.state.theme,
    touch,
    wheelUsed,
    reducedMotion: check.state.theme === 'light',
  };
  await writeFile(join(check.root, `live-history-${check.state.width}-${check.state.theme}.json`), JSON.stringify(evidence, null, 2));
  await check.shot('live-history-retention');
  return evidence;
}
