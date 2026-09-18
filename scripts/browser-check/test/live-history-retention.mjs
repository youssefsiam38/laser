import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = number => `Review checkpoint ${number}: verify the implementation and explain the next step.`;
const messageText = entry => typeof entry?.message?.content === 'string'
  ? entry.message.content
  : (entry?.message?.content ?? []).map(part => part?.text ?? '').join('\n');

async function settled(check, path) {
  const deadline = Date.now() + 120_000;
  while ((await check.rpc('session/load', { path })).state.isStreaming) {
    assert(Date.now() < deadline, 'the live history turn settles');
    await sleep(25);
  }
}

async function visibleUser(viewport) {
  return viewport.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll('[data-role="user"]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { text: row.textContent, top: box.top };
    }
    return null;
  });
}

export default async function liveHistoryRetention(check) {
  const { page, fixture } = check;
  assert.equal(fixture.name, 'history', 'use the dedicated history fixture');
  const touch = check.state.width === 390;
  await check.touch(touch);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  // Every matrix lane forks the immutable fixture at its last seeded prompt.
  // Live append and compaction in one lane therefore cannot contaminate the
  // next lane's initial history.
  const seeded = await check.rpc('pi/session/entries', { path: fixture.path });
  const checkpoint = seeded.entries.findLast(entry => entry.type === 'message'
    && entry.message?.role === 'user' && messageText(entry).includes(marker(120)));
  assert(checkpoint?.id, 'the dedicated fixture exposes its final seeded prompt');
  const forked = await check.rpc('pi/session/fork', { path: fixture.path, entryId: checkpoint.id });
  const path = forked.state.path;
  const title = `History retention ${check.state.width} ${check.state.theme}`;
  await check.rpc('pi/session/rename', { path, name: title });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
  if (touch) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  await sessions.waitFor();
  await sessions.locator('[data-slot="aui_thread-list-item-trigger"]').filter({ hasText: title }).first().click();
  await page.getByRole('main').getByRole('heading', { name: title, exact: true }).waitFor();

  const whole = await check.rpc('pi/session/entries', { path });
  const canonicalIds = whole.entries.map(entry => entry.id).filter(Boolean);
  const messages = whole.entries.filter(entry => entry.type === 'message');
  assert.equal(messages.length, 238, 'the body-rich fixture fork has 238 canonical messages before its final prompt');

  const boundary = canonicalIds.at(-40);
  const boundaryIndex = canonicalIds.indexOf(boundary);
  const pageBefore = await check.rpc('pi/session/entries', {
    path,
    window: { beforeEntry: boundary, limit: 40 },
  });
  assert(pageBefore.entries.length <= 200, 'beforeEntry response respects the producer row ceiling');
  assert.deepEqual(
    pageBefore.entries.map(entry => entry.id),
    canonicalIds.slice(Math.max(0, boundaryIndex - pageBefore.entries.length), boundaryIndex),
    'beforeEntry is exclusive and contiguous on the active ancestry',
  );
  assert.equal(pageBefore.window?.authority, 'live', 'the open fixture uses the live producer');
  assert.equal(typeof pageBefore.window?.before, 'string', 'the producer returns an opaque earlier-page cursor');

  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await page.getByText('Checkpoint 119 is complete.', { exact: true }).waitFor();
  const viewport = page.locator('[data-slot="thread-viewport"]');
  const earlier = () => page.getByRole('main').getByRole('button', { name: 'Load earlier messages', exact: true });
  const loadingEarlier = () => page.getByRole('main').getByRole('button', { name: 'Loading earlier messages…', exact: true });
  const waitForEarlier = async () => {
    const started = Date.now();
    let sawBusy = false;
    while (Date.now() - started < 30_000) {
      const busy = await loadingEarlier().count() > 0;
      sawBusy ||= busy;
      if (sawBusy && !busy) return;
      // A local page can settle between automation samples. After one short
      // observation window, either stable label (another page or the root) is
      // the completed state.
      if (!sawBusy && Date.now() - started >= 250) return;
      await sleep(25);
    }
    assert.fail('the earlier-page request settles');
  };
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await earlier().waitFor();

  const anchorBefore = await visibleUser(viewport);
  const initialCheckpoint = Number(/Review checkpoint (\d+):/.exec(anchorBefore?.text ?? '')?.[1]);
  assert(Number.isInteger(initialCheckpoint) && initialCheckpoint > 1, `the initial bounded tail exposes a checkpoint, got ${anchorBefore?.text?.slice(0, 80)}`);
  if (touch) await earlier().tap(); else await earlier().click();
  await waitForEarlier();
  const anchorAfter = await visibleUser(viewport);
  assert(anchorAfter?.text?.includes(marker(initialCheckpoint)), 'prepending keeps the previously visible reading anchor');
  assert(Math.abs(anchorAfter.top - anchorBefore.top) <= 8, `the pointer/touch prepend moved the viewport anchor by ${anchorAfter.top - anchorBefore.top}px`);

  await viewport.evaluate(element => { element.scrollTop = 0; });
  await earlier().focus();
  await earlier().press('Enter');
  await waitForEarlier();

  let pages = 2;
  let attempts = 0;
  while (pages < 20 && attempts++ < 40) {
    if (await loadingEarlier().count()) {
      await waitForEarlier();
      pages += 1;
      continue;
    }
    if (!await earlier().count()) break;
    await sleep(100);
    if (await loadingEarlier().count()) continue;
    const activated = await (touch ? earlier().tap({ timeout: 2_000 }) : earlier().click({ timeout: 2_000 })).then(() => true, () => false);
    if (!activated) continue;
    await waitForEarlier();
    pages += 1;
  }
  assert.equal(await earlier().count() + await loadingEarlier().count(), 0, `all earlier pages load within the bounded gesture limit (${pages})`);
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await page.getByText(marker(1), { exact: false }).waitFor();
  assert(pages >= 5, `history loaded through multiple bounded pages (${pages})`);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const composerValue = () => page.evaluate(() => document.querySelector('main textarea[aria-label="Message"]')?.value);
  await composer.fill('Draft retained while reading earlier history.');
  const oldAnchor = await visibleUser(viewport);
  assert(oldAnchor?.text?.includes(marker(1)), 'the oldest marker is the active reading anchor');

  const live = await check.rpc('session/prompt', {
    path,
    content: [{ type: 'text', text: `fixture-stream: active retained history ${check.state.width} ${check.state.theme}` }],
  });
  assert.equal(live.accepted, true, 'the live append is accepted');
  await settled(check, path);
  assert.equal(await composerValue(), 'Draft retained while reading earlier history.', 'the draft survives live append reconciliation');
  const afterLive = await visibleUser(viewport);
  assert(afterLive?.text?.includes(marker(1)), 'live output does not replace the earlier reading window with a tail');
  assert(Math.abs(afterLive.top - oldAnchor.top) <= 8, `live output moved the reading anchor by ${afterLive.top - oldAnchor.top}px`);

  await check.rpc('pi/session/compact', { path, instructions: 'Summarize the synthetic fixture without dropping its canonical entries.' });
  await settled(check, path);
  assert.equal(await composerValue(), 'Draft retained while reading earlier history.', 'the draft survives compaction refresh');
  const afterCompact = await visibleUser(viewport);
  assert(afterCompact?.text?.includes(marker(1)), 'compaction refresh preserves the active earlier reading window');

  const after = await check.rpc('pi/session/entries', { path });
  const afterIds = after.entries.map(entry => entry.id).filter(Boolean);
  assert.deepEqual(afterIds.slice(0, canonicalIds.length), canonicalIds, 'append and compaction preserve canonical entry identity and order');
  assert.equal(afterIds.length, new Set(afterIds).size, 'canonical entry identities remain unique');
  assert(after.entries.some(entry => entry.type === 'compaction'), 'the acceptance run includes a real compaction entry');

  await composer.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.waitFor();
  await find.fill('Streaming line 40');
  await page.getByRole('main').getByText('Streaming line 40: the implementation follows the project boundaries.', { exact: true }).waitFor();
  await find.fill('Review checkpoint 1:');
  await page.getByRole('main').locator('[data-role="user"]').filter({ hasText: marker(1) }).waitFor();
  await find.press('Escape');

  const evidence = {
    canonicalBefore: canonicalIds.length,
    canonicalAfter: afterIds.length,
    initialCheckpoint,
    recoveredRows: pageBefore.entries.length,
    pages,
    boundary,
    recoveredFirst: pageBefore.entries[0]?.id,
    recoveredLast: pageBefore.entries.at(-1)?.id,
    anchorDeltas: {
      prepend: anchorAfter.top - anchorBefore.top,
      live: afterLive.top - oldAnchor.top,
      compact: afterCompact.top - oldAnchor.top,
    },
    viewport: check.state.width,
    theme: check.state.theme,
    touch,
    reducedMotion: check.state.theme === 'light',
  };
  await writeFile(join(check.root, `live-history-${check.state.width}-${check.state.theme}.json`), JSON.stringify(evidence, null, 2));
  await check.shot('live-history-retention');
  return evidence;
}
