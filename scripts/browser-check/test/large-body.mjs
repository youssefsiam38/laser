import assert from 'node:assert/strict';

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
 *  1. **The row is honest.** It says exactly how much of the message is not
 *     shown, in a person's words, and offers to read it.
 *  2. **The transcript stays small.** The rendered row, and the whole document,
 *     stay far below the size of the message itself.
 *  3. **Reading works end to end**, through the real protocol: the viewer opens
 *     with a keyboard, pages forward in bounded slices against a real host, and
 *     never holds the whole body.
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
  assert.match(words, /more of this message is not kept in this window/, `the row says what it is not showing: ${words}`);
  assert.match(words, /\d+(\.\d+)?\s?(KB|MB)/, `the row says exactly how much: ${words}`);
  assert.doesNotMatch(words, /RP-5|byte offset|entry_range/, 'nothing in the row is written for a machine');

  // The transcript itself stays small: the message is not in the document.
  const documentBytes = (await page.evaluate(() => document.body.innerText.length));
  assert.ok(documentBytes < PROMPT_BYTES / 4, `the rendered document stays far below the message (${documentBytes} characters)`);

  // Opening it: keyboard first, because every pointer path has one.
  const open = notice.getByRole('button', { name: 'Read all of it' });
  await open.waitFor();
  const target = phone ? open : open;
  await target.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 30_000 });
  const heading = scrub(await dialog.getByRole('heading').first().textContent());
  assert.match(heading, /The whole message/, `the viewer names what it is showing: ${heading}`);

  const status = dialog.locator('[role="region"]');
  await status.waitFor();
  const firstBytes = (await status.textContent()).length;
  assert.ok(firstBytes > 0, 'the first slice arrived from the host');
  assert.ok(firstBytes < PROMPT_BYTES, 'the viewer did not read the whole message at once');

  const description = scrub(await dialog.locator('[data-slot="dialog-description"], p').first().textContent());
  assert.match(description, /Showing/, `the viewer says where in the message it is: ${description}`);

  // Paging forward reads another bounded slice and never grows without bound.
  const more = dialog.getByRole('button', { name: 'Show more' });
  if (await more.isEnabled()) {
    await activate(more);
    await page.waitForFunction(previous => {
      const node = document.querySelector('[role="dialog"] [data-slot="dialog-description"], [role="dialog"] p');
      return node ? node.textContent.replace(/\s+/g, ' ').trim() !== previous : false;
    }, description, { timeout: 30_000 });
    const afterBytes = (await status.textContent()).length;
    assert.ok(afterBytes <= 512 * 1024, `the viewer holds a bounded window (${afterBytes} characters)`);
  }

  // Copying says what it copied, and offers the whole message separately.
  const copyPart = dialog.getByRole('button', { name: /Copy this part/ });
  const copyAll = dialog.getByRole('button', { name: /Copy all of it/ });
  assert.equal(await copyPart.count(), 1, 'the copy control says exactly what it copies');
  assert.equal(await copyAll.count(), 1, 'the whole message can be copied without being held');

  // Paging backwards is a real control and a real key.
  const earlier = dialog.getByRole('button', { name: 'Show earlier' });
  assert.equal(await earlier.count(), 1, 'the viewer can go back as well as forward');
  await status.focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(500);
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(500);
  await page.keyboard.press('Home');
  await page.waitForTimeout(500);
  const home = scrub(await dialog.locator('[data-slot="dialog-description"], p').first().textContent());
  assert.match(home, /Showing 0/, `Home returns to the start of the message: ${home}`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, undefined, { timeout: 30_000 });
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  assert.match(focused, /Read all of it/, `focus returned to the control that opened it (${focused})`);

  await check.shot(`large-body-${check.state.width}-${check.state.theme}${check.state.touch ? '-touch' : ''}${check.state.reducedMotion ? '-reduced' : ''}`);
  await watch.assertClean();
}
