import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as seedFixture } from '../targets/fixtures.mjs';
import { until } from '../lifecycle.mjs';

export default async function contentAcceptance(check) {
  const { page } = check;
  const width = check.state.width;
  await check.touch(width === 390);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  const title = `Window content ${width} ${check.state.theme}`;
  check.fixture = await seedFixture({ rpc: check.rpc }, { root: join(check.root, title.replaceAll(' ', '-')), node: process.execPath, until }, 'tools');
  const path = check.fixture.path;
  await check.rpc('pi/session/rename', { path, name: title });
  if (width === 390) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: title }).first().click();
  await page.getByRole('main').getByRole('heading', { name: title, exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const settle = () => until(async () => !(await check.rpc('session/load', { path })).state.isStreaming, 'content fixture to settle', 120000);
  await composer.click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await (await chooser).setFiles([
    { name: 'fixture-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Retained attachment body across window eviction.') },
    { name: 'fixture-pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') },
  ]);
  await page.getByText('fixture-note.txt', { exact: true }).first().waitFor();
  await composer.fill('> Canonical quoted text survives eviction.\n\nImage checkpoint with a retained document.');
  await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('[data-role=user]').filter({ hasText: 'Image checkpoint with a retained document.' }).waitFor();
  await settle();
  for (let turn = 3; turn <= 120; turn++) {
    const result = await check.rpc('session/prompt', { path, content: [{ type: 'text', text: `Review checkpoint ${turn}: verify the implementation and explain the next step.` }] });
    assert.equal(result.accepted, true);
    await settle();
  }
  await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
  const find = async text => {
    await composer.click(); await composer.press('ControlOrMeta+f');
    const input = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    await input.fill(text);
    const all = page.getByRole('button', { name: 'Load all messages', exact: true });
    if (await all.count()) { await all.click(); await all.waitFor({ state: 'detached' }); }
    const row = page.locator('[data-role=user]').filter({ hasText: text }).first();
    await row.waitFor({ state: 'visible' });
    await input.press('Escape');
    return row;
  };
  const imageRow = await find('Image checkpoint with a retained document.');
  await imageRow.getByText('Canonical quoted text survives eviction.', { exact: true }).waitFor();
  const image = imageRow.locator('[data-slot=message-image]');
  await image.waitFor();
  assert.equal(await image.evaluate(img => img.complete && img.naturalWidth > 0), true);
  await imageRow.getByRole('button', { name: 'Open Image 1', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await imageRow.getByRole('button', { name: /fixture-note.txt/ }).click();
  const preview = page.getByRole('dialog');
  await preview.getByText('Retained attachment body across window eviction.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });

  await find('Show fixture reasoning');
  const reasoning = page.locator('[data-slot=activity-reasoning]');
  const toggle = reasoning.locator('[data-slot=tool-group-trigger]');
  const body = reasoning.getByText('First inspect the boundary, then verify the result with a focused check.', { exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  await body.waitFor({ state: 'hidden' });
  await toggle.focus(); await toggle.press('Enter');
  await body.waitFor({ state: 'visible' });
  await toggle.press('Enter');
  await body.waitFor({ state: 'hidden' });
  await toggle.click();
  await body.waitFor({ state: 'visible' });
  await find('Review checkpoint 120:');
  await reasoning.waitFor({ state: 'detached' });
  await find('Show fixture reasoning');
  await body.waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'manual disclosure survives eviction');

  await find('Run fixture tools');
  const toolToggle = page.getByRole('button', { name: /^Run printf 'fixture tool output/ }).first();
  await toolToggle.waitFor();
  if (await toolToggle.getAttribute('aria-expanded') === 'true') await toolToggle.click();
  await toolToggle.focus(); await toolToggle.press('Enter');
  const output = page.getByText('fixture tool output', { exact: true }).first();
  await output.waitFor({ state: 'visible' });
  await toolToggle.press('Enter');
  await output.waitFor({ state: 'hidden' });

  const anchor = await find('Review checkpoint 60:');
  const top = () => anchor.evaluate(row => row.getBoundingClientRect().top);
  const before = await top();
  await check.viewport(width === 390 ? 430 : 1200);
  await check.viewport(width);
  await until(async () => Math.abs(await top() - before) <= 2, 'anchor after width restoration', 10000);
  const after = await top();
  const slider = page.getByRole('slider', { name: /^Conversation map:/ });
  let turns = 0;
  if (await slider.isVisible()) {
    turns = Number(await slider.getAttribute('aria-valuemax'));
    assert(turns >= 120);
    await slider.focus(); await slider.press('Home');
    for (let i = 1; i <= turns; i++) {
      assert.equal(Number(await slider.getAttribute('aria-valuenow')), i, 'every canonical turn is keyboard addressable');
      if (i < turns) await slider.press('ArrowDown');
    }
    await slider.press('Home'); await slider.press('Enter');
    await page.locator('[data-role=user]').filter({ hasText: 'Review checkpoint 1:' }).waitFor({ state: 'visible' });
    const box = await slider.boundingBox();
    const middle = Math.floor(turns / 2);
    await slider.click({ position: { x: box.width / 2, y: (middle + 0.5) / turns * box.height } });
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), middle + 1);
    const label = (await slider.getAttribute('aria-valuetext')).replace(/^Turn \d+ of \d+: /, '');
    await page.locator('[data-role=user]').filter({ hasText: label }).first().waitFor({ state: 'visible' });
    await slider.press('End'); await slider.press('Enter');
    await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();
  }
  assert(await page.locator('[data-slot=conversation-map-tick]').count() <= 225);
  assert(await page.locator('[data-window-message]').count() < 80, 'ordinary window remains bounded after content actions');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  writeFileSync(join(check.root, `content-${width}-${check.state.theme}.json`), JSON.stringify({ turns, anchor: { before, after, error: Math.abs(after - before) }, attachments: true, quote: true, reasoning: true, tools: true }, null, 2));
  await check.snapshot(); await check.shot('content');
}
