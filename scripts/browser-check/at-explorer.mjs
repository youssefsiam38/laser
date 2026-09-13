import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let installPromptDismissed = false;

/** M16-T28: real machine listing and viewer. Only synthetic fixture files are read.
 * The shared harness supplies a private HOME, project parent and agent state.
 */
export default async function checkExplorer(check) {
  const project = check.fixture.project;
  const sibling = join(dirname(project), 'explorer-sibling');
  mkdirSync(sibling, { recursive: true });
  const guide = join(sibling, 'guide.md');
  writeFileSync(guide, '# Explorer sibling fixture\n\nHarmless sibling content.\n');
  if (!existsSync(join(project, 'outside-link'))) symlinkSync(sibling, join(project, 'outside-link'));
  if (!existsSync(join(project, 'outside-guide.md'))) symlinkSync(guide, join(project, 'outside-guide.md'));
  for (const name of ['server', 'node-one', 'node-two', 'node_modules', 'dist', 'many', '.hidden-folder']) mkdirSync(join(project, name), { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(join(project, '.gitignore'), 'node_modules/\ndist/\n.hidden-folder/\n');
  writeFileSync(join(project, 'node_modules', 'index.js'), '// synthetic dependency\n');
  writeFileSync(join(project, 'server', 'index.ts'), 'export const ready = true;\n');
  writeFileSync(join(project, '.hidden-file'), 'visible hidden entry\n');
  for (let i = 0; i < 190; i++) writeFileSync(join(project, 'many', `entry-${String(i).padStart(3, '0')}.ts`), '');
  const page = check.page;
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const popup = page.getByRole('listbox', { name: 'Files & agents', exact: true });
  const option = name => popup.getByRole('option', { name, exact: true });
  const fill = async value => { await input.fill(value); await input.press('End'); };
  const choose = async row => { if (check.state.touch) await row.tap(); else await row.click(); };
  // Pointer capability is cached at app boot. The harness establishes touch
  // after initial navigation, so reload once with that capability already set.
  // Then dismiss the real delayed first-use prompt through its supported UI.
  if (!installPromptDismissed && check.state.touch) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await input.waitFor();
    const install = page.getByRole('dialog', { name: /works best installed/ });
    await install.waitFor();
    await choose(install.getByRole('button', { name: 'Not now', exact: true }));
    await install.waitFor({ state: 'hidden' });
    installPromptDismissed = true;
  }
  for (const [text, names] of [
    ['@/', ['/tmp']],
    ['@node', ['node-one', 'node-two', 'node_modules']],
    ['@./node', ['node-one', 'node-two', 'node_modules']],
    ['@server/', ['server/index.ts']],
    ['@server/ind', ['server/index.ts']],
    ['@./', ['dist', '.git', '.hidden-folder', '.hidden-file']],
    ['@../', [sibling]],
    ['@../explorer-sibling/', [guide]],
    [`@${sibling}/gui`, [guide]],
    ['@outside-link/', ['outside-link/guide.md']],
  ]) {
    await fill(text);
    for (const name of names) await option(name).waitFor();
    if (text === '@/') await check.shot('explorer-filesystem-root');
    if (text === '@./') await check.shot('explorer-current-directory');
    if (text.includes('node')) assert.equal(await popup.getByRole('option').count(), 3);
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
  }
  await fill('@no'); await option('node-one').waitFor(); await input.press('Tab');
  assert.equal(await input.inputValue(), '@node');
  await choose(option('node_modules')); await option('node_modules/index.js').waitFor();
  assert.equal(await input.inputValue(), '@node_modules/');
  await fill('@ser'); await option('server').waitFor(); await input.press('/');
  await option('server/index.ts').waitFor(); assert.equal(await input.inputValue(), '@server/');
  await input.press('Backspace'); assert.equal(await input.inputValue(), '@');
  await fill('@ser'); await option('server').waitFor(); await choose(option('server'));
  await option('server/index.ts').waitFor(); assert.equal(await input.inputValue(), '@server/');
  await choose(option('server/index.ts')); assert.equal(await input.inputValue(), ':file[server/index.ts] ');
  await fill('@many/'); await option('More entries…').waitFor();
  assert.equal(await popup.getByRole('option').count(), 81);
  await check.shot('explorer-many');
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
  await check.reducedMotion(true);
  for (const [query, label, identity, readPath] of [
    [`@${sibling}/gui`, guide, guide, guide],
    ['@outside-guide', 'outside-guide.md', 'outside-guide.md', join(project, 'outside-guide.md')],
  ]) {
    await fill(query); await option(label).waitFor(); await choose(option(label));
    assert.equal(await input.inputValue(), `:file[${identity}] `);
    await choose(page.getByRole('button', { name: 'Send', exact: true }));
    const chip = page.locator(`[data-slot="file-chip"][data-file-path="${readPath}"]`).last();
    await chip.waitFor(); await choose(chip);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Explorer sibling fixture', exact: true }).waitFor();
    assert.ok((await dialog.textContent()).includes(guide));
    await check.shot(identity === guide ? 'explorer-outside-viewer' : 'explorer-symlink-viewer');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  }
  await fill('@server/ind'); await option('server/index.ts').waitFor();
  const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.body <= geometry.width && geometry.document <= geometry.width, JSON.stringify(geometry));
  await input.press('Enter'); assert.equal(await input.inputValue(), ':file[server/index.ts] ');
  await fill(''); await check.reducedMotion(false);
}
