import assert from 'node:assert/strict';

export default async function acceptance(check) {
  const { page } = check;
  const cwd = check.fixture.project;
  const activate = async locator => {
    await locator.scrollIntoViewIfNeeded();
    if (check.state.touch) await locator.tap(); else await locator.click();
  };
  // First-use touch guidance is a real overlay, not fixture state to bypass.
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => {
    await activate(installPrompt.getByRole('button', { name: 'Not now', exact: true }));
  });
  async function prompt(path, text) {
    assert.equal((await check.rpc('session/prompt', { path, content: [{ type: 'text', text }] })).accepted, true);
    const deadline = Date.now() + 60000;
    while ((await check.rpc('session/load', { path })).state.isStreaming) {
      assert.ok(Date.now() < deadline, 'conversation settles');
      await page.waitForTimeout(100);
    }
  }
  async function conversation(name) {
    const { state } = await check.rpc('session/new', { cwd });
    await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
    await check.rpc('pi/session/rename', { path: state.path, name });
    await prompt(state.path, 'Start without discovery');
    return state.path;
  }
  const config = (await check.rpc('mcp/list', { cwd })).servers.find(server => server.config.name === 'fixture').config;
  const tools = { ...config.tools, exposure: 'direct' }; delete tools.alwaysLoad;
  await check.rpc('mcp/save', { cwd, scope: 'global', server: { ...config, tools } });
  const progressive = await conversation(`Progressive ${check.state.width} ${check.state.theme}`);
  const before = (await check.rpc('mcp/list', { cwd })).conversations.find(item => item.sessionPath === progressive).context;
  assert.deepEqual(before.preloaded, [], 'legacy direct does not opt into preload');
  assert.deepEqual(before.discoveries, []);

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!(await settings.isVisible())) await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
  await activate(settings);
  // The narrow tab strip restores its scroll while Settings mounts. Use its
  // supported keyboard activation; changed feature controls still use tap.
  const serverTab = page.getByRole('button', { name: 'MCP servers', exact: true });
  await serverTab.focus();
  await serverTab.press('Enter');
  await activate(page.locator('[data-server="global:fixture"] button').first());
  const inspector = page.locator('[data-slot="mcp-inspector"]');
  await activate(inspector.getByRole('tab', { name: 'Tools', exact: true }));
  const section = inspector.getByRole('region', { name: 'Conversation tools' });
  await section.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption(progressive);
  await section.getByText('No tools discovered from this server in this conversation yet.').waitFor();
  assert.match(await section.innerText(), /Discovery budget: 20,000 tokens/);
  await prompt(progressive, 'Discover fixture tools');
  await section.getByText('fixture_echo · Details opened', { exact: true }).waitFor();
  assert.equal(await section.getByRole('list', { name: 'Included tools' }).count(), 0);
  await check.shot('mcp-discovery');

  await activate(inspector.getByRole('tab', { name: 'Overview', exact: true }));
  await activate(inspector.getByRole('button', { name: 'Edit', exact: true }));
  const edit = page.getByRole('dialog', { name: 'Edit fixture', exact: true });
  await activate(edit.getByRole('button', { name: 'Advanced', exact: true }));
  const preload = edit.getByRole('switch', { name: 'Put every tool in the conversation', exact: true });
  assert.equal(await preload.getAttribute('aria-checked'), 'false');
  await preload.focus(); await preload.press('Space');
  assert.equal(await preload.getAttribute('aria-checked'), 'true');
  await preload.press('Space');
  assert.equal(await preload.getAttribute('aria-checked'), 'false');
  await activate(preload);
  assert.equal(await preload.getAttribute('aria-checked'), 'true');
  await edit.getByText(/This can exceed the usual 2% discovery target/).waitFor();
  await check.shot('mcp-preload-override');
  await activate(edit.getByRole('button', { name: 'Save changes', exact: true }));
  await edit.waitFor({ state: 'hidden' });
  const next = await conversation(`Preloaded ${check.state.width} ${check.state.theme}`);
  const snapshots = (await check.rpc('mcp/list', { cwd })).conversations;
  assert.deepEqual(snapshots.find(item => item.sessionPath === progressive).context.preloaded, []);
  assert.ok(snapshots.find(item => item.sessionPath === next).context.preloaded.includes('fixture_echo'));
  await activate(inspector.getByRole('tab', { name: 'Tools', exact: true }));
  await section.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption(next);
  await section.getByRole('list', { name: 'Included tools' }).getByText('fixture_echo', { exact: true }).waitFor();
  await section.getByText('No tools discovered from this server in this conversation yet.').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow');
  assert.equal(await section.evaluate(element => [...element.querySelectorAll('p,dt,dd,li')].some(node => Number.parseFloat(getComputedStyle(node).fontSize) < 12)), false, 'legibility floor');
  await check.snapshot(); await check.shot('mcp-conversation-tools');
  await page.keyboard.press('Escape');
  await page.removeLocatorHandler(installPrompt);
}
