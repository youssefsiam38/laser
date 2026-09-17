import assert from 'node:assert/strict';

async function sessionsPanel(page) {
  const panel = page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  await panel.waitFor({ state: 'visible' });
  return panel;
}

export default async function chatLanding(check) {
  const { page } = check;
  const message = `Start this Chat immediately (${check.state.width} ${check.state.theme}).`;
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => {
    await installPrompt.getByRole('button', { name: 'Not now', exact: true }).click();
  });

  let panel = await sessionsPanel(page);
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.isDisabled(), false, 'the Chat landing composer is live');
  assert.doesNotMatch(await composer.getAttribute('placeholder') ?? '', /preparing/i);
  await check.shot('chat-landing');

  await composer.fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  let chatPath;
  const deadline = Date.now() + 30_000;
  while (!chatPath) {
    const { sessions } = await check.rpc('pi/session/list', {});
    for (const session of sessions.filter(item => item.agent?.kind === 'chat')) {
      const { entries } = await check.rpc('pi/session/entries', { path: session.path });
      const prompts = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user'
        && entry.message?.content?.some?.(part => part.type === 'text' && part.text === message));
      if (prompts.length === 1) chatPath = session.path;
    }
    assert.ok(Date.now() < deadline, 'first Chat send creates one session and persists one prompt');
    if (!chatPath) await new Promise(resolve => setTimeout(resolve, 50));
  }

  panel = await sessionsPanel(page);
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  if (check.state.width <= 600) await panel.waitFor({ state: 'hidden' });
  const asking = check.rpc('session/prompt', {
    path: chatPath,
    content: [{ type: 'text', text: 'fixture-asking: leave a question while Chat is hidden' }],
  }).catch(() => {});
  panel = await sessionsPanel(page);
  const chatTab = panel.getByRole('tab', { name: 'Chat, new activity', exact: true });
  const attentionDeadline = Date.now() + 30_000;
  while (!await chatTab.isVisible()) {
    if (Date.now() >= attentionDeadline) {
      const { sessions } = await check.rpc('pi/session/list', {});
      const labels = await panel.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label') ?? tab.textContent));
      const current = sessions.find((session) => session.path === chatPath);
      throw new Error(`hidden Chat activity never appeared: ${JSON.stringify({ chatPath, current, labels })}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await chatTab.locator('[data-slot="status-dot"]').count(), 1);
  await check.shot('chat-tab-new-activity');
  await check.rpc('session/cancel', { path: chatPath });
  await asking;
}
