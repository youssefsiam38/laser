import assert from 'node:assert/strict';

// Run with the shared app target, --fixture long --matrix (also --touch).
export default async function sustainedNavigation(check) {
  const { page } = check;
  const originalTitle = await page.locator('h1').textContent();
  const originalPath = check.fixture.path;
  const { entries } = await check.rpc('pi/session/entries', { path: originalPath });
  const canonicalIds = entries.filter(entry => entry.type === 'message').map(entry => entry.id);
  assert.equal(canonicalIds.length, 240);
  const { state } = await check.rpc('session/new', { cwd: check.fixture.project });
  const title = `Navigation ${check.state.width ?? page.viewportSize().width} ${check.state.theme} ${check.state.touch ? 'touch' : 'pointer'}`;
  await check.rpc('pi/session/rename', { path: state.path, name: title });
  await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text: 'Review checkpoint 1: verify the implementation and explain the next step.' }] });
  const deadline = Date.now() + 30000;
  while ((await check.rpc('session/load', { path: state.path })).state.isStreaming) {
    assert.ok(Date.now() < deadline, 'synthetic turn settles');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const draft = 'Original draft — exact whitespace\n  second line';
  await composer.fill(draft);

  async function select(name, key) {
    const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
    if (!await sessions.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
    const trigger = sessions.locator('[data-slot="aui_thread-list-item-trigger"]').filter({ has: page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: name }) });
    await trigger.waitFor({ state: 'visible' });
    assert.equal(await trigger.evaluate(element => element.tagName), 'BUTTON');
    if (key) {
      await trigger.focus();
      assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
      await trigger.press(key);
    } else if (check.state.touch) await trigger.tap();
    else await trigger.click();
    await page.waitForFunction(name => document.querySelector('h1')?.textContent === name, name);
    await composer.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('[data-slot="thread-footer"] textarea')?.disabled);
    if (page.viewportSize().width < 1024) await sessions.waitFor({ state: 'hidden' });
    else assert.equal(await trigger.getAttribute('aria-current'), 'page');
  }

  await select(title);
  assert.equal(await composer.inputValue(), '');
  await composer.fill('Destination draft');
  await select(originalTitle, 'Enter');
  assert.equal(await composer.inputValue(), draft);
  await select(title, 'Space');
  assert.equal(await composer.inputValue(), 'Destination draft');
  await select(originalTitle);
  assert.equal(await composer.inputValue(), draft);
  const after = await check.rpc('pi/session/entries', { path: originalPath });
  assert.deepEqual(after.entries.filter(entry => entry.type === 'message').map(entry => entry.id), canonicalIds, 'navigation never changes canonical history');
  const destination = await check.rpc('pi/session/entries', { path: state.path });
  assert.equal(destination.entries.filter(entry => entry.type === 'message').length, 2, 'drafts were not sent to the successor');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), check.state.touch);
  await check.snapshot();
  await check.shot('sustained-navigation');
}
