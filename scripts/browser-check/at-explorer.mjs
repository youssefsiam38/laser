import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** M16-T28: real host listing, real composer, no mocked browser RPC. */
export default async function checkExplorer(check) {
  const project = check.fixture.project;
  for (const name of ['server', 'node-one', 'node-two', 'many', '.hidden-folder']) mkdirSync(join(project, name), { recursive: true });
  writeFileSync(join(project, 'server', 'index.ts'), 'export const ready = true;\n');
  writeFileSync(join(project, '.hidden-file'), 'visible hidden entry\n');
  for (let i = 0; i < 190; i++) writeFileSync(join(project, 'many', `entry-${String(i).padStart(3, '0')}.ts`), '');
  const page = check.page;
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const popup = page.getByRole('listbox', { name: 'Files & agents', exact: true });
  const option = name => popup.getByRole('option', { name, exact: true });
  const fill = async value => { await input.fill(value); await input.press('End'); };
  const choose = async row => { if (check.state.touch) await row.tap(); else await row.click(); };
  for (const [text, names] of [
    ['@/', ['server', 'node-one', '.hidden-file']],
    ['@node', ['node-one', 'node-two']],
    ['@./node', ['node-one', 'node-two']],
    ['@server/', ['server/index.ts']],
    ['@server/ind', ['server/index.ts']],
  ]) {
    await fill(text);
    for (const name of names) await option(name).waitFor();
    if (text === '@/') await check.shot('explorer-root');
    if (text.includes('node')) assert.equal(await popup.getByRole('option').count(), 2);
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
  }
  await fill('@node'); await option('node-one').waitFor(); await input.press('Tab');
  assert.equal(await input.inputValue(), '@node-');
  await fill('@ser'); await option('server').waitFor(); await input.press('/');
  await option('server/index.ts').waitFor(); assert.equal(await input.inputValue(), '@server/');
  await input.press('Backspace'); assert.equal(await input.inputValue(), '@');
  await fill('@ser'); await option('server').waitFor(); await choose(option('server'));
  await option('server/index.ts').waitFor(); assert.equal(await input.inputValue(), '@server/');
  await choose(option('server/index.ts')); assert.equal(await input.inputValue(), ':file[server/index.ts] ');
  await fill('@many/'); await option('More entries…').waitFor();
  assert.equal(await popup.getByRole('option').count(), 81);
  await check.shot('explorer-many');
  // Keyboard reaches the continuation without moving the caret or sending.
  await input.press('ArrowUp'); await input.press('Enter');
  await option('many/entry-080.ts').waitFor(); await option('Previous entries').waitFor();
  assert.equal(await input.inputValue(), '@many/');
  await choose(option('More entries…')); await option('many/entry-160.ts').waitFor();
  assert.equal(await popup.getByRole('option').count(), 31);
  await choose(option('Previous entries')); await option('many/entry-080.ts').waitFor();
  await input.press('Escape'); assert.equal(await input.inputValue(), '@many/');
  assert.equal(await popup.count(), 0);
  const retryName = `retry-${check.state.width}-${check.state.theme}-${check.state.touch}`;
  await fill(`@${retryName}/`);
  await popup.getByText('This folder no longer exists. Check the path.').waitFor();
  mkdirSync(join(project, retryName)); writeFileSync(join(project, retryName, 'ready.ts'), '');
  await choose(popup.getByRole('button', { name: 'Try again', exact: true }));
  await option(`${retryName}/ready.ts`).waitFor();
  await fill('@../'); await popup.getByText('Choose a path inside this project.').waitFor();
  await check.shot('explorer-refusal');
  await check.reducedMotion(true);
  await fill('@server/ind'); await option('server/index.ts').waitFor();
  await check.shot('explorer-file');
  const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.body <= geometry.width && geometry.document <= geometry.width, JSON.stringify(geometry));
  await input.press('Enter'); assert.equal(await input.inputValue(), ':file[server/index.ts] ');
  await fill(''); await check.reducedMotion(false);
}
