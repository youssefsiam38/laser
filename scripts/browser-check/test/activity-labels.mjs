import assert from 'node:assert/strict';

export default async function activityLabels(check) {
  // session/prompt settles after the turn; start it without awaiting so the
  // assertion observes the running row rather than its durable summary.
  const prompt = check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: 'Run labelled fixture tool' }],
  }).catch(error => error);
  await check.waitFor('Checking layout balance');

  const row = check.page.getByRole('button', { name: 'Checking layout balance', exact: true });
  const geometry = await row.evaluate(element => {
    const indicator = element.querySelector('[data-slot="thinking-indicator"]');
    const label = element.querySelector('[data-slot="thinking-indicator-label"]');
    if (!(indicator instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
    const outer = indicator.getBoundingClientRect();
    const inner = label.getBoundingClientRect();
    return {
      indicatorWidth: outer.width,
      labelWidth: inner.width,
      triggerRight: element.getBoundingClientRect().right,
      scrollRight: element.scrollLeft + element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  assert.ok(geometry, 'the running row renders the activity-label indicator');
  assert.ok(geometry.indicatorWidth <= geometry.labelWidth + 2,
    `the indicator hugs its label instead of filling the row (${JSON.stringify(geometry)})`);
  assert.ok(geometry.scrollWidth <= geometry.scrollRight + 1,
    `the row does not overflow horizontally (${JSON.stringify(geometry)})`);

  if (check.state.width === 390) await row.tap();
  else await row.press('Enter');
  const body = row.locator('xpath=..').locator('[data-slot="tool-fallback-content"]');
  await body.waitFor({ state: 'visible' });
  assert.doesNotMatch(await body.textContent(), /activity_label|Checking layout balance/,
    'the injected parameter stays out of the disclosure');
  if (check.state.width === 390) await row.tap();
  else await row.press('Enter');
  await body.waitFor({ state: 'hidden' });

  assert.equal(await check.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    'the page has no horizontal overflow');
  await check.shot('activity-label');
}
