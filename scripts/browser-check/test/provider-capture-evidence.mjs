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
  const label = `${check.state.width}-${check.state.theme}`;
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
  // the session rather than with any one message. Several ordinary-sized turns
  // take it past the chunking threshold without asking the transcript to paint
  // a megabyte in a single row.
  const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(3_600);
  for (let turn = 0; turn < 8; turn++) {
    await check.rpc('session/prompt', { path: seeded.path, content: [{ type: 'text', text: `fixture-large ${turn}: ${paragraph}` }] });
    await until(
      async () => !(await check.rpc('session/load', { path: seeded.path })).state.isStreaming,
      `turn ${turn} to settle`,
      120_000,
    );
  }

  // The row the host kept for it, through the app's own read path.
  const rows = await check.rpc('pi/logs/query', { kind: 'provider_request', sessionPath: seeded.path, limit: 50 });
  const large = rows.entries.filter(entry => (entry.detailRef?.bytes ?? 0) > 1024 * 1024).pop();
  assert.ok(large, `no provider request over 1 MiB was recorded for ${caseName}; this check needs the chunked path`);
  assert.match(large.detailRef.ref, /^[0-9a-f]{64}$/, 'the row carries the digest of the redacted copy');

  // Read in full, and read at a small budget: the host returns at most what it
  // was asked for and says what the whole thing weighs.
  const whole = await check.rpc('pi/logs/content', { ref: large.detailRef.ref, maxBytes: 8 * 1024 * 1024 });
  assert.equal(whole.truncated, false, 'the capture opens in full at the inspector budget');
  assert.equal(Buffer.byteLength(whole.text, 'utf8'), large.detailRef.bytes, 'what opens is exactly what the row says it stored');
  assert.ok(whole.text.includes('fixture-large'), 'the stored body is the request that was made');

  const partial = await check.rpc('pi/logs/content', { ref: large.detailRef.ref, maxBytes: 256 * 1024 });
  assert.equal(partial.truncated, true, 'a small budget returns a truncated read');
  assert.ok(
    Buffer.byteLength(partial.text, 'utf8') <= 256 * 1024,
    `a 256 KiB budget returned ${Buffer.byteLength(partial.text, 'utf8')} bytes`,
  );
  assert.equal(partial.truncatedAt, Buffer.byteLength(partial.text, 'utf8'), 'the reply says how much it is handing over');
  assert.equal(partial.bytes, large.detailRef.bytes, 'and still reports the stored size');
  assert.ok(!partial.text.includes('\ufffd'), 'the cut is on a character boundary');

  // Now the surface. Open that session and its newest request in the inspector.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: caseName }).first().click();
  await page.getByRole('main').getByRole('heading', { name: caseName, exact: true }).waitFor();

  const target = page.locator('[data-role=user]').last();
  await target.waitFor({ state: 'attached' });
  await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const more = target.getByRole('button', { name: 'More', exact: true });
  await more.waitFor();
  if (touch) await more.tap(); else await more.click();
  await page.getByRole('menuitem', { name: 'View API request', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'API request', exact: true });
  const viewport = dialog.locator('[data-slot=request-viewport]');
  await viewport.waitFor({ timeout: 60_000 });
  await check.shot(`provider-capture-${label}`);

  // The request that was captured is the one on screen, in full: its own
  // conversation, not a placeholder and not a truncation notice.
  const conversation = dialog.getByRole('button', { name: /^Conversation/ });
  if (touch) await conversation.tap(); else await conversation.click();
  await page.waitForTimeout(500);
  const shown = (await viewport.innerText()).replace(/\s+/g, ' ');
  assert.match(shown, /fixture-large/, `the inspector shows the large request: ${shown.slice(0, 160)}`);
  assert.doesNotMatch(shown, /Showing the first/, 'nothing was cut at the inspector budget, so nothing claims it was');

  // Legibility, at this width and theme, with a megabyte of request in it.
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

  // Keyboard: the dialog closes with the key a person reaches for, and gives
  // focus back to the transcript rather than to the document.
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
  assert.notEqual(focused, 'NONE', 'focus went somewhere after the dialog closed');

  console.log(
    'provider capture evidence',
    JSON.stringify({
      case: label,
      storedBytes: large.detailRef.bytes,
      digest: `${large.detailRef.ref.slice(0, 12)}…`,
      partialBytes: Buffer.byteLength(partial.text, 'utf8'),
      minFontSize: layout.minFontSize,
    }),
  );
}
