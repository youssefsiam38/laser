import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIMIT = 2.01;

export default async function autoFollowBatched(check) {
  const { page, fixture } = check;
  const viewport = page.locator('[data-slot="thread-viewport"]');
  await viewport.waitFor();
  const tag = `${check.state.width}-${check.state.theme}-${check.state.reducedMotion ? 'reduced' : 'motion'}`;
  const geometry = label => viewport.evaluate((element, label) => ({ label, at: performance.now(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, gap: element.scrollHeight - element.clientHeight - element.scrollTop }), label);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const pin = async () => { await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; }); for (let index = 0; index < 4; index += 1) await frame(); };
  const sample = async (label, duration = 1_900) => {
    const values = [], end = Date.now() + duration;
    while (Date.now() < end) { await frame(); values.push(await geometry(label)); await sleep(3); }
    return values;
  };
  const run = async (label, gesture) => {
    await pin();
    if (gesture) { await gesture(); await sleep(80); }
    const request = check.rpc('session/prompt', { path: fixture.path, content: [{ type: 'text', text: 'Stream 500 deltas every 0 ms' }] });
    const values = await sample(label);
    assert.equal((await request).accepted, true);
    for (let index = 0; index < 4; index += 1) await frame();
    values.push(await geometry(`${label}-settled`));
    return values;
  };

  const normal = await run('batch-normal');
  const afterWheel = await run('batch-no-op-wheel', async () => { await viewport.hover(); await page.mouse.wheel(0, 500); });
  const away = await run('batch-away', async () => { await viewport.hover(); await page.mouse.wheel(0, -800); });
  assert.ok(normal.every(value => Math.abs(value.gap) <= LIMIT), `normal 500-delta batch painted ${Math.max(...normal.map(value => value.gap))}px behind`);
  assert.ok(afterWheel.every(value => Math.abs(value.gap) <= LIMIT), `post-wheel 500-delta batch painted ${Math.max(...afterWheel.map(value => value.gap))}px behind`);
  const awayStart = away[0].scrollTop;
  assert.ok(away.some(value => value.gap >= 500), 'the negative control never left the edge');
  assert.ok(away.every(value => Math.abs(value.scrollTop - awayStart) <= LIMIT), `the 500-delta batch moved the reader from ${awayStart}`);

  const result = {
    tag,
    normalMaxGap: Math.max(...normal.map(value => value.gap)),
    noOpWheelMaxGap: Math.max(...afterWheel.map(value => value.gap)),
    awayStart,
    awayEnd: away.at(-1),
  };
  writeFileSync(join(check.root, `auto-follow-batched-${tag}.json`), JSON.stringify(result, null, 2));
  console.log(`AUTO_FOLLOW_BATCHED ${JSON.stringify(result)}`);
}
