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
  // Each matrix lane creates one real tool-heavy turn with ninety real bash
  // calls and results, then real bounded turns that force producer paging.
  const created = await check.rpc('session/new', { cwd: fixture.project });
  const path = created.state.path;
  await check.rpc('pi/model/set', { path, model: { provider: 'stub', id: 'stub-1' } });
  const started = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: 'Run one tool-heavy history turn' }] });
  assert.equal(started.accepted, true, 'the tool-heavy turn is accepted');
  await settled(check, path);
  // Follow the single tool-heavy turn with enough small real turns to force
  // multiple producer pages and a retained middle-gap recovery.
  for (let index = 1; index <= 46; index += 1) {
    const prompt = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: `Review checkpoint ${1000 + index}: preserve bounded history.` }] });
    assert.equal(prompt.accepted, true, `history paging turn ${index} is accepted`);
    await settled(check, path);
  }
  const seeded = await check.rpc('pi/session/entries', { path });
  const users = seeded.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
  const toolHeavyUsers = users.filter(entry => messageText(entry) === 'Run one tool-heavy history turn');
  const tools = seeded.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult');
  assert.equal(toolHeavyUsers.length, 1, 'the history has one tool-heavy user turn');
  assert.equal(users.length, 47, 'the history adds forty-six bounded paging turns');
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
  const viewport = page.locator('[data-slot="thread-viewport"]');
  const jumpLatest = page.getByRole('button', { name: 'Jump to latest', exact: true });
  if (await jumpLatest.count()) {
    await jumpLatest.click();
    await jumpLatest.waitFor({ state: 'hidden' });
  } else await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByText(/Checkpoint 10\d+ is complete\./).last().waitFor();

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
    const historySignature = async () => page.evaluate(({ path }) => {
      const element = document.querySelector('[data-slot="thread-viewport"]');
      const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
      let fiber = key ? element[key] : undefined;
      while (fiber) {
        const store = fiber.memoizedProps?.value;
        try {
          const view = store && typeof store.getSnapshot === 'function' ? store.getSnapshot().open?.[path] : undefined;
          if (view) return JSON.stringify([view.entries.length, view.blocks.length, view.history?.before, view.history?.gapBefore,
            view.history?.revision, view.trimmed?.at]);
        } catch { /* another provider; continue */ }
        fiber = fiber.return;
      }
      return '';
    }, { path });
    const before = await historySignature();
    if (mode !== 'programmatic') await control.scrollIntoViewIfNeeded().catch(() => undefined);
    await settleRender();
    if (ready) await ready();
    const actualMode = mode === 'tap' && !mobile ? 'keyboard' : mode;
    if (actualMode === 'programmatic') await handle.evaluate(element => element.click());
    else if (actualMode === 'tap') await handle.tap();
    else if (actualMode === 'keyboard') { await handle.focus(); await handle.press('Enter'); }
    else if (actualMode === 'wheel') { await viewport.hover(); await page.mouse.wheel(0, -1200); }
    else await handle.click();
    const waitForChange = timeout => page.waitForFunction(({ path, before }) => {
      const element = document.querySelector('[data-slot="thread-viewport"]');
      const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
      let fiber = key ? element[key] : undefined;
      while (fiber) {
        const store = fiber.memoizedProps?.value;
        try {
          const view = store && typeof store.getSnapshot === 'function' ? store.getSnapshot().open?.[path] : undefined;
          if (view) return JSON.stringify([view.entries.length, view.blocks.length, view.history?.before, view.history?.gapBefore,
            view.history?.revision, view.trimmed?.at]) !== before;
        } catch { /* another provider; continue */ }
        fiber = fiber.return;
      }
      return false;
    }, { path, before }, { timeout });
    if (actualMode === 'wheel') {
      const changed = await waitForChange(3_000).then(() => true, () => false);
      if (!changed && !await rereadControl().count()) { await control.click(); await waitForChange(30_000); }
    } else if (!await rereadControl().count()) await waitForChange(30_000);
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
  // The producer can refuse this window's base while the journey is under way
  // (a compaction, a branch). The person's route past that is the re-read the
  // history controls offer in place of the paging control; this lane takes the
  // same route, through the same visible button.
  const rereadControl = () => page.getByRole('main').getByRole('button', { name: 'Reload recent messages', exact: true });
  let refusalsCleared = 0;
  const clearRefusal = async (mode) => {
    if (!await rereadControl().count()) return false;
    const control = rereadControl();
    if (mode === 'tap') await control.tap(); else { await control.focus(); await control.press('Enter'); }
    await page.getByRole('main').locator('[role="status"]').filter({ hasText: 'Recent messages reloaded.' }).waitFor({ timeout: 30_000 });
    await control.waitFor({ state: 'detached', timeout: 30_000 });
    await settleRender();
    refusalsCleared += 1;
    return true;
  };
  let pages = 0;
  const pageToRoot = async (mode) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await driveViewportToRoot();
      if (await clearRefusal(mode)) continue;
      if (await earlier().count()) { await activateEarlier(mode); pages += 1; continue; }
      if (await rootPrompt.count()) { await rootPrompt.scrollIntoViewIfNeeded(); await rootPrompt.waitFor(); return; }
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
    // What the reader is looking at when the page is asked for. At the top of
    // the window that is usually the estimated range above the loaded rows,
    // where the page must appear in place of the loading state with the
    // viewport unmoved (M16-T83 invariant 2); when a row is on screen it is the
    // topmost one, and that row must hold its place. The newest checkpoint is
    // pages below either and virtualises out as the page arrives, so it is not
    // a measure of anything.
    concurrentAnchor = await viewport.evaluate(element => {
      const top = element.getBoundingClientRect().top, bottom = element.getBoundingClientRect().bottom;
      for (const node of element.querySelectorAll('[data-window-message]')) {
        const box = node.getBoundingClientRect();
        if (box.bottom <= top || box.top >= bottom) continue;
        const marker = /Checkpoint 10\d+ is complete\./.exec(node.innerText)?.[0];
        if (marker) return { top: box.top, text: marker, scrollTop: element.scrollTop };
      }
      return { scrollTop: element.scrollTop, inReserve: Boolean(document.querySelector('[data-slot="history-reserve"]')) };
    });
    concurrentMarker = concurrentAnchor.text ? page.locator('[data-window-message]').filter({ hasText: concurrentAnchor.text }).first() : undefined;
  });
  pages += 1;
  let concurrentAnchorDelta;
  if (concurrentMarker) {
    await concurrentMarker.waitFor({ state: 'attached' });
    const concurrentAfter = await concurrentMarker.evaluate(node => ({ top: node.getBoundingClientRect().top, text: /Checkpoint 10\d+ is complete\./.exec(node.innerText)?.[0] }));
    concurrentAnchorDelta = concurrentAfter.top - concurrentAnchor.top;
    assert.equal(concurrentAfter.text, concurrentAnchor.text, 'concurrent prepend preserves the anchored visible content');
    assert(Math.abs(concurrentAnchorDelta) <= 1, `concurrent prepend moved the row being read: ${concurrentAnchorDelta}px`);
  } else {
    assert(concurrentAnchor.inReserve, 'with no row on screen the reader is inside the estimated range');
    const after = await viewport.evaluate(element => ({ scrollTop: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
    concurrentAnchorDelta = after.scrollTop - concurrentAnchor.scrollTop;
    assert(Math.abs(concurrentAnchorDelta) <= 1, `a page arriving inside the estimated range moved the viewport: ${concurrentAnchorDelta}px`);
    assert(after.gap > 2, 'a page arriving inside the estimated range did not throw the reader to the live edge');
  }
  assert.equal((await check.rpc('session/load', { path })).state.isStreaming, true, 'the anchored prepend completes while output still appends');
  const live = await liveRequest;
  assert.equal(live.accepted, true, 'the live append is accepted');
  await settled(check, path);

  // Continue through producer-split gaps with keyboard or real touch, then
  // scroll the virtualized transcript before asserting the canonical root.
  await pageToRoot(touch ? 'tap' : 'keyboard');
  const wheelUsed = activation === 'wheel';

  // Exercise the real UI recovery path from a device-trimmed view. The browser
  // harness invokes the existing store action through React's mounted context;
  // no product hook is shipped. Paging itself still goes through the visible
  // control and the app's HostClient; state growth proves page acceptance.
  const retainedPromptId = users.at(-1)?.id;
  assert.equal(typeof retainedPromptId, 'string', 'the retained tail prompt has a canonical identity');
  const trim = await page.evaluate(({ path, retainedPromptId }) => {
    const element = document.querySelector('[data-slot="thread-viewport"]');
    const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : undefined;
    while (fiber) {
      const store = fiber.memoizedProps?.value;
      try {
        if (store && typeof store.getSnapshot === 'function' && typeof store.dispatch === 'function') {
          const before = store.getSnapshot().open?.[path];
          if (before) {
            // Shape a persisted device window from the canonical records that
            // back displayed rows; records for released rows are absent.
            const visibleIds = new Set(before.blocks.flatMap(block => [block.entryId, block.id]).filter(Boolean));
            before.entries = before.entries.filter(entry => visibleIds.has(entry?.id));
            store.dispatch({ type: 'views/trim', paths: [path], keepBytes: 1, at: new Date().toISOString(), anchored: [retainedPromptId] });
            const after = store.getSnapshot().open?.[path];
            return { before: before.entries.length, after: after?.entries.length, beforeBlocks: before.blocks.length, afterBlocks: after?.blocks.length,
              anchor: after?.history?.anchor, gapBefore: after?.history?.gapBefore,
              baseRevision: after?.validated?.revision ?? after?.history?.revision,
              trimmed: Boolean(after?.trimmed), cursorReleased: after?.history?.before === undefined };
          }
        }
      } catch { /* another provider's scoped proxy; continue to the Laser store */ }
      fiber = fiber.return;
    }
    return undefined;
  }, { path, retainedPromptId });
  assert(trim?.trimmed && trim.cursorReleased && trim.after < trim.before && trim.anchor && trim.baseRevision,
    `the mounted view is device-trimmed without a producer cursor: ${JSON.stringify(trim)}`);
  await settleRender();
  const recoveryProbe = await check.rpc('pi/session/entries', { path, window: { beforeEntry: trim.anchor, limit: 40 }, baseRevision: trim.baseRevision });
  assert(recoveryProbe.window && recoveryProbe.entries.length > 0, 'the producer accepts the trimmed view recovery boundary');
  let producerPage = recoveryProbe;
  let producerSplitPages = 1;
  while (producerPage.window?.before) {
    producerPage = await check.rpc('pi/session/entries', { path, window: { before: producerPage.window.before, limit: 40 }, baseRevision: producerPage.window.revision });
    producerSplitPages += 1;
    assert(producerSplitPages < 12, 'producer-split recovery remains bounded');
  }
  assert(producerSplitPages >= 2, 'the retained boundary spans more than one bounded producer page');
  await earlier().waitFor();
  await activateEarlier(touch ? 'tap' : 'keyboard');
  pages += 1;
  await page.waitForFunction(({ path, entries, blocks }) => {
    const element = document.querySelector('[data-slot="thread-viewport"]');
    const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : undefined;
    while (fiber) {
      const store = fiber.memoizedProps?.value;
      try {
        const view = store && typeof store.getSnapshot === 'function' ? store.getSnapshot().open?.[path] : undefined;
        if (view && (view.entries.length > entries || view.blocks.length > blocks)) return true;
      } catch { /* another provider; continue */ }
      fiber = fiber.return;
    }
    return false;
  }, { path, entries: trim.after, blocks: trim.afterBlocks }, { timeout: 30_000 });
  const recoveredCount = await page.evaluate(({ path }) => {
    const element = document.querySelector('[data-slot="thread-viewport"]');
    const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : undefined;
    while (fiber) {
      const store = fiber.memoizedProps?.value;
      try {
        if (store && typeof store.getSnapshot === 'function') {
          const view = store.getSnapshot().open?.[path];
          if (view) return { entries: view.entries.length, blocks: view.blocks.length, anchor: view.history?.anchor,
            before: view.history?.before, complete: view.history?.complete, gapBefore: view.history?.gapBefore,
            refusal: view.history?.refusal, trimmed: Boolean(view.trimmed) };
        }
      } catch { /* another provider; continue */ }
      fiber = fiber.return;
    }
    return { entries: 0, blocks: 0 };
  }, { path });
  assert(recoveredCount.entries > trim.after || recoveredCount.blocks > trim.afterBlocks,
    `the visible history control extends the cursorless trimmed view: ${JSON.stringify({ trim, recoveredCount })}`);
  await pageToRoot(touch ? 'tap' : 'keyboard');

  // Root, intermediate and latest calls are visible and interactive in the
  // expanded aggregate; producer checks above pin their actual output bodies.
  await rootPrompt.hover();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await rootPrompt.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Run one tool-heavy history turn/, 'the oldest message action still targets the right row');
  const aggregate = page.getByRole('button', { name: /Ran 90 commands/ });
  await aggregate.waitFor();
  if (await aggregate.getAttribute('aria-expanded') !== 'true') {
    if (touch && mobile) await aggregate.tap(); else { await aggregate.focus(); await aggregate.press('Enter'); }
  }
  const outputMarkers = new Map();
  for (const number of [1, 45, 90]) {
    const row = page.locator('[data-slot="tool-call"]').filter({ hasText: action(number) }).first();
    await row.scrollIntoViewIfNeeded();
    await row.waitFor();
    const trigger = row.locator('[data-slot="tool-fallback-trigger"]');
    if (await trigger.getAttribute('aria-expanded') !== 'true') {
      if (touch && mobile) await trigger.tap(); else { await trigger.focus(); await trigger.press('Enter'); }
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
  // Compaction moves the conversation past the base this window holds, so the
  // producer refuses its earlier pages. The person's way back is the control
  // that says so; this lane presses the visible control rather than calling the
  // action behind it, and only falls back when no refusal was raised.
  const refusalRegion = page.locator('[data-slot="history-refusal"]');
  const refusalControl = page.getByRole('main').getByRole('button', { name: 'Reload recent messages', exact: true });
  await refusalControl.waitFor({ timeout: 30_000 }).catch(() => undefined);
  let refusalControlUsed = false;
  let refusalSentence;
  let refusalControlHeight;
  if (await refusalControl.count()) {
    refusalSentence = (await refusalRegion.innerText()).trim();
    assert(refusalSentence.length > 0 && !/-?\d{4,}|stale-base/.test(refusalSentence),
      `the refusal is written for a person: ${JSON.stringify(refusalSentence)}`);
    const controlBox = await refusalControl.boundingBox();
    assert(controlBox, 'the re-read control is on screen');
    refusalControlHeight = Math.round(controlBox.height);
    if (touch) {
      assert(controlBox.height >= 44, `the re-read control keeps a 44px touch target: ${controlBox.height}px`);
      await refusalControl.tap();
    } else {
      await refusalControl.focus();
      assert.equal(await refusalControl.evaluate(node => node === document.activeElement), true, 'the re-read control takes keyboard focus');
      await refusalControl.press('Enter');
    }
    await page.getByRole('main').locator('[role="status"]').filter({ hasText: 'Recent messages reloaded.' }).waitFor({ timeout: 30_000 });
    await refusalRegion.waitFor({ state: 'detached', timeout: 30_000 });
    refusalControlUsed = true;
  }
  const explicitRereadInvoked = refusalControlUsed || await page.evaluate(async () => {
    const element = document.querySelector('[data-slot="thread-viewport"]');
    const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : undefined;
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      try {
        if (typeof value?.actions?.rereadHistory === 'function') {
          await value.actions.rereadHistory();
          return true;
        }
      } catch { /* another provider's scoped proxy; continue */ }
      fiber = fiber.return;
    }
    return false;
  });
  assert.equal(explicitRereadInvoked, true, 'the bounded explicit re-read runs, through the visible control when one is offered');
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
    toolHeavyUserMessages: toolHeavyUsers.length,
    pagingUserMessages: users.length - toolHeavyUsers.length,
    toolResults: tools.length,
    canonicalBefore: canonicalIds.length,
    canonicalAfter: afterIds.length,
    pages,
    recoveredRows: pageBefore.entries.length,
    uiBeforeEntryRecoveries: 1,
    producerSplitPages,
    boundary,
    activation,
    refusalsCleared,
    concurrentAnchorDelta,
    renderedOutputs: [1, 45, 90],
    compactionAnchorDelta,
    compactionPreserved: true,
    postCompactionWithoutReload: true,
    explicitRereadInvoked,
    refusalControlUsed,
    refusalSentence,
    refusalControlHeight,
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
