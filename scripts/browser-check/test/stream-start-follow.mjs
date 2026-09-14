import assert from 'node:assert/strict';

export default async function streamStartFollow(check) {
  const { page, fixture } = check;
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const name = `${fixture.name} conversation 1`;
  const row = page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first();
  if (!(await row.isVisible())) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await row.click();
  await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();

  const viewport = page.locator('[data-slot=thread-viewport]');
  await viewport.waitFor();
  const gap = () => viewport.evaluate(element => Math.round(element.scrollHeight - element.clientHeight - element.scrollTop));
  await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(100);
  await viewport.hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(150);
  assert.ok(await gap() >= 500, 'the send starts from earlier history');

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('fixture-stream: follow the new answer from history');
  await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 20000 });
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    await page.waitForTimeout(100);
    let value = await gap();
    for (let frame = 0; value > 4 && frame < 10; frame += 1) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      value = await gap();
    }
    samples.push(value);
  }
  assert.ok(samples.every(value => value <= 4), `new stream stayed above latest: ${samples.join(',')}`);

  // Following is an intent, not a lock: wheel input during a later stream wins.
  await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 20000 });
  await composer.fill('fixture-stream: let the reader leave this answer');
  await page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 20000 });
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  assert.ok(await gap() >= 400, 'wheel input keeps the reader in history while the answer continues');
}
