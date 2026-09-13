import assert from 'node:assert/strict';

export default async function acceptance(check) {
  const { page } = check;
  const activate = async locator => {
    await locator.scrollIntoViewIfNeeded();
    if (check.state.touch) await locator.tap(); else await locator.click();
  };
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => {
    await activate(installPrompt.getByRole('button', { name: 'Not now', exact: true }));
  });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!(await settings.isVisible())) await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
  await activate(settings);
  const servers = page.getByRole('button', { name: 'MCP servers', exact: true });
  await servers.focus(); await servers.press('Enter');
  await activate(page.locator('[data-server="global:fixture"] button').first());
  const inspector = page.locator('[data-slot="mcp-inspector"]');
  const tools = inspector.getByRole('tab', { name: 'Tools', exact: true });
  await activate(tools);
  const freshness = inspector.locator('[data-slot="mcp-tool-freshness"]');
  const historical = freshness.getByText('Showing previously listed tools. Reconnect on Overview to check again.', { exact: true });
  await historical.waitFor();
  await freshness.getByText('Lists without a cache lifetime refresh for each use. A connection does not make an old list current.', { exact: true }).waitFor();
  assert.equal(await freshness.getByText('Tool information is current.', { exact: true }).count(), 0);
  const overview = inspector.getByRole('tab', { name: 'Overview', exact: true });
  await overview.focus(); await overview.press('Enter');
  const reconnect = inspector.getByRole('button', { name: 'Reconnect', exact: true });
  await reconnect.focus(); await reconnect.press('Enter');
  // Ping is disabled until reconnect settles; Playwright's normal actionability
  // wait exercises that lifecycle without a forced click or fixed sleep.
  await activate(inspector.getByRole('button', { name: 'Ping', exact: true }));
  await activate(tools);
  await historical.waitFor();
  await freshness.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow');
  assert.equal(await inspector.evaluate(element => [...element.querySelectorAll('p,dt,dd,li')].some(node => Number.parseFloat(getComputedStyle(node).fontSize) < 12)), false, 'legibility floor');
  await check.snapshot(); await check.shot('mcp-freshness');
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'hidden' });
  await page.removeLocatorHandler(installPrompt);
}
