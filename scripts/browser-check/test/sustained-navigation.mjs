import assert from 'node:assert/strict';

// Run with the shared app target, --fixture long --matrix (also --touch).
export default async function sustainedNavigation(check) {
  const { page } = check;
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => {
    await installPrompt.getByRole('button', { name: 'Not now', exact: true }).click();
  });
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
  const readDraft = async () => {
    // Actionability also dismisses the supported phone install reminder.
    await composer.click();
    return composer.inputValue();
  };
  const draft = 'Original draft — exact whitespace\n  second line';
  await composer.fill(draft);

  async function select(name, key) {
    const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
    if (!await sessions.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
    const exactTitle = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const trigger = sessions.locator('[data-slot="aui_thread-list-item-trigger"]').filter({ has: page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: exactTitle }) });
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
  assert.equal(await readDraft(), '');
  await composer.fill('Destination draft');
  await select(originalTitle, 'Enter');
  assert.equal(await readDraft(), draft);
  await select(title, 'Space');
  assert.equal(await readDraft(), 'Destination draft');
  await select(originalTitle);
  assert.equal(await readDraft(), draft);
  // Leave the row first: a rapid second touch is the supported rename gesture.
  if (check.state.touch) await composer.tap(); else await composer.click();
  // Choosing the accepted row still closes the phone sheet without navigation.
  await select(originalTitle);
  assert.equal(await readDraft(), draft);
  const after = await check.rpc('pi/session/entries', { path: originalPath });
  assert.deepEqual(after.entries.filter(entry => entry.type === 'message').map(entry => entry.id), canonicalIds, 'navigation never changes canonical history');
  const destination = await check.rpc('pi/session/entries', { path: state.path });
  assert.equal(destination.entries.filter(entry => entry.type === 'message').length, 2, 'drafts were not sent to the successor');
  // Use the existing real stub-provider child fixture, not injected UI state.
  await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text: 'Start fixture-failed' }] });
  let child;
  const childDeadline = Date.now() + 30000;
  while (!child) {
    const { runs } = await check.rpc('agents/runs/list', { path: state.path });
    child = runs.find(run => run.subagentName === 'fixture-failed' && run.status === 'failed');
    assert.ok(Date.now() < childDeadline, 'fixture child settles');
    if (!child) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const childTitle = `Menu child ${title}`;
  await check.rpc('pi/session/rename', { path: child.sessionPath, name: childTitle });
  const sessions = page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await sessions.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const branch = sessions.getByRole('button', { name: new RegExp(`the agent under ${escapedTitle}\\.`) });
  if (await branch.getAttribute('aria-expanded') === 'false') await branch.click();
  const finished = sessions.getByRole('button', { name: `Show the finished agent under ${title}`, exact: true });
  if (await finished.getAttribute('aria-expanded') === 'false') await finished.click();
  const childRow = sessions.locator('[data-slot="aui_thread-list-item"]').filter({ has: page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: childTitle }) });
  const more = childRow.getByRole('button', { name: 'Actions for fixture-failed', exact: true });
  if (check.state.touch) await more.tap(); else await more.click();
  const open = page.getByRole('menuitem', { name: 'Open', exact: true });
  if (check.state.touch) await open.tap(); else { await open.focus(); await open.press('Enter'); }
  await page.waitForFunction(name => document.querySelector('h1')?.textContent === name, childTitle);
  await page.waitForFunction(() => !document.querySelector('[data-slot="thread-footer"] textarea')?.disabled);
  if (page.viewportSize().width < 1024) await sessions.waitFor({ state: 'hidden' });
  assert.equal(await readDraft(), '');
  if (!await sessions.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  await select(originalTitle);
  assert.equal(await readDraft(), draft, 'child menu preserves outgoing draft');
  await select(title);
  assert.equal(await readDraft(), 'Destination draft');
  await select(originalTitle);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), check.state.touch);
  await check.snapshot();
  await check.shot('sustained-navigation');
  await page.removeLocatorHandler(installPrompt);
}
