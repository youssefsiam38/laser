import assert from 'node:assert/strict';

import { syntheticPng } from '../resource/fixtures.mjs';
import { until } from '../lifecycle.mjs';
import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * A message larger than this window keeps (RP-5b, M18-T16), against a real
 * host and a real conversation.
 *
 * Before this, one large message was held whole — twice — and rendered whole:
 * a single 2 MB reply put the renderer past two gigabytes. Now the transcript
 * holds a bounded excerpt and a reference, and the rest is read back a slice
 * at a time through `session/entry_range` from the conversation's own
 * authority.
 *
 * What is proved here, and cannot be proved in a unit test:
 *
 *  1. **The fold is honest.** It ends the message with one action that says
 *     how much there is, in a person's words (M16-T60).
 *  2. **The transcript stays small.** The rendered row, and the whole document,
 *     stay far below the size of the message itself.
 *  3. **Reading works end to end**, through the real protocol: the viewer opens
 *     with a keyboard and scrolls continuously against a real host, holding at
 *     most three segments.
 *  4. **It closes cleanly**, returning focus where it came from, at both
 *     widths, both themes, with a pointer, a thumb, a keyboard, and with
 *     reduced motion.
 */

/** Well over the renderer's per-body excerpt bound (16 KiB), and cheap to send. */
const PROMPT_BYTES = 400_000;

export default async function largeBody(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  await check.touch(phone);

  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  // A real prompt, through the real host: the person's own words, persisted as
  // one canonical entry far larger than the window may hold.
  const filler = 'This is one long paragraph of a very long message. ';
  const text = `Large body fixture\n\n${filler.repeat(Math.ceil(PROMPT_BYTES / filler.length))}`;
  const path = check.fixture.path;
  const accepted = await check.rpc('session/prompt', { path, content: [{ type: 'text', text }] });
  assert.equal(accepted.accepted, true, 'the host accepted the large prompt');
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!(await check.rpc('session/load', { path })).state.isStreaming) break;
    await page.waitForTimeout(500);
  }

  // The window reads the conversation again the ordinary way.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();

  const notice = page.locator('[data-slot="body-overflow"]').first();
  await notice.waitFor({ timeout: 60_000 });
  const words = scrub(await notice.textContent());
  assert.match(words, /^Show full message · \d+ KB$/, `the fold says what it opens and how much: ${words}`);
  assert.doesNotMatch(words, /not kept|window|RP-5|byte offset|entry_range/, 'nothing in the fold is written for a machine');

  // The transcript itself stays small: the message is not in the document.
  const documentBytes = (await page.evaluate(() => document.body.innerText.length));
  assert.ok(documentBytes < PROMPT_BYTES / 4, `the rendered document stays far below the message (${documentBytes} characters)`);

  // Move the conversation while this old fold remains on screen. This is the
  // revision race that used to leave an empty viewer. The new prompt also
  // carries an oversized real PNG: its 28-byte text must stay inline both
  // while the reply streams and after the turn settles.
  const imagePrompt = 'fixture-stream: image prompt';
  assert.equal(Buffer.byteLength(imagePrompt), 28, 'the regression prompt stays the reported 28 bytes');
  const image = syntheticPng(768, 3);
  assert.ok(image.toString('base64').length > 16 * 1024, 'the image exceeds the transcript body bound');
  await composer.fill(imagePrompt);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await (await chooser).setFiles({ name: 'image-prompt.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => (await check.rpc('session/load', { path })).state.isStreaming, 'the image turn to start', 20_000);
  const promptText = page.getByText(imagePrompt, { exact: true });
  const assertImagePrompt = async label => {
    await page.waitForFunction(text => document.body.textContent?.includes(text), imagePrompt, { timeout: 30_000 });
    assert.equal(await promptText.count(), 1, `the image prompt text is retained exactly once ${label}`);
    const row = page.locator('[data-role="user"]').filter({ hasText: imagePrompt }).last();
    const picture = row.locator('[data-slot="message-image"]');
    await until(async () => {
      if (await picture.count() !== 1) return false;
      return picture.evaluate(node => node.complete && node.naturalWidth > 0 && node.naturalHeight > 0);
    }, `the prompt image to decode ${label}`, 30_000);
    const decoded = await picture.evaluate(node => ({ complete: node.complete, width: node.naturalWidth, height: node.naturalHeight }));
    assert.deepEqual(decoded, { complete: true, width: 768, height: 768 }, `the exact PNG decoded ${label}`);
    assert.doesNotMatch(scrub(await row.textContent()), /Image not kept in this window/, `no unavailable image placeholder ${label}`);
    assert.equal(await page.getByText('Show full message · 28 B', { exact: true }).count(), 0, `the fitting text does not fold ${label}`);
  };
  await assertImagePrompt('while streaming');
  // Reload while this latest turn is still live: the bounded tail contains its
  // prompt, and subsequent deltas advance the revision around the same image.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  await assertImagePrompt('after reload');
  await promptText.scrollIntoViewIfNeeded();
  await promptText.waitFor({ state: 'visible' });

  // Opening it: keyboard first, because every pointer path has one. The pager
  // refreshes the stale revision once and still verifies the body's digest.
  const open = notice.locator('[data-slot="body-overflow-open"]');
  await open.waitFor();
  if (phone) await activate(open); else { await open.focus(); await page.keyboard.press('Enter'); }
  const dialog = page.locator('[data-slot="output-viewer"]');
  await dialog.waitFor({ timeout: 30_000 });
  const heading = scrub(await dialog.getByRole('heading').first().textContent());
  assert.equal(heading, 'Full message', `the viewer names what it is showing: ${heading}`);

  const scroller = dialog.locator('[data-slot="output-viewer-scroller"]');
  await scroller.locator('[data-run]').first().waitFor({ timeout: 30_000 });
  const firstBytes = (await scroller.textContent()).length;
  assert.ok(firstBytes > 0, 'the first segment arrived from the host');
  assert.ok(firstBytes < PROMPT_BYTES / 2, 'the viewer did not read the whole message at once');
  await check.shot(`large-body-viewer${check.state.touch ? '-touch' : ''}`);

  // Scrolling is continuous and bounded: wherever the reader is, at most three
  // segments are held, and the one in view is among them.
  for (const fraction of [0.35, 0.7, 0.5]) {
    await scroller.evaluate((node, f) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * f; }, fraction);
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-slot="output-viewer-scroller"]');
      return node && !node.hasAttribute('aria-busy') && node.querySelector('[data-run]');
    }, undefined, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const held = await scroller.locator('[data-segment]').count();
    assert.ok(held >= 1 && held <= 3, `at most three segments held (${held}) at ${fraction}`);
    const visible = await scroller.evaluate(node => {
      const view = node.getBoundingClientRect();
      return [...node.querySelectorAll('[data-run]')].some(run => { const box = run.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom; });
    });
    assert.ok(visible, `text is in view after scrolling to ${fraction}, not a blank`);
  }
  await check.shot(`large-body-scrolled${check.state.touch ? '-touch' : ''}`);

  // Copy and Download are real controls; Home returns to the start.
  assert.equal(await dialog.getByRole('button', { name: /Copy full message/ }).count(), 1, 'the whole message can be copied');
  assert.equal(await dialog.getByRole('button', { name: 'Download .txt' }).count(), 1, 'the whole message can be saved');
  await scroller.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer-scroller"]')?.scrollTop === 0, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => /Large body fixture/.test(document.querySelector('[data-slot="output-viewer-scroller"]')?.textContent ?? ''), undefined, { timeout: 30_000 });

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer"]') === null, undefined, { timeout: 30_000 });
  assert.equal(await page.locator('[data-segment]').count(), 0, 'closing drops everything the viewer read');
  await until(async () => !(await check.rpc('session/load', { path })).state.isStreaming, 'the image turn to settle', 90_000);
  const lastReply = page.locator('[data-role="assistant"]').last();
  await lastReply.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.locator('[data-slot="thread-viewport"]').evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - node.clientHeight / 2); });
  await assertImagePrompt('after settlement');
  if (!phone) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-slot') ?? '');
    assert.equal(focused, 'body-overflow-open', `focus returned to the control that opened it (${focused})`);
  }

  await check.shot(`large-body-fold${check.state.touch ? '-touch' : ''}`);
  await watch.assertClean();
}
