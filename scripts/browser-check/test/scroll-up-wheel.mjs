import assert from 'node:assert/strict';

/**
 * Consecutive upward input must never be restored by a layout commit that lands
 * before the browser's native scroll event. This was visible on 0.6.3 in a real
 * variable-height conversation: the first wheel moved 500px, every following
 * wheel was undone, then the viewport jumped back down when input stopped.
 */
export default async function scrollUpWheel(check) {
  const { page, fixture } = check;
  const width = check.state.width;
  const touch = width === 390;
  await check.touch(touch);
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  if (touch) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const name = `${fixture.name} conversation 1`;
  await page.locator('[data-slot=aui_thread-list-item-trigger]').filter({ hasText: name }).first().click();
  await page.getByRole('main').getByRole('heading', { name, exact: true }).waitFor();
  await page.getByText('Checkpoint 120 is complete.', { exact: true }).waitFor();

  const viewport = page.locator('[data-slot=thread-viewport]');
  const box = await viewport.boundingBox();
  assert.ok(box, 'the transcript viewport is on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tops = [await viewport.evaluate(element => element.scrollTop)];
  for (let step = 0; step < 4; step++) {
    if (touch) {
      await viewport.evaluate(element => {
        const at = (clientY) => new Touch({ identifier: 1, target: element, clientX: element.clientWidth / 2, clientY });
        element.dispatchEvent(new TouchEvent('touchstart', { touches: [at(200)], bubbles: true }));
        element.dispatchEvent(new TouchEvent('touchmove', { touches: [at(500)], bubbles: true }));
        element.scrollTop -= 300;
        element.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
      });
    } else await page.mouse.wheel(0, -300);
    await page.waitForTimeout(70);
    tops.push(await viewport.evaluate(element => element.scrollTop));
  }
  for (let index = 1; index < tops.length; index++) {
    assert.ok(tops[index] < tops[index - 1] - 200, `upward input ${index} was undone: ${tops.map(Math.round).join(',')}`);
  }
  await page.waitForTimeout(500);
  const rested = await viewport.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(rested - tops.at(-1)) <= 2, `the viewport jumped after input: ${Math.round(tops.at(-1))} -> ${Math.round(rested)}`);
  await check.shot(`scroll-up-wheel-${width}-${check.state.theme}`);
  return { tops, rested };
}
