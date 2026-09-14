import assert from 'node:assert/strict';

export default async function projectsSettings(check) {
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
  await activate(page.getByRole('button', { name: 'Projects', exact: true }));

  assert.equal(await page.getByRole('button', { name: 'Environment', exact: true }).count(), 0);
  const trigger = page.getByRole('button', { name: /(?:Expand|Collapse) .+ project settings/ }).first();
  await trigger.waitFor();

  // Every project is a real disclosure with both keyboard and pointer paths.
  await trigger.focus();
  await trigger.press('Enter');
  await trigger.press('Enter');
  if ((await trigger.getAttribute('aria-label'))?.startsWith('Expand')) await activate(trigger);

  const input = page.getByRole('textbox', { name: 'Command to run before Bash', exact: true }).first();
  await input.waitFor();
  await input.fill('source scripts/project-shell.sh');
  await activate(page.getByRole('button', { name: 'Save command', exact: true }).first());
  await page.getByText(/Saved\. The next Bash command uses it/).waitFor();
  await input.fill('');
  await activate(page.getByRole('button', { name: 'Remove command', exact: true }).first());
  await page.getByText(/Removed\. The next Bash command runs normally/).waitFor();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Projects settings overflow horizontally by ${overflow}px`);
  await check.shot('projects-settings');
}
