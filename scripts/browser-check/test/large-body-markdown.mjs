import assert from 'node:assert/strict';

import { markdownReply } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';
import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * Reading the whole of a reply as a document (M16-T84), against a real host
 * and a real conversation.
 *
 * Before this, "Show full reply" opened a monospace pane where a heading was
 * asterisks and a list was hyphens. What this proves, and a unit test cannot:
 *
 *  1. **The whole reply reads as the transcript draws it** — headings, bold,
 *     lists, a fenced block with its language header, a table, a link — read
 *     back from the host through `session/entry_range`, at both widths and in
 *     both themes, with nothing left as Markdown source and no page scroll.
 *  2. **Find works on what is drawn**: real DOM ranges, a count, next and
 *     previous, and the current match really inside the reading area.
 *  3. **Plain text is one control away** and shows the characters themselves.
 *  4. **Home and End still read it from the keyboard**, and Escape gives focus
 *     back to the control that opened it.
 *  5. **A body too large to format says so in the person's words** and keeps
 *     the paged plain reader, with no toggle offered.
 *  6. Reduced motion loses nothing but movement.
 */

/** Well past the transcript's per-body excerpt bound, and larger than one formatted document. */
const TOO_LONG_BYTES = 400_000;

export default async function largeBodyMarkdown(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  await check.touch(phone);

  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  const path = check.fixture.path;
  const reply = markdownReply();

  // A real turn through the real host: the reply is Markdown, and larger than
  // the transcript keeps.
  const accepted = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: 'Show fixture markdown' }] });
  assert.equal(accepted.accepted, true, 'the host accepted the prompt');
  await until(async () => !(await check.rpc('session/load', { path })).state.isStreaming, 'the markdown reply to settle', 120_000);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();

  const fold = page.locator('[data-slot="body-overflow"]').filter({ hasText: 'Show full reply' }).last();
  await fold.waitFor({ timeout: 60_000 });
  const words = scrub(await fold.textContent());
  assert.match(words, /^Show full reply · \d+ KB$/, `the fold says what it opens and how much: ${words}`);

  // How the transcript draws a paragraph of prose, before the viewer opens
  // over it. A reply this size reaches the window as a reference with no text
  // at all — the row is the fold — so the comparison is with the rows that do
  // carry prose, which is what "the same renderer" has to mean.
  const transcriptProse = await page.evaluate(() => {
    const body = document.querySelector('[data-role="assistant"] .md-body p');
    if (!body) return undefined;
    const style = getComputedStyle(body);
    return { fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight };
  });
  assert.ok(transcriptProse, 'the transcript carries a paragraph of prose to compare with');
  const replyRow = page.locator('[data-role="assistant"]').filter({ hasText: 'Show full reply' }).last();
  assert.equal(scrub(await replyRow.textContent()).includes('Section 1'), false, 'a reply this large reaches the window as a reference, not as text');

  const open = fold.locator('[data-slot="body-overflow-open"]');
  const dialog = page.locator('[data-slot="output-viewer"]');
  const document_ = dialog.locator('[data-slot="body-viewer-document"]');
  const started = Date.now();
  if (phone) await activate(open); else { await open.focus(); await page.keyboard.press('Enter'); }
  await dialog.waitFor({ timeout: 30_000 });
  await document_.waitFor({ timeout: 60_000 });
  const drawnMs = Date.now() - started;

  // 1 · It reads as the transcript draws it.
  const drawn = await document_.evaluate((node, source) => ({
    headings: [...node.querySelectorAll('h2')].map(h => h.textContent).slice(0, 2),
    bold: node.querySelector('strong')?.textContent ?? '',
    items: [...node.querySelectorAll('li')].map(li => li.textContent).slice(0, 2),
    code: node.querySelector('pre code')?.textContent ?? '',
    codeLanguage: node.querySelector('[data-slot="code-header"] .eyebrow')?.textContent ?? '',
    copyCode: node.querySelector('[data-slot="code-header"] button')?.getAttribute('aria-label') ?? '',
    tableHead: [...node.querySelectorAll('th')].map(th => th.textContent).slice(0, 2),
    link: node.querySelector('a')?.textContent ?? '',
    text: node.textContent ?? '',
    smallest: Math.min(...[...node.querySelectorAll('p, li, td, th, h2')].map(el => Number.parseFloat(getComputedStyle(el).fontSize)).filter(Number.isFinite)),
    inlineCode: Number.parseFloat(getComputedStyle(node.querySelector('p code')).fontSize),
    sourceStart: source.slice(0, 40),
  }), reply);
  assert.deepEqual(drawn.headings, ['Section 1: what changed', 'Section 2: what changed'], 'headings are headings');
  assert.equal(drawn.bold, 'Designing FeatureScopeProps lifecycle and draft management (1)', 'emphasis is emphasis, not asterisks');
  assert.deepEqual(drawn.items, ['first consideration for section 1', 'second consideration for section 1'], 'a list is a list');
  assert.match(drawn.code, /export const section1 = \{ scope: "project" \};/, 'the fence is a code block');
  assert.equal(drawn.codeLanguage, 'ts', 'the code block carries its language header');
  assert.equal(drawn.copyCode, 'Copy code', 'the whole reply is not an excerpt, so its code copies unmarked');
  assert.deepEqual(drawn.tableHead, ['Field', 'Meaning'], 'a table is a table');
  assert.equal(drawn.link, 'the notes', 'a link shows its words');
  assert.ok(!drawn.text.includes('**') && !drawn.text.includes('```') && !drawn.text.includes('| Field |'), 'no Markdown source is left on screen');
  assert.ok(drawn.smallest >= 12, `no prose in the document is below 12px (${drawn.smallest})`);
  // The reader is the transcript's renderer, not a copy of it: prose in the
  // full reply is set exactly as prose in the transcript is.
  const viewerProse = await document_.evaluate(node => {
    const style = getComputedStyle(node.querySelector('p'));
    return { fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight };
  });
  assert.deepEqual(viewerProse, transcriptProse, 'prose reads the same in the viewer as in the transcript');
  assert.ok(drawn.inlineCode > 0 && drawn.inlineCode < drawn.smallest, 'a code span is the renderer\u2019s own, smaller than its prose');
  const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(pageScroll <= 1, `no horizontal page scroll (${pageScroll})`);
  const region = dialog.locator('[data-slot="output-viewer-scroller"]');
  assert.equal(await region.getAttribute('role'), 'region', 'the reading area is still a region');
  await check.shot(`markdown-viewer${check.state.touch ? '-touch' : ''}`);

  // 2 · Find on the rendered document: count, next, previous, and the current
  // match really brought into the reading area.
  const field = dialog.getByRole('searchbox');
  const count = dialog.locator('[data-slot="output-viewer-find-count"]');
  // A phrase the renderer draws exactly as the model wrote it, so what the
  // reply contains and what the document shows can be counted against each
  // other rather than guessed.
  const phrase = 'first consideration for section 4';
  const expected = reply.split(phrase).length - 1;
  assert.ok(expected > 1, `the fixture carries more than one “${phrase}” (${expected})`);
  const findStarted = Date.now();
  await field.fill(phrase);
  await activate(dialog.getByRole('button', { name: 'Find in reply', exact: true }));
  await count.waitFor({ timeout: 30_000 });
  const findMs = Date.now() - findStarted;
  assert.equal(scrub(await count.textContent()), `1 of ${expected}`, 'every occurrence in the reply is a match in the document');
  const inView = async () => page.evaluate(() => {
    const current = CSS.highlights.get('output-viewer-current');
    const ranges = current ? [...current] : [];
    if (ranges.length !== 1) return { ranges: ranges.length, visible: false };
    const box = ranges[0].getBoundingClientRect();
    const view = document.querySelector('[data-slot="output-viewer-scroller"]').getBoundingClientRect();
    return { ranges: ranges.length, visible: box.bottom > view.top && box.top < view.bottom };
  });
  assert.deepEqual(await inView(), { ranges: 1, visible: true }, 'the match is highlighted and in view');
  await activate(dialog.getByRole('button', { name: 'Next match in reply', exact: true }));
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer-find-count"]')?.textContent?.includes('2 of'), undefined, { timeout: 30_000 });
  assert.deepEqual(await inView(), { ranges: 1, visible: true }, 'the next match is brought into view');
  await activate(dialog.getByRole('button', { name: 'Previous match in reply', exact: true }));
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer-find-count"]')?.textContent?.includes('1 of'), undefined, { timeout: 30_000 });
  await check.shot(`markdown-viewer-find${check.state.touch ? '-touch' : ''}`);
  const matches = await page.evaluate(() => CSS.highlights.get('output-viewer-matches')?.size ?? 0);
  assert.equal(matches, expected, 'every match stays marked while one is current');
  await field.fill('');

  // 3 · Plain text shows the characters themselves, and formatted comes back.
  await activate(dialog.getByRole('button', { name: 'Plain text', exact: true }));
  await page.waitForFunction(() => document.querySelector('[data-slot="body-viewer-document"]') === null, undefined, { timeout: 30_000 });
  await region.locator('[data-run]').first().waitFor({ timeout: 30_000 });
  const plain = await region.textContent();
  assert.ok(plain.includes('**Designing FeatureScopeProps lifecycle and draft management (1)**'), 'plain text is the characters the model wrote');
  assert.equal(await dialog.getByRole('button', { name: 'Wrap lines', exact: true }).count(), 1, 'the plain reader keeps Wrap lines');
  await check.shot(`markdown-viewer-plain${check.state.touch ? '-touch' : ''}`);
  await activate(dialog.getByRole('button', { name: 'Plain text', exact: true }));
  await document_.waitFor({ timeout: 60_000 });

  // 4 · Reading it from the keyboard, and closing it.
  await region.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer-scroller"]').scrollTop > 0, undefined, { timeout: 10_000 });
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer-scroller"]').scrollTop === 0, undefined, { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer"]') === null, undefined, { timeout: 30_000 });
  if (!phone) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-slot') ?? '');
    assert.equal(focused, 'body-overflow-open', `focus returned to the control that opened it (${focused})`);
  }

  // 6 · Reduced motion loses the movement and nothing else.
  await check.reducedMotion(true);
  if (phone) await activate(open); else { await open.focus(); await page.keyboard.press('Enter'); }
  await document_.waitFor({ timeout: 60_000 });
  assert.ok((await document_.textContent()).includes('Section 1: what changed'), 'the document draws the same with reduced motion');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer"]') === null, undefined, { timeout: 30_000 });
  await check.reducedMotion(false);

  // 5 · The largest body that is still formatted, and the first one that is not.
  let sections = 500;
  let nearLimit = markdownReply(sections);
  while (Buffer.byteLength(nearLimit) < 240_000) { sections += 20; nearLimit = markdownReply(sections); }
  assert.ok(Buffer.byteLength(nearLimit) < 258_000, `the near-limit body stays inside the formatted budget (${Buffer.byteLength(nearLimit)} B)`);
  const filler = 'This is one long paragraph of a very long message. ';
  const long = `# Too long to format\n\n${filler.repeat(Math.ceil(TOO_LONG_BYTES / filler.length))}`;
  for (const text of [nearLimit, long]) {
    const sent = await check.rpc('session/prompt', { path, content: [{ type: 'text', text }] });
    assert.equal(sent.accepted, true, 'the host accepted the prompt');
    await until(async () => !(await check.rpc('session/load', { path })).state.isStreaming, 'the turn to settle', 120_000);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();

  const folds = page.locator('[data-slot="body-overflow"]').filter({ hasText: 'Show full message' });
  await folds.first().waitFor({ timeout: 60_000 });
  const nearFold = folds.nth(0);
  const nearStarted = Date.now();
  await activate(nearFold.locator('[data-slot="body-overflow-open"]'));
  await dialog.waitFor({ timeout: 30_000 });
  await document_.waitFor({ timeout: 120_000 });
  const nearMs = Date.now() - nearStarted;
  await region.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(last => document.querySelector('[data-slot="body-viewer-document"]')?.textContent?.includes(last), `Section ${sections}: what changed`, { timeout: 60_000 });
  assert.equal(await dialog.locator('[data-slot="output-viewer-note"]').count(), 0, 'a body inside the budget is formatted without a word of apology');
  await check.shot(`markdown-viewer-near-limit${check.state.touch ? '-touch' : ''}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer"]') === null, undefined, { timeout: 30_000 });

  const longFold = folds.last();
  await activate(longFold.locator('[data-slot="body-overflow-open"]'));
  await dialog.waitFor({ timeout: 30_000 });
  await region.locator('[data-run]').first().waitFor({ timeout: 30_000 });
  assert.equal(await document_.count(), 0, 'a body this size is not formatted');
  assert.equal(
    scrub(await dialog.locator('[data-slot="output-viewer-note"]').textContent()),
    'This message is too long to format; showing plain text.',
    'it says why, in the person’s words',
  );
  assert.equal(await dialog.getByRole('button', { name: 'Plain text', exact: true }).count(), 0, 'no toggle is offered for a body that cannot be formatted');
  await check.shot(`markdown-too-long${check.state.touch ? '-touch' : ''}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-slot="output-viewer"]') === null, undefined, { timeout: 30_000 });

  console.log(`[markdown-viewer] ${check.state.width}px ${check.state.theme}: reply ${Buffer.byteLength(reply)} B drawn in ${drawnMs} ms, first find in ${findMs} ms, ${Buffer.byteLength(nearLimit)} B body drawn in ${nearMs} ms`);
  await watch.assertClean();
}
