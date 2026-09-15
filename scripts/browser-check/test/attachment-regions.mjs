import assert from 'node:assert/strict';

import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * The files inside a prompt this window does not hold (RP-5b §2), against a
 * real host and a real conversation.
 *
 * A prompt with attachments is stored as one text with canonical wrappers
 * around the files. When that prompt is larger than this surface may hold, the
 * surface has only an excerpt of it — the wrappers are mostly in bytes it does
 * not have — so the conversation's own authority names them: where each file's
 * stored bytes are, how big they are, what they are called, and the digest of
 * those bytes. This proves the whole path end to end, which no unit test can:
 *
 *  1. **Chips are the authority's**, with honest names, types and sizes. No
 *     wrapper markup is rendered, and no chip claims to be a file this window
 *     does not have.
 *  2. **Opening one reads it back and verifies it**: the decoded content is
 *     exactly the file's, including `<`, `&`, quotes, tabs and newlines.
 *  3. **The overflow is exact**, and opens a browser that holds one page at a
 *     time: the second page is the remaining files, with no row of the first
 *     left behind and nothing accumulated.
 *  4. **Every way in works**: a pointer on the desktop, a thumb on the phone, a
 *     keyboard everywhere, with focus returned to what opened each surface.
 *  5. **Nothing grows**: the document stays small, there is no sideways scroll,
 *     and the page logs nothing.
 */

/** Enough files to pass the page cap (64) and leave a second page behind it. */
const FILE_COUNT = 70;
/** Well past the renderer's per-body excerpt bound, so the prompt is elided. */
const PROSE_BYTES = 40_000;

const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const escapeAttribute = text => escapeText(text).replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');

/** The canonical wrapper, exactly as the composer writes one. */
export function wrapFile(file) {
  const size = Buffer.byteLength(file.content, 'utf8');
  return `<attached-file name="${escapeAttribute(file.name)}" type="${escapeAttribute(file.mediaType)}" size="${size}">\n${escapeText(file.content)}\n</attached-file>`;
}

/** The files this prompt carries: escaped characters, Unicode, and real shapes. */
export function fixtureFiles(count = FILE_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    name: `note-${String(index).padStart(2, '0')}.ts`,
    mediaType: 'text/plain',
    content: `// file ${index} — ünïcødé 答 😀\nif (a < b && c > "d") {\n\tsay('hello & goodbye');\n}\n`,
  }));
}

export default async function attachmentRegions(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  await check.touch(phone);

  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  // One real prompt, through the real host: prose past the excerpt bound, and
  // seventy files in canonical wrappers after it.
  const files = fixtureFiles();
  const filler = 'Here is a long prompt with files attached to it. ';
  const prose = `Attachment fixture\n\n${filler.repeat(Math.ceil(PROSE_BYTES / filler.length))}`;
  const text = [prose, ...files.map(wrapFile)].join('\n\n');
  const path = check.fixture.path;
  const accepted = await check.rpc('session/prompt', { path, content: [{ type: 'text', text }] });
  assert.equal(accepted.accepted, true, 'the host accepted the prompt with attachments');
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!(await check.rpc('session/load', { path })).state.isStreaming) break;
    await page.waitForTimeout(500);
  }

  // Read the conversation again the ordinary way.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();

  // 1 · The chips the authority named.
  const chips = page.locator('[data-slot="file-chip"]');
  await chips.first().waitFor({ timeout: 60_000 });
  const chipCount = await chips.count();
  assert.ok(chipCount > 0 && chipCount <= 64, `the row shows a bounded number of files (${chipCount})`);
  const chipText = scrub(await chips.first().textContent());
  assert.match(chipText, /note-\d\d\.ts/, `a chip is named after its file: ${chipText}`);
  const body = scrub(await page.locator('body').innerText());
  assert.doesNotMatch(body, /<attached-file/, 'no wrapper markup is ever rendered');
  assert.doesNotMatch(body, /&amp;quot;|&#10;/, 'no stored escaping reaches the screen');

  // The transcript itself stays small: the prompt is not in the document.
  const documentCharacters = await page.evaluate(() => document.body.innerText.length);
  assert.ok(documentCharacters < Buffer.byteLength(text, 'utf8') / 4,
    `the rendered document stays far below the prompt (${documentCharacters} characters)`);

  // 2 · Opening a file: keyboard first, because every pointer path has one.
  const firstChip = chips.first();
  await firstChip.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog');
  await viewer.waitFor({ timeout: 30_000 });
  const shown = scrub(await viewer.innerText());
  // The decoded file, exactly — the characters that are escaped in storage.
  assert.match(shown, /if \(a < b && c > "d"\)/, `the file's own text is shown, decoded: ${shown.slice(0, 200)}`);
  assert.match(shown, /ünïcødé/, 'multi-byte characters survive the round trip');
  assert.match(shown, /say\('hello & goodbye'\);/, 'ampersands are decoded, not doubled');
  assert.doesNotMatch(shown, /&amp;|&lt;|&quot;/, 'nothing stored-escaped is shown as text');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, undefined, { timeout: 30_000 });
  const backOnChip = await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  assert.match(backOnChip, /note-\d\d\.ts/, `focus returned to the chip that opened it (${backOnChip})`);

  // 3 · The overflow says exactly how many more, and opens the browser.
  const overflow = page.locator('[data-slot="attachment-overflow"]').first();
  await overflow.waitFor({ timeout: 30_000 });
  const overflowWords = scrub(await overflow.textContent());
  assert.match(overflowWords, /^\d+ more attachments? in this message$/,
    `the overflow gives the exact number the authority counted: ${overflowWords}`);
  const missing = Number(/^(\d+)/.exec(overflowWords)[1]);
  assert.equal(chipCount + missing, FILE_COUNT, `every file is accounted for (${chipCount} + ${missing})`);

  // Pointer on the desktop, a real thumb on the phone.
  await activate(overflow);
  const browser = page.locator('[data-slot="attachment-browser-list"]');
  await browser.waitFor({ timeout: 30_000 });
  const rows = page.locator('[data-slot="attachment-browser-item"]');
  await rows.first().waitFor({ timeout: 30_000 });
  const firstPage = await rows.allInnerTexts();
  assert.ok(firstPage.length > 0 && firstPage.length <= 64, `the browser holds one bounded page (${firstPage.length})`);
  const firstNames = firstPage.map(row => /note-\d\d\.ts/.exec(row)?.[0]).filter(Boolean);
  assert.equal(new Set(firstNames).size, firstNames.length, 'a page never lists the same file twice');

  // The next page replaces this one; it does not add to it.
  const next = page.getByRole('button', { name: /^Next$/ });
  if (await next.isEnabled()) {
    await next.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(previous => {
      const listed = [...document.querySelectorAll('[data-slot="attachment-browser-item"]')].map(node => node.textContent);
      return listed.length > 0 && listed.join('|') !== previous;
    }, firstPage.join('|'), { timeout: 30_000 });
    const secondPage = await rows.allInnerTexts();
    const secondNames = secondPage.map(row => /note-\d\d\.ts/.exec(row)?.[0]).filter(Boolean);
    assert.ok(secondNames.length > 0, 'the second page lists the files the first one did not');
    assert.ok(secondNames.length <= 64, `the second page is bounded too (${secondNames.length})`);
    for (const name of secondNames) assert.ok(!firstNames.includes(name), `${name} is not repeated from the first page`);
    assert.equal(new Set(secondNames).size, secondNames.length, 'the second page never lists the same file twice');
  }

  // Closing gives focus back to what opened it.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="attachment-browser-list"]') === null, undefined, { timeout: 30_000 });
  const backOnOverflow = await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  assert.match(backOnOverflow, /more attachments? in this message/, `focus returned to the overflow control (${backOnOverflow})`);

  // 5 · Nothing grew, nothing scrolls sideways, nothing was logged.
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(sideways <= 1, `the page never scrolls sideways (${sideways}px)`);
  const afterCharacters = await page.evaluate(() => document.body.innerText.length);
  assert.ok(afterCharacters < Buffer.byteLength(text, 'utf8') / 4,
    `the document is still small after all of that (${afterCharacters} characters)`);

  await check.shot(`attachment-regions-${check.state.width}-${check.state.theme}${check.state.touch ? '-touch' : ''}${check.state.reducedMotion ? '-reduced' : ''}`);
  await watch.assertClean();
}
