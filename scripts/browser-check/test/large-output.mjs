import assert from 'node:assert/strict';

import { activator, dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * A tool output larger than the transcript keeps (M16-T60, D-275), against a
 * real host, a real shell tool and a real stored conversation.
 *
 *  1. The fold is part of the tool block: the terminal block ends with a fade
 *     and "Show full output · N KB", never a box between rows.
 *  2. The viewer shows the tool — its name and command — and the decoded
 *     output as lines, never the stored record's JSON; wrap is on and labelled.
 *  3. Keyboard and pointer both open it; Esc closes it and focus returns.
 */
let seeded = false;

export default async function largeOutput(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  await check.touch(phone);
  const watch = await watchPage(check);
  const activate = activator(check);
  await dismissInstallPrompt(check);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  const path = check.fixture.path;
  if (!seeded) {
    const accepted = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: 'Run fixture large output' }] });
    assert.equal(accepted.accepted, true, 'the host accepted the prompt');
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!(await check.rpc('session/load', { path })).state.isStreaming) break;
      await page.waitForTimeout(500);
    }
    seeded = true;
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();

  // Open the row that ran the command.
  const row = page.locator('[data-slot="tool-call"][data-tool="bash"]').last();
  await row.waitFor({ timeout: 60_000 }).catch(async () => {
    // The aggregate is folded by default: open it first.
    await activate(page.locator('[data-slot="tool-group-trigger"], [data-slot="activity-trigger"]').last());
    await row.waitFor({ timeout: 30_000 });
  });
  await row.scrollIntoViewIfNeeded();
  const trigger = row.locator('[data-slot="tool-fallback-trigger"]');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await activate(trigger);

  const fold = row.locator('[data-slot="terminal-block"] [data-slot="body-overflow"]');
  await fold.waitFor({ timeout: 30_000 });
  const open = fold.locator('[data-slot="body-overflow-open"]');
  const words = scrub(await open.textContent());
  assert.match(words, /^Show full output · \d+ KB$/, `the fold says what it opens: ${words}`);
  assert.equal(await page.locator('[data-slot="body-overflow"]').filter({ hasText: /not kept/ }).count(), 0, 'no "not kept in this window" language anywhere');
  const box = await open.boundingBox();
  if (phone) assert.ok(box.height >= 44, `touch target is at least 44px (${box.height})`);
  await open.scrollIntoViewIfNeeded();
  await check.shot(`large-output-fold${check.state.touch ? '-touch' : ''}`);

  // Keyboard on desktop, the case's pointer on a phone.
  if (phone) await activate(open);
  else { await open.focus(); await page.keyboard.press('Enter'); }
  const dialog = page.locator('[data-slot="output-viewer"]');
  await dialog.waitFor({ timeout: 30_000 });
  assert.equal(scrub(await dialog.getByRole('heading').first().textContent()), 'Full output');
  assert.equal(scrub(await dialog.locator('[data-slot="output-viewer-tool"]').textContent()), 'bash');
  assert.match(scrub(await dialog.locator('[data-slot="output-viewer-command"]').textContent()), /seq 1 1100/);

  const scroller = dialog.locator('[data-slot="output-viewer-scroller"]');
  await scroller.locator('[data-run]').first().waitFor({ timeout: 30_000 });
  const text = await scroller.locator('[data-run]').first().evaluate(node => node.textContent);
  assert.match(text, /ok {2}test 00001 passed in the fixture suite\nok {2}test 00002 passed/, 'real lines of decoded output');
  assert.doesNotMatch(text, /"content"|"type":\s*"text"|\\n/, 'never the stored record as JSON');
  assert.equal(await scroller.getAttribute('data-wrap'), 'true', 'wrap is on by default');
  assert.equal(await dialog.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed'), 'true');
  const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(pageScroll <= 0, `no horizontal page scroll (${pageScroll})`);
  await check.shot(`large-output-viewer${check.state.touch ? '-touch' : ''}`);

  // End reaches the last line.
  await scroller.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-slot="output-viewer-scroller"]');
    return node && /test 01100 passed/.test(node.textContent) && node.scrollHeight - node.scrollTop - node.clientHeight < 4;
  }, undefined, { timeout: 30_000 });
  await check.shot(`large-output-end${check.state.touch ? '-touch' : ''}`);

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  if (!phone) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-slot'));
    assert.equal(focused, 'body-overflow-open', 'focus returned to the fold');
  }
  await watch.assertClean();
}
