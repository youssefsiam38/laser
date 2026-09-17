import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { storageKey } from '../../packages/protocol/dist/index.js';

/** M16-T63: host-resolved path spellings and selectable folder mentions. */
export default async function checkExplorer(check) {
  const { page } = check;
  const project = check.fixture.project;
  const home = join(check.root, 'home');
  const sibling = join(dirname(project), 'explorer-sibling');
  const projectFolder = join(project, 'server');
  const homeFolder = join(home, 'home-folder');
  mkdirSync(projectFolder, { recursive: true });
  mkdirSync(homeFolder, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(projectFolder, 'index.ts'), 'export const ready = true;\n');
  writeFileSync(join(homeFolder, 'notes.md'), '# Home fixture\n');
  writeFileSync(join(sibling, 'guide.md'), '# Parent fixture\n');

  const origin = new URL(page.url()).origin;
  const installKey = storageKey('mobile-install-dismissed');
  await page.addInitScript(({ origin, key }) => {
    if (location.origin === origin) localStorage.setItem(key, 'forever');
  }, { origin, key: installKey });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const popup = page.getByRole('listbox', { name: 'Files & agents', exact: true });
  const option = name => popup.getByRole('option', { name, exact: true });
  const fill = async value => { await input.fill(value); await input.press('End'); };
  const choose = async row => { if (check.state.touch) await row.tap(); else await row.click(); };
  await input.waitFor();

  // Home expansion happens in the host. The canonical host path is the folder
  // identity, and the open picker is the required visual acceptance state.
  await fill('@~/');
  const homeLabel = `${home}/home-folder/`;
  await option(homeLabel).waitFor();
  await check.shot('explorer-folder');
  await input.press('Enter');
  assert.equal(await input.inputValue(), `:directory[${homeLabel}] `);

  // Pointer selection is selection too; only a typed slash drills down.
  await fill('@ser');
  await option('server/').waitFor();
  await choose(option('server/'));
  assert.equal(await input.inputValue(), `:directory[server/]{name=${projectFolder}/} `);
  await fill('@server/');
  await option('server/index.ts').waitFor();
  await input.press('Backspace');
  assert.equal(await input.inputValue(), '@');

  // Parent and Windows-style separators stay query spellings until the host
  // resolves them; the rows and inserted identities are canonical `/` paths.
  await fill('@../');
  const siblingLabel = `${sibling}/`;
  await option(siblingLabel).waitFor();
  await fill('@..\\explorer-s');
  await option(siblingLabel).waitFor();
  await input.press('Enter');
  assert.equal(await input.inputValue(), `:directory[${siblingLabel}] `);

  await fill('@%USERPROFILE%\\');
  await option(homeLabel).waitFor();
  await fill('@/');
  await popup.getByText('That path is outside this project and your home folder.', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Try again', exact: true }).count(), 0);

  await fill('@server/ind');
  await option('server/index.ts').waitFor();
  await input.press('Enter');
  assert.equal(await input.inputValue(), `:file[server/index.ts]{name=${projectFolder}/index.ts} `);
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.body <= geometry.width && geometry.document <= geometry.width, JSON.stringify(geometry));
}
