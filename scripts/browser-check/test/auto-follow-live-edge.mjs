import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIMIT = 2.01;

export default async function autoFollowLiveEdge(check) {
  const { page, fixture } = check;
  const originalTouch = check.state.touch;
  const tag = `${check.state.width}-${check.state.theme}-${check.state.reducedMotion ? 'reduced' : 'motion'}`;
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const viewport = page.locator('[data-slot="thread-viewport"]');
  await viewport.waitFor();

  const frames = async (count = 1) => {
    for (let index = 0; index < count; index += 1) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  const geometry = label => viewport.evaluate((element, label) => ({
    label,
    at: performance.now(),
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
  }), label);
  const pin = async () => {
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await frames(4);
    const value = await geometry('pin');
    assert.ok(Math.abs(value.gap) <= LIMIT, `pin left a ${value.gap}px gap`);
  };
  const waitSettled = async (timeout = 120_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (!(await check.rpc('session/load', { path: fixture.path })).state.isStreaming) return;
      await sleep(25);
    }
    throw new Error('session did not settle');
  };
  const sampleUntilSettled = async label => {
    const samples = [];
    let quiet = 0;
    while (samples.length < 20 || quiet < 4) {
      await frames();
      samples.push(await geometry(label));
      const streaming = (await check.rpc('session/load', { path: fixture.path })).state.isStreaming;
      quiet = streaming ? 0 : quiet + 1;
      await sleep(8);
    }
    return samples;
  };
  const prompt = async (text, label, atEdge = true) => {
    const request = check.rpc('session/prompt', { path: fixture.path, content: [{ type: 'text', text }] });
    const samples = await sampleUntilSettled(label);
    assert.equal((await request).accepted, true, `${label} prompt was accepted`);
    await waitSettled();
    await frames(3);
    samples.push(await geometry(`${label}-settled`));
    if (atEdge) assert.ok(samples.every(value => Math.abs(value.gap) <= LIMIT), `${label} painted away from the edge: ${Math.max(...samples.map(value => value.gap))}px`);
    return samples;
  };

  await page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="thread-viewport"]');
    if (!viewport || window.__autoFollowWriters) return;
    const records = [];
    let frame = 0;
    const tick = () => { frame += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const note = kind => records.push({ frame, kind, at: performance.now(), top: viewport.scrollTop });
    let owner = viewport;
    let descriptor;
    while (owner && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(owner, 'scrollTop'); owner = Object.getPrototypeOf(owner); }
    if (!descriptor?.get || !descriptor?.set) throw new Error('scrollTop descriptor is unavailable');
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { note('scrollTop'); descriptor.set.call(this, value); },
    });
    const nativeScrollTo = viewport.scrollTo.bind(viewport);
    viewport.scrollTo = (...args) => { note('scrollTo'); return nativeScrollTo(...args); };
    window.__autoFollowWriters = {
      reset() { records.length = 0; },
      read() {
        const writers = new Map(), writes = new Map();
        for (const record of records) {
          if (!writers.has(record.frame)) writers.set(record.frame, new Set());
          writers.get(record.frame).add(record.kind);
          writes.set(record.frame, (writes.get(record.frame) ?? 0) + 1);
        }
        return {
          writes: records.length,
          maxPerFrame: Math.max(0, ...[...writers.values()].map(value => value.size)),
          maxWritesPerFrame: Math.max(0, ...writes.values()),
          records: records.slice(),
        };
      },
    };
  });
  const resetWriters = () => page.evaluate(() => window.__autoFollowWriters.reset());
  const writers = () => page.evaluate(() => window.__autoFollowWriters.read());

  await frames(8);
  const fresh = await geometry('fresh-open');
  assert.ok(Math.abs(fresh.gap) <= LIMIT, `fresh open missed latest by ${fresh.gap}px`);

  const noOpResults = [];
  const noOps = [
    ['down-wheel', async () => { await viewport.hover(); await page.mouse.wheel(0, 500); }],
    ['tap', async () => {
      const box = await viewport.boundingBox(); assert.ok(box, 'viewport has a box for tap');
      await check.touch(true); await page.touchscreen.tap(box.x + box.width / 2, box.y + 24); await check.touch(originalTouch);
    }],
    ['arrow-down', async () => { await viewport.evaluate(element => { element.tabIndex = -1; element.focus(); }); await page.keyboard.press('ArrowDown'); }],
    ['page-down', async () => page.keyboard.press('PageDown')],
    ['end', async () => page.keyboard.press('End')],
    ['space', async () => page.keyboard.press('Space')],
  ];
  let checkpoint = 930;
  for (const [name, gesture] of noOps) {
    await pin();
    const before = await geometry(`${name}-before`);
    await gesture(); await sleep(80); await frames(2);
    const afterGesture = await geometry(`${name}-gesture`);
    assert.ok(Math.abs(afterGesture.scrollTop - before.scrollTop) <= LIMIT && Math.abs(afterGesture.gap) <= LIMIT, `${name} moved at the physical bottom`);
    await resetWriters();
    const samples = await prompt(`checkpoint ${checkpoint++}`, `${name}-passive`);
    noOpResults.push({ name, before, afterGesture, maxGap: Math.max(...samples.map(value => value.gap)), writers: await writers() });
  }

  const live = {};
  await pin(); await resetWriters(); live.streaming = await prompt(`fixture-stream: live edge ${tag}`, 'streaming'); live.streamingWriters = await writers();
  await pin(); live.reasoning = await prompt(`checkpoint ${checkpoint++} fixture reasoning`, 'reasoning');
  await pin(); live.markdown = await prompt('Render auto-follow markdown and code', 'markdown-code');
  await page.waitForFunction(() => [...document.querySelectorAll('pre code')].some(code => code.textContent?.includes('measuredLiveEdge') && code.querySelector('span[style]')), undefined, { timeout: 30_000 });
  await frames(4);
  assert.ok(Math.abs((await geometry('highlight-settled')).gap) <= LIMIT, 'async syntax highlighting left the edge');
  await pin(); live.tool = await prompt('Run fixture tools', 'tool');
  await pin(); live.child = await prompt('Start fixture-failed', 'child');

  await pin();
  const delayedRequest = check.rpc('session/prompt', { path: fixture.path, content: [{ type: 'text', text: 'Run auto-follow delayed tool group' }] });
  const group = page.locator('[data-slot="tool-group-trigger"]').last();
  await group.waitFor({ timeout: 20_000 });
  if ((await group.getAttribute('data-state')) !== 'open') await group.click();
  live.delayedTool = await sampleUntilSettled('delayed-tool');
  assert.equal((await delayedRequest).accepted, true);
  await waitSettled(); await frames(3);
  live.delayedTool.push(await geometry('delayed-tool-settled'));
  assert.ok(live.delayedTool.every(value => Math.abs(value.gap) <= LIMIT), `delayed grouped result left ${Math.max(...live.delayedTool.map(value => value.gap))}px`);

  if ((await group.getAttribute('data-state')) === 'open') await group.click();
  await frames(3); await pin(); await resetWriters();
  const disclosure = [];
  await group.click();
  for (let index = 0; index < 24; index += 1) { await frames(); disclosure.push(await geometry('disclosure')); }
  assert.ok(disclosure.every(value => Math.abs(value.gap) <= LIMIT), `disclosure painted a ${Math.max(...disclosure.map(value => value.gap))}px gap`);
  const disclosureWriters = await writers();

  await pin(); await resetWriters();
  const image = await viewport.evaluate(async element => {
    const row = element.querySelector('[data-window-message]:last-of-type') ?? element.querySelector('[data-window-message]');
    if (!row) throw new Error('no mounted row for image decode');
    const image = document.createElement('img');
    image.alt = 'auto-follow decode fixture';
    image.style.display = 'block';
    row.append(image);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="180"><rect width="48" height="180" fill="currentColor"/></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    image.src = url;
    await loaded;
    URL.revokeObjectURL(url);
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  await frames(4);
  const imageAfter = await geometry('image-decode');
  assert.deepEqual(image, { width: 48, height: 180 });
  assert.ok(Math.abs(imageAfter.gap) <= LIMIT, `image decode left ${imageAfter.gap}px`);
  const imageWriters = await writers();

  await pin(); await viewport.hover(); await page.mouse.wheel(0, -800); await sleep(150); await frames(2);
  const awayBefore = await geometry('away-before');
  assert.ok(awayBefore.gap >= 500, `upward wheel did not leave the edge (${awayBefore.gap}px)`);
  await resetWriters();
  const awayTop = awayBefore.scrollTop;
  await prompt(`fixture-stream: reader remains away ${tag}`, 'away-stream', false);
  await prompt('Render auto-follow markdown and code', 'away-markdown', false);
  const awayAfter = await geometry('away-after');
  assert.ok(Math.abs(awayAfter.scrollTop - awayTop) <= LIMIT, `passive growth moved the reader ${awayTop} -> ${awayAfter.scrollTop}`);
  const awayWriters = await writers();

  if (originalTouch || check.state.width === 390) {
    await pin();
    const box = await viewport.boundingBox(); assert.ok(box, 'viewport has a box for touch momentum');
    await check.touch(true);
    const x = box.x + box.width / 2, start = box.y + box.height * 0.35;
    await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + step * 55, id: 1 }] });
      await sleep(12);
    }
    await check.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350); await frames(2);
    const momentumAway = await geometry('momentum-away');
    assert.ok(momentumAway.gap >= 100, `coarse touch movement did not leave the edge (${momentumAway.gap}px)`);
    const momentumTop = momentumAway.scrollTop;
    await prompt(`checkpoint ${checkpoint++}`, 'momentum-passive', false);
    const momentumAfter = await geometry('momentum-after');
    // Residual momentum may continue upward during the prompt. It must never
    // reverse toward the newly grown tail or re-pin to it.
    assert.ok(momentumAfter.scrollTop <= momentumTop + LIMIT && momentumAfter.gap >= 100, `passive output undid touch momentum: ${JSON.stringify({ momentumAway, momentumAfter })}`);
    await check.touch(originalTouch);
  }

  await viewport.hover();
  let returnedBottom = await geometry('return-start');
  for (let attempt = 0; attempt < 10 && Math.abs(returnedBottom.gap) > LIMIT; attempt += 1) {
    await page.mouse.wheel(0, 1_200); await sleep(80); await frames(2);
    returnedBottom = await geometry('returned-bottom');
  }
  assert.ok(Math.abs(returnedBottom.gap) <= LIMIT, `returning to bottom did not re-arm geometry: ${JSON.stringify(returnedBottom)}`);
  await prompt(`checkpoint ${checkpoint++}`, 'rearmed-passive');

  await page.evaluate(() => { document.documentElement.style.zoom = '1.1'; }); await frames(4); await pin();
  const fractionalBefore = await geometry('fractional-before');
  await prompt(`checkpoint ${checkpoint++}`, 'fractional-passive');
  const fractionalAfter = await geometry('fractional-after');
  await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await frames(3);

  for (const result of noOpResults) assert.ok(result.writers.maxPerFrame <= 1, `${result.name} used ${result.writers.maxPerFrame} scrollTop writers in one frame`);
  assert.ok(live.streamingWriters.maxPerFrame <= 1, `streaming used ${live.streamingWriters.maxPerFrame} scrollTop writers in one frame`);
  assert.ok(disclosureWriters.maxPerFrame <= 1, `disclosure used ${disclosureWriters.maxPerFrame} scrollTop writers in one frame`);
  assert.ok(imageWriters.maxPerFrame <= 1, `image decode used ${imageWriters.maxPerFrame} scrollTop writers in one frame`);
  assert.ok(awayWriters.maxPerFrame <= 1, `scroll-away used ${awayWriters.maxPerFrame} scrollTop writers in one frame`);

  const result = {
    tag, fresh, noOps: noOpResults.map(({ name, maxGap, writers }) => ({ name, maxGap, writes: writers.writes, maxWritersPerFrame: writers.maxPerFrame, maxWritesPerFrame: writers.maxWritesPerFrame })),
    live: {
      streamingMaxGap: Math.max(...live.streaming.map(value => value.gap)),
      reasoningMaxGap: Math.max(...live.reasoning.map(value => value.gap)),
      markdownMaxGap: Math.max(...live.markdown.map(value => value.gap)),
      toolMaxGap: Math.max(...live.tool.map(value => value.gap)),
      childMaxGap: Math.max(...live.child.map(value => value.gap)),
      delayedToolMaxGap: Math.max(...live.delayedTool.map(value => value.gap)),
      disclosureMaxGap: Math.max(...disclosure.map(value => value.gap)), imageAfter, image,
      maxWritersPerFrame: Math.max(live.streamingWriters.maxPerFrame, disclosureWriters.maxPerFrame, imageWriters.maxPerFrame),
      maxWritesPerFrame: Math.max(live.streamingWriters.maxWritesPerFrame, disclosureWriters.maxWritesPerFrame, imageWriters.maxWritesPerFrame),
    },
    away: { before: awayBefore, after: awayAfter, writes: awayWriters.writes, maxWritersPerFrame: awayWriters.maxPerFrame, maxWritesPerFrame: awayWriters.maxWritesPerFrame },
    fractional: { before: fractionalBefore, after: fractionalAfter },
  };
  writeFileSync(join(check.root, `auto-follow-live-edge-${tag}.json`), JSON.stringify(result, null, 2));
  await check.shot(`auto-follow-live-edge-${tag}`);
  console.log(`AUTO_FOLLOW_LIVE_EDGE ${JSON.stringify(result)}`);
}
