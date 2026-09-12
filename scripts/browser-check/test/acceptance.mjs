import assert from 'node:assert/strict';

export default async function acceptance(check) {
  const { entries } = await check.rpc('pi/session/entries', { path: check.fixture.path });
  assert.equal(entries.filter(entry => entry.type === 'message').length, 240);
  await check.waitFor('Checkpoint 120 is complete.');
  const composer = check.page.getByRole('textbox', { name: 'Message', exact: true });
  if (check.state.touch) await composer.tap(); else await composer.click();
  await composer.fill('Keyboard and pointer fixture check');
  await composer.press('ControlOrMeta+A');
  await composer.press('Backspace');
  assert.equal(await composer.inputValue(), '');
  assert.equal(await check.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow');
  assert.equal(await check.page.evaluate(() => navigator.maxTouchPoints > 0), check.state.touch, 'touch capability matches requested state');
  await check.snapshot();
  await check.shot('long');
}
