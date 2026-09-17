import assert from 'node:assert/strict';

async function sessionsPanel(page) {
  const panel = page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  await panel.waitFor({ state: 'visible' });
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    const handle = await panel.elementHandle();
    await page.waitForFunction(element => element?.getBoundingClientRect().x >= -0.5, handle);
  }
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
  await page.getByRole('heading', { name: 'New chat', exact: true }).waitFor();
  assert.equal(await page.locator('[data-slot="topbar-workspace"]').textContent(), 'Chat');
  const suggestions = page.locator('[data-slot="empty-state-suggestions"]');
  await suggestions.getByText('Think through a decision', { exact: true }).waitFor();
  assert.equal(await suggestions.getByText('Review my uncommitted changes', { exact: true }).count(), 0,
    'Chat never offers a project-only suggestion');
  await suggestions.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  await page.mouse.move(0, 0);
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
  panel = await sessionsPanel(page);
  await panel.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const chatTabBefore = panel.getByRole('tab', { name: 'Chat', exact: true });
  const chatButtonBefore = await chatTabBefore.boundingBox();
  const chatLabelBefore = await chatTabBefore.locator('[data-slot="sessions-tab-label"]').boundingBox();
  const asking = check.rpc('session/prompt', {
    path: chatPath,
    content: [{ type: 'text', text: 'fixture-asking: leave a question while Chat is hidden' }],
  }).catch(() => {});
  panel = await sessionsPanel(page);
  const chatTab = panel.getByRole('tab', { name: /^Chat, (Waiting for you|Finished, unread)$/ });
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
  const dot = chatTab.locator('[data-slot="status-dot"]');
  assert.equal(await dot.count(), 1);
  assert.equal(await dot.getAttribute('aria-hidden'), null, 'the status image stays available to assistive technology');
  const chatButtonAfter = await chatTab.boundingBox();
  const chatLabelAfter = await chatTab.locator('[data-slot="sessions-tab-label"]').boundingBox();
  assert.ok(chatButtonBefore && chatLabelBefore && chatButtonAfter && chatLabelAfter
    && Math.abs((chatLabelBefore.x - chatButtonBefore.x) - (chatLabelAfter.x - chatButtonAfter.x)) < 0.5,
  `the activity dot must not shift the tab label: ${JSON.stringify({ chatButtonBefore, chatLabelBefore, chatButtonAfter, chatLabelAfter })}`);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="tooltip-content"]')].every(node => {
    const style = getComputedStyle(node);
    return style.visibility === 'hidden' || style.display === 'none' || node.getClientRects().length === 0;
  }), undefined, { timeout: 2_000 });
  await check.shot('chat-tab-new-activity');
  await check.rpc('session/cancel', { path: chatPath });
  await asking;
}
