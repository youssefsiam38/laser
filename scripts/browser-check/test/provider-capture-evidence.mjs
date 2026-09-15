import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * Bounded provider logging, as a person meets it (M18-T7 / RP-7).
 *
 * A large request no longer crosses the app as one enormous message: the
 * worker redacts and measures it once, sends it in bounded pieces, and the
 * host stores it in bounded pieces. This drives a real turn whose request is
 * past the chunking threshold and then checks the two things a person can see:
 *
 *  - the inspector opens that request and shows its real content;
 *  - when only part of a body can be shown, the page says how much of how much
 *    it is showing, names the fingerprint of the redacted copy the app keeps,
 *    and stays legible at both widths, in both themes.
 *
 * The truncated case is read at a small budget through the app's own
 * `pi/logs/content` — the same call the inspector makes — so the numbers under
 * the sentence are the host's, not the script's.
 */
export default async function providerCaptureEvidence(check) {
  const { page } = check;
  // Every case runs twice: once as the matrix set it up, and once with reduced
  // motion, which is a first-class case here (AGENTS.md) and not a variant of
  // one width or one theme.
  const reduced = process.env.LASER_T7_REDUCED_MOTION === '1';
  await check.reducedMotion(reduced);
  const label = `${check.state.width}-${check.state.theme}${reduced ? '-reduced' : ''}`;
  const touch = check.state.width === 390;
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  const caseName = `Large request ${label}`;
  const seeded = await seedFixture(
    { rpc: check.rpc },
    { root: join(check.root, `capture-${label}`), node: process.execPath, until },
    'short',
  );
  await check.rpc('pi/session/rename', { path: seeded.path, name: caseName });

  // A capture is the whole conversation of its turn, so the request grows with
  // the session. Four large turns take the stored body past the inspector's
  // 8 MiB read budget, which is the only way to see the truncated state for
  // real, and one more takes the next request past the 16 MiB ceiling, which
  // is how a request is recorded without its body at all.
  const block = 'The quick brown fox jumps over the lazy dog. '.repeat(75_000);
  /** The largest provider request this session has recorded so far. */
  const largestStored = async () => {
    const page = await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 });
    return page.entries.reduce((max, entry) => Math.max(max, entry.detailRef?.bytes ?? 0), 0);
  };
  for (let turn = 0; turn < 5; turn++) {
    const before = await largestStored();
    await check.rpc('session/prompt', { path: seeded.path, content: [{ type: 'text', text: `fixture-large ${turn}: ${block}` }] });
    // A prompt is accepted before the turn runs, so waiting on `isStreaming`
    // can pass before anything has happened: wait for the request this turn
    // makes to actually be recorded.
    await until(async () => (await largestStored()) > before, `turn ${turn} to be captured`, 180_000);
    await until(
      async () => !(await check.rpc('session/load', { path: seeded.path })).state.isStreaming,
      `turn ${turn} to settle`,
      180_000,
    );
    if ((await largestStored()) > 8 * 1024 * 1024) break;
  }

  // Rows the host kept for those turns, through the app's own read path.
  const rows = await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 });
  const stored = rows.entries.filter(entry => (entry.detailRef?.bytes ?? 0) > 8 * 1024 * 1024).pop();
  assert.ok(stored, `no provider request over 8 MiB was recorded for ${caseName}; this check needs a truncated read`);
  assert.match(stored.detailRef.ref, /^[0-9a-f]{64}$/, 'the row carries the digest of the redacted copy');

  // The host returns at most what it is asked for, and says what the whole
  // thing weighs; the inspector asks for 8 MiB, so this body truncates there.
  const partial = await check.rpc('pi/logs/content', { ref: stored.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
  assert.equal(partial.truncated, true, 'the stored body is larger than the inspector budget');
  assert.equal(partial.truncatedAt, Buffer.byteLength(partial.text, 'utf8'), 'the reply says how much it is handing over');
  assert.equal(partial.bytes, stored.detailRef.bytes, 'and still reports the stored size');
  assert.ok(!partial.text.includes('\ufffd'), 'the cut is on a character boundary');

  // One more turn takes the next request past the capture ceiling, so it is
  // recorded without its body at all.
  // Prompt again until the next request is past the capture ceiling: each turn
  // carries the whole conversation, so this arrives within a couple of turns.
  let omittedRef;
  for (let attempt = 0; attempt < 4 && !omittedRef; attempt++) {
    const before = (await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 })).entries.length;
    await check.rpc('session/prompt', { path: seeded.path, content: [{ type: 'text', text: `fixture-ceiling ${attempt}: ${block}` }] });
    await until(
      async () =>
        (await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 })).entries.length > before,
      'the next turn to be captured',
      180_000,
    );
    await until(
      async () => !(await check.rpc('session/load', { path: seeded.path })).state.isStreaming,
      'the next turn to settle',
      180_000,
    );
    const rowsNow = await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 });
    const newest = rowsNow.entries.at(-1);
    const body = await check.rpc('pi/logs/content', { ref: newest.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
    if (body.released?.reason === 'over-ceiling') omittedRef = newest;
  }
  assert.ok(omittedRef, 'no request past the capture ceiling was recorded; this check needs the omitted state');

  const omitted = omittedRef;
  const omittedBody = await check.rpc('pi/logs/content', { ref: omitted.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
  assert.equal(omittedBody.released.reason, 'over-ceiling');
  assert.equal(omittedBody.text, '', 'nothing of it is returned');

  // Now the surface. The Logs screen is where these rows live, and it shows
  // them without asking the transcript to paint megabytes of prompt — which is
  // its own problem (RP-5) and not what this checks.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const logs = page.getByRole('button', { name: 'Logs', exact: true }).first();
  if (touch) await logs.tap(); else await logs.click();
  await until(
    async () => (await page.locator('[role=list] li').count()) > 0 && (await page.getByText('Loading log pages').count()) === 0,
    'the first log page',
    30_000,
  );

  /** Open one provider request row by the size the store gave it. */
  const openRow = async (size, want) => {
    // The list is virtualized, so find the row the way a person would: the
    // store's own search, over the line it wrote for that request. Several
    // requests can round to the same size, so the first match is not
    // necessarily the one this case means; check what opened.
    const search = page.getByRole('searchbox', { name: 'Search logs' }).or(page.locator('[aria-label="Search logs"]')).first();
    await search.waitFor({ timeout: 30_000 });
    await search.fill(size);
    await page.waitForTimeout(600);
    const rows = page.locator('[role=option]').filter({ hasText: size });
    const count = Math.min(await rows.count(), 6);
    assert.ok(count > 0, `no log row shows a ${size} request`);
    const detail = page.locator('[aria-label="Log entry detail"]').first();
    for (let index = 0; index < count; index++) {
      const row = rows.nth(index);
      await row.scrollIntoViewIfNeeded();
      if (touch) await row.tap(); else await row.click();
      await detail.waitFor({ timeout: 30_000 });
      // The detail is a pane on a desktop and a sheet on a phone; either way
      // the released panel is on the page when the row has no body.
      await page.waitForTimeout(200);
      const released = (await page.locator('[data-slot=released-body]').count()) > 0;
      if (want === 'released' ? released : !released) return detail;
    }
    throw new Error(`no ${size} row in the log list is the ${want} one`);
  };

  /** The row the detail pane is showing, read back from the host by its id. */
  const rowOnScreen = async detail => {
    const text = (await detail.innerText()).replace(/\s+/g, ' ');
    const id = Number(/id #(\d+)/.exec(text)?.[1]);
    assert.ok(Number.isFinite(id), `the detail pane names its row: ${text.slice(0, 200)}`);
    const page_ = await check.rpc('pi/logs/query', { kind: 'provider_request', afterId: id - 1, limit: 1 });
    const entry = page_.entries[0];
    assert.ok(entry && entry.id === id, `the host still has row #${id}`);
    return { text, entry };
  };

  // A request that kept no body: its reason, its exact size and its whole
  // digest are on the page, and none of the request is.
  const releasedPanel = await openRow(formatSize(omittedBody.released.bytes), 'released');
  const releasedRow = await rowOnScreen(releasedPanel);
  const releasedContent = await check.rpc('pi/logs/content', { ref: releasedRow.entry.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
  assert.equal(releasedContent.released.reason, 'over-ceiling', 'the row on screen is one the ceiling refused');
  assert.match(releasedRow.text, /larger than the size kept in full/, `the reason is stated: ${releasedRow.text.slice(0, 200)}`);
  assert.ok(
    releasedRow.text.replace(/[\u202f\u00a0]/g, ' ').includes(releasedContent.released.bytes.toLocaleString('en-US')),
    `exact stored size for #${releasedRow.entry.id}: ${releasedRow.text.slice(0, 300)}`,
  );
  assert.ok(releasedRow.text.includes(releasedRow.entry.detailRef.ref), 'the whole digest is shown');
  assert.ok(!releasedRow.text.includes('fixture-ceiling'), 'no part of the request body is on the page');
  await check.shot(`provider-capture-released-${label}`);

  // And a stored one, opened in the inspector: the prefix it asked for is
  // rendered on purpose, and the notice says exactly how much of how much.
  const storedPanel = await openRow(formatSize(stored.detailRef.bytes), 'stored');
  const storedRow = await rowOnScreen(storedPanel);
  const storedContent = await check.rpc('pi/logs/content', { ref: storedRow.entry.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
  assert.equal(storedContent.truncated, true, 'the row on screen is larger than the inspector reads');
  const view = storedPanel.getByRole('button', { name: 'View API request', exact: true });
  await view.waitFor({ timeout: 30_000 });
  if (touch) await view.tap(); else await view.click();
  const dialog = page.getByRole('dialog', { name: 'API request', exact: true });
  const notice = dialog.locator('[data-slot=request-truncated]');
  await notice.waitFor({ timeout: 120_000 });
  const truncatedText = (await notice.innerText()).replace(/\s+/g, ' ').replace(/[\u202f\u00a0]/g, ' ');
  assert.ok(truncatedText.includes(storedContent.truncatedAt.toLocaleString('en-US')), `exact shown bytes: ${truncatedText}`);
  assert.ok(truncatedText.includes(storedContent.bytes.toLocaleString('en-US')), `exact stored bytes: ${truncatedText}`);
  assert.ok(truncatedText.includes(storedRow.entry.detailRef.ref), 'the whole digest is shown');
  const shown = await dialog.locator('[data-slot=request-viewport]').innerText();
  assert.ok(
    Buffer.byteLength(shown, 'utf8') <= storedContent.truncatedAt + 8192,
    `the page holds ${Buffer.byteLength(shown, 'utf8')} bytes of a ${storedContent.truncatedAt}-byte read`,
  );
  assert.ok(storedContent.truncatedAt < storedContent.bytes, 'the read really is a prefix of a larger body');
  await check.shot(`provider-capture-truncated-${label}`);

  // Legibility, and the keyboard path out of the dialog.
  const layout = await dialog.evaluate(node => {
    const sizes = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const element = text.parentElement;
      if (!element || !element.getClientRects().length) continue;
      if (element.closest('.eyebrow')) continue;
      sizes.push(Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);
    }
    return {
      minFontSize: Math.min(...sizes),
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  assert.ok(layout.minFontSize >= 12, `no data below 12px (smallest ${layout.minFontSize}px)`);
  assert.equal(layout.pageOverflowsX, false, 'the page does not scroll sideways');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
  assert.notEqual(focused, 'NONE', 'focus went somewhere after the dialog closed');

  console.log(
    'provider capture evidence',
    JSON.stringify({
      case: label,
      reducedMotion: check.state.reducedMotion === true,
      storedBytes: stored.detailRef.bytes,
      shownBytes: partial.truncatedAt,
      omittedBytes: omittedBody.released.bytes,
      onScreen: { released: releasedRow.entry.id, stored: storedRow.entry.id },
      minFontSize: layout.minFontSize,
    }),
  );
}

/** The size a log row shows, so a row can be found by the body it carries. */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
