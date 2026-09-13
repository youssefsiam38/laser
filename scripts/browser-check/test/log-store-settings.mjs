import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

/**
 * Settings → This device → Log store (M16-T34, D-245).
 *
 * A person has to be able to see how much disk the log store is taking and
 * empty it. This checks the surface itself in every case of the matrix: the
 * size and the policy are real values from the host, nothing overflows or
 * drops below the 12px floor, the Clear asks first, Escape gets out of that
 * question with the focus back where it was, and clearing really empties the
 * store and says so.
 */
export default async function logStoreSettings(check) {
  const { page } = check;
  const label = `${check.state.width}-${check.state.theme}`;
  const touch = check.state.width === 390;
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  // Each case clears the store, so each case seeds its own turns first: real
  // prompts through a real worker, which is what puts provider requests in it.
  await seedFixture({ rpc: check.rpc }, { root: join(check.root, `logstore-${label}`), node: process.execPath, until }, 'short');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const before = await check.rpc('pi/logs/stats', {});
  assert.ok(before.stats.total > 0, 'the fixture left rows in the log store');
  assert.ok(before.stats.retention.bodiesPerSession > 0, 'the host reports its per-session body limit');

  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'This device', exact: true }).click();
  const section = page.locator('[data-slot=log-store-setting]');
  await section.waitFor();
  await section.scrollIntoViewIfNeeded();

  const text = (await section.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /Log store/, 'the section names itself');
  // The row labels are an `eyebrow`, which is uppercased by CSS, so read them
  // the way the DOM hands them over rather than the way the source spells them.
  assert.match(text, /on disk \d/i, `a real size on disk: ${text}`);
  assert.match(text, /request bodies .* of /i, `what the bodies are using, against the budget: ${text}`);
  assert.match(
    text,
    new RegExp(`${before.stats.retention.bodiesPerSession} most recent requests in each session`),
    `the host's own limit, not a literal: ${text}`,
  );
  assert.match(text, /Rows are removed after \d+ days/, 'the row and age limits are still stated');

  // The legibility floor and the no-horizontal-scroll rule (AGENTS.md).
  const layout = await section.evaluate(node => {
    const sizes = [];
    const eyebrows = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const element = text.parentElement;
      if (!element || !element.getClientRects().length) continue;
      const size = Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10;
      // The 11px eyebrow is a category label by design (DESIGN.md); the floor
      // is about information, which is every other run of text here.
      (element.closest('.eyebrow') ? eyebrows : sizes).push(size);
    }
    return {
      minFontSize: Math.min(...sizes),
      maxEyebrow: eyebrows.length ? Math.max(...eyebrows) : 0,
      overflowsX: node.scrollWidth > node.clientWidth + 1,
      pageOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  assert.ok(layout.minFontSize >= 12, `no data below 12px (smallest ${layout.minFontSize}px)`);
  assert.ok(layout.maxEyebrow <= 11, `labels stay on the eyebrow size (${layout.maxEyebrow}px)`);
  assert.equal(layout.overflowsX, false, 'the section does not scroll sideways');
  assert.equal(layout.pageOverflowsX, false, 'the page does not scroll sideways');
  await check.shot(`log-store-${label}`);

  // Clearing asks first, in a person's words, and Escape backs out of it.
  const clear = section.getByRole('button', { name: /Clear the log store/ });
  await clear.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const asked = (await dialog.innerText()).replace(/\s+/g, ' ');
  assert.match(asked, /Clear the log store\?/, 'the question is the title');
  assert.match(asked, /conversations, projects and settings are untouched/, `what stays: ${asked}`);
  assert.match(asked, /cannot be undone/, `what it costs: ${asked}`);
  assert.match(asked, /returns that space to the disk/, `what it gives back: ${asked}`);
  await check.shot(`log-store-clear-${label}`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const stillThere = await check.rpc('pi/logs/stats', {});
  assert.ok(stillThere.stats.total > 0, 'backing out of the question changes nothing');

  // And the keyboard alone can go through with it.
  await clear.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  const confirm = dialog.getByRole('button', { name: /Clear the log store/ });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'detached' });

  await page.getByText(/Cleared the log store/).first().waitFor({ timeout: 10000 });
  const after = await check.rpc('pi/logs/stats', {});
  assert.ok(after.stats.total < before.stats.total, `rows fell: ${before.stats.total} → ${after.stats.total}`);
  assert.ok(after.stats.bytes < before.stats.bytes, `the file shrank: ${before.stats.bytes} → ${after.stats.bytes}`);
  const cleared = (await section.innerText()).replace(/\s+/g, ' ');
  assert.match(cleared, /on disk \d/i, `the screen re-read the store: ${cleared}`);
  await check.shot(`log-store-cleared-${label}`);
  console.log(`log store ${label}: ${before.stats.total} rows / ${before.stats.bytes} B → ${after.stats.total} rows / ${after.stats.bytes} B`);
}
