import assert from 'node:assert/strict';

const TOTAL = 9;

async function settle(check, path) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { state } = await check.rpc('session/load', { path });
    if (!state.isStreaming) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for paging fixture session ${path}.`);
}

async function seed(check) {
  const cwd = check.fixture.project;
  const { sessions } = await check.rpc('pi/session/list', { cwd });
  for (let index = sessions.length; index < TOTAL; index += 1) {
    const { state } = await check.rpc('session/new', { cwd });
    await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
    const prompted = await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text: `Paging fixture ${index + 1}` }] });
    assert.equal(prompted.accepted, true, 'the paging fixture prompt is accepted');
    await settle(check, state.path);
    await check.rpc('pi/session/rename', { path: state.path, name: `Paging conversation ${index + 1}` });
  }
}

async function sessionsRegion(check) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await region.isVisible().catch(() => false)) {
    const toggle = check.page.getByRole('button', { name: /^Sessions$|Show sessions/ }).first();
    if (check.state.touch) await toggle.tap(); else await toggle.click();
  }
  await region.waitFor({ state: 'visible' });
  return region;
}

export default async function sessionListPaging(check) {
  await seed(check);
  const region = await sessionsRegion(check);
  const group = region.getByRole('tabpanel').locator(`section[data-cwd=${JSON.stringify(check.fixture.project)}]`);
  const rows = group.locator('[data-slot="aui_thread-list-item-trigger"]');
  const control = group.getByRole('button', { name: /^Load \d+ more$/ });
  await control.waitFor();
  const label = (await control.innerText()).trim();
  const promised = Number(/^Load (\d+) more$/.exec(label)?.[1]);
  assert.ok(Number.isSafeInteger(promised) && promised > 0, `the control names a positive count, got ${JSON.stringify(label)}`);
  const before = await rows.count();
  if (check.state.touch) await control.tap(); else await control.click();
  await check.page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length === count,
    { selector: `section[data-cwd=${JSON.stringify(check.fixture.project)}] [data-slot="aui_thread-list-item-trigger"]`, count: before + promised },
  );
  assert.equal(await rows.count(), before + promised, 'one click reveals exactly the number of chats the label promised');
  await check.snapshot();
  await check.shot('session-list-load-more');
}
