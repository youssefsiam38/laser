/**
 * Independent Settings journeys through real controls and isolated local services.
 * Build the workspace and regenerate its runtime inventory before running:
 * node scripts/browser-check/run.mjs --target scripts/browser-check/test/settings-user-acceptance.mjs --script scripts/browser-check/test/settings-user-acceptance.mjs --fixture empty --matrix
 * Add --touch or --reduced-motion for those input/motion lanes.
 * Save failures are simulated at the transport boundary; successful writes and
 * persisted after-states use the real host. No native external-route save/switch
 * or physical mobile-browser coverage is claimed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const CANDIDATE = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const APP = `${SOURCE}/scripts/browser-check/targets/app.mjs`;
const FIXTURE_SERVER = `${SOURCE}/packages/worker/test/mcp/fixtures/stdio-server.mjs`;
const OAUTH_SERVER = `${SOURCE}/packages/worker/test/mcp/fixtures/oauth-server.ts`;
export const checkout = SOURCE;

const app = await import(pathToFileURL(APP).href);

export async function target(runtime) {
  const base = await app.target(runtime);
  const port = await runtime.freePort();
  runtime.spawn(runtime.node, [new URL(import.meta.url).pathname, '--oauth-child', String(port)], {
    name: 'oauth-fixture', env: runtime.env,
  });
  await runtime.until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }, 'offline OAuth fixture', runtime.timeout);
  return { ...base, oauthUrl: `http://127.0.0.1:${port}/mcp`, nodePath: runtime.node };
}

export async function fixture(targetState, runtime, name) {
  const seeded = await app.fixture(targetState, runtime, name);
  const importDir = join(runtime.env.HOME, '.config', 'mcp');
  mkdirSync(importDir, { recursive: true });
  writeFileSync(join(importDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    'synthetic-import': {
      command: runtime.node,
      args: [FIXTURE_SERVER],
      env: { SYNTHETIC_LABEL: 'offline-only' },
    },
  } }, null, 2));
  await targetState.rpc('mcp/save', {
    cwd: seeded.project,
    scope: 'global',
    server: {
      name: 'synthetic-oauth',
      label: 'Synthetic OAuth fixture',
      transport: { kind: 'http', url: targetState.oauthUrl },
      auth: { kind: 'oauth' },
      tools: { alwaysLoad: false },
      startup: 'on-demand',
    },
  });
  const inspected = await targetState.rpc('mcp/inspect', { cwd: seeded.project, scope: 'global', name: 'synthetic-oauth' });
  assert.equal(inspected.status, 'needs-auth', 'offline OAuth fixture must establish needs-auth');
  return { ...seeded, oauthUrl: targetState.oauthUrl, nodePath: targetState.nodePath };
}

async function installTransportProbe(page) {
  await page.addInitScript(() => {
    if (window.__independentSettingsProbe) return;
    window.__independentSettingsProbe = true;
    window.__independentSettingsRequests = [];
    window.__independentFailMcpSave = undefined;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class IndependentSettingsSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.__probeOnMessage = null;
      }
      send(data) {
        try {
          const request = JSON.parse(String(data));
          if (request?.method) {
            const params = request.params ?? {};
            const safe = { method: request.method };
            for (const key of ['cwd', 'scope', 'view', 'settingsView', 'source', 'id', 'name']) {
              if (typeof params[key] === 'string') safe[key] = params[key];
            }
            if (request.method === 'mcp/save') safe.name = params.server?.name;
            if (request.method === 'mcp/import/apply') safe.names = [...(params.names ?? [])];
            if (request.method === 'web-search/configure') {
              safe.action = params.change?.action;
              safe.provider = params.change?.provider;
            }
            window.__independentSettingsRequests.push(safe);
          }
          if (request.method === 'mcp/save' && request.params?.server?.name === window.__independentFailMcpSave) {
            window.__independentFailMcpSave = undefined;
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
              jsonrpc: '2.0', id: request.id,
              error: { code: -32000, message: 'Synthetic transport failure: MCP save was not sent' },
            }) })));
            return;
          }
        } catch {}
        return super.send(data);
      }
      set onmessage(handler) {
        this.__probeOnMessage = handler;
        super.onmessage = event => handler?.call(this, event);
      }
      get onmessage() { return this.__probeOnMessage; }
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function requestLog(page) {
  return page.evaluate(() => window.__independentSettingsRequests ?? []);
}

function countMutations(requests) {
  const methods = new Set(['mcp/save', 'mcp/remove', 'mcp/import/apply', 'mcp/auth/start', 'mcp/auth/complete', 'mcp/auth/logout', 'feature/set', 'pi/settings/set', 'pi/keybindings/set', 'web-search/configure']);
  return requests.filter(entry => methods.has(entry.method)).length;
}

async function activate(check, locator) {
  await locator.scrollIntoViewIfNeeded();
  if (check.state.touch) await locator.tap(); else await locator.click();
}

async function expectFocused(page, locator, label) {
  const element = await locator.elementHandle();
  assert.ok(element, `${label} remains connected`);
  try {
    await page.waitForFunction(node => document.activeElement === node, element, { timeout: 3000 });
  } finally {
    await element.dispose();
  }
}

async function settlePaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openSettings(check) {
  const { page } = check;
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  if (!(await settings.isVisible())) {
    const sessions = page.getByRole('button', { name: /(?:Sessions|Show sessions|Hide sessions)/ }).first();
    await sessions.waitFor();
    await activate(check, sessions);
  }
  await settings.waitFor();
  await activate(check, settings);
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
  await settlePaint(page);
}

async function selectProject(check, cwd, view = 'Project') {
  const { page } = check;
  const radio = page.getByRole('radio', { name: new RegExp(`^${view}\\.`) });
  await activate(check, radio);
  const picker = page.getByRole('button', { name: new RegExp(`${view} settings (?:target|project):`) });
  if (await picker.count()) {
    await activate(check, picker);
    await activate(check, page.getByRole('menuitemradio').filter({ hasText: cwd.split('/').at(-1) }));
  }
}

async function openTab(check, name) {
  const button = check.page.getByRole('button', { name, exact: true });
  await button.waitFor();
  await activate(check, button);
  const element = await button.elementHandle();
  assert.ok(element, `${name} tab remains connected`);
  try {
    await check.page.waitForFunction(node => node.getAttribute('aria-current') === 'page', element, { timeout: 3000 });
  } finally {
    await element.dispose();
  }
}

async function prepareProjects(check, includeZeroProof) {
  const { page } = check;
  const initial = check.fixture.project;
  if (includeZeroProof) {
    await check.rpc('pi/project/remove', { cwd: initial });
    const after = await check.rpc('pi/project/list', {});
    assert.equal(after.projects.length, 0, 'fixture starts with zero registered projects after removing its empty seed');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openSettings(check);
    await openTab(check, 'MCP servers');
    await page.getByRole('radio', { name: /^Global\./ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /settings (?:target|project):/i }).count(), 0, 'Global exposes no borrowed project target');
    await page.getByRole('button', { name: 'Add a server', exact: true }).waitFor();
    const reqs = await requestLog(page);
    assert.ok(reqs.some(r => r.method === 'mcp/list' && r.view === 'global'), 'Global MCP used an explicit global view through the neutral route');
    await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
  }
  const suffix = `${check.state.width}-${check.state.theme}-${check.state.touch ? 'touch' : 'pointer'}-${check.state.reducedMotion ? 'reduced' : 'motion'}`;
  const projectA = join(check.root, `code-project-a-${suffix}`);
  const projectB = join(check.root, `settings-project-b-${suffix}`);
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  for (const cwd of [projectA, projectB]) {
    await check.rpc('pi/project/add', { cwd });
    await check.rpc('pi/project/trust', { cwd, trusted: true, remember: true });
  }
  const { state } = await check.rpc('session/new', { cwd: projectA });
  await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
  await page.goto(`${new URL(page.url()).origin}/#/session/${encodeURIComponent(state.path)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('textarea[aria-label="Message"]').waitFor();
  return { projectA, projectB, sessionPath: state.path };
}

async function focusReturnJourney(check) {
  const { page } = check;
  await openSettings(check);
  await openTab(check, 'MCP servers');
  await activate(check, page.getByRole('radio', { name: /^Global\./ }));

  const add = page.getByRole('button', { name: 'Add a server', exact: true });
  await activate(check, add);
  let dialog = page.getByRole('dialog', { name: 'Add a server', exact: true });
  await dialog.waitFor();
  await activate(check, dialog.getByRole('button', { name: 'Cancel', exact: true }));
  await dialog.waitFor({ state: 'hidden' });
  await expectFocused(page, add, `${check.state.touch ? 'touch' : 'pointer'} Add cancel returns focus`);

  if (!check.state.touch) {
    await activate(check, add);
    dialog = page.getByRole('dialog', { name: 'Add a server', exact: true });
    await dialog.waitFor();
    await dialog.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await expectFocused(page, add, 'keyboard Escape returns focus');
  }

  const imported = page.getByRole('button', { name: 'Import', exact: true });
  await imported.waitFor();
  await activate(check, imported);
  const importDialog = page.getByRole('dialog', { name: 'Import servers', exact: true });
  await importDialog.waitFor();
  await activate(check, importDialog.getByRole('button', { name: 'Cancel', exact: true }));
  await importDialog.waitFor({ state: 'hidden' });
  await expectFocused(page, imported, `${check.state.touch ? 'touch' : 'pointer'} Import cancel returns focus`);

  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

async function keyboardJourney(check, projectB, neutral) {
  const { page } = check;
  await openSettings(check);
  await openTab(check, 'Features');
  await selectProject(check, projectB, 'Effective');
  await openTab(check, 'Help and shortcuts');
  const change = page.getByRole('button', { name: 'Change the key for Cancel or abort', exact: true });
  await change.waitFor();
  assert.equal(await change.isDisabled(), false, 'remembered Effective leaves standalone Global Keyboard writable');
  await activate(check, change);
  await page.getByRole('button', { name: 'Press the new key for Cancel or abort', exact: true }).press('Control+Alt+F12');
  await page.waitForFunction(() => (window.__independentSettingsRequests ?? []).some(r => r.method === 'pi/keybindings/set'));
  const persisted = await check.rpc('pi/keybindings/get', { cwd: neutral });
  const binding = persisted.keybindings.bindings.find(entry => entry.description === 'Cancel or abort');
  assert.deepEqual(binding?.keys, ['ctrl+alt+f12'], 'scratch keybinding persisted through the neutral Global route');
  const write = (await requestLog(page)).findLast(r => r.method === 'pi/keybindings/set');
  assert.equal(write.cwd, neutral);
  await check.shot('independent-keyboard-persisted');
  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

async function effectiveReadOnlyJourney(check, projectB) {
  const { page } = check;
  await openSettings(check);
  await openTab(check, 'MCP servers');
  await selectProject(check, projectB, 'Effective');
  // Absence during loading is not readonly proof. Wait for the actual target's
  // projected rows and readonly explanation before checking its controls.
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'MCP servers', exact: true }).waitFor();
  await page.getByText(/Effective settings are a read-only preview/).waitFor();
  const readonlyRow = page.locator('[data-server]').filter({ hasText: 'Synthetic OAuth fixture' }).first();
  await readonlyRow.waitFor();
  const before = countMutations(await requestLog(page));
  await activate(check, readonlyRow.getByRole('button').first());
  const readonlyInspector = page.locator('[data-slot="mcp-inspector"]');
  await readonlyInspector.waitFor();
  for (const name of ['Edit', 'Override for this project', 'Remove', 'Sign in']) {
    assert.equal(await readonlyInspector.getByRole('button', { name, exact: true }).count(), 0, `Effective inspector has no ${name} action`);
  }
  await activate(check, readonlyInspector.getByRole('button', { name: 'Close', exact: true }));
  await readonlyInspector.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Add a server', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Look again', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
  await check.shot('independent-effective-mcp');
  await openTab(check, 'Providers and models');
  const web = page.getByRole('tab', { name: 'Web search', exact: true });
  await activate(check, web);
  const searchToggle = page.getByRole('button', { name: 'Enable web search', exact: true });
  await searchToggle.waitFor();
  assert.equal(await searchToggle.isDisabled(), true);
  const searx = page.getByRole('button').filter({ hasText: 'SearXNG' }).first();
  await activate(check, searx);
  assert.equal(await page.getByPlaceholder('https://search.example.com').isDisabled(), true);
  await page.getByText(/Effective settings are a read-only preview/).waitFor();
  assert.equal(countMutations(await requestLog(page)), before, 'Effective surfaces captured zero mutation requests');
  await check.shot('independent-effective-web-search');
  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

async function mcpJourney(check, projectB, neutral) {
  const { page } = check;
  await openSettings(check);
  await openTab(check, 'MCP servers');
  const global = page.getByRole('radio', { name: /^Global\./ });
  await activate(check, global);

  const addTrigger = page.getByRole('button', { name: 'Add a server', exact: true });
  await activate(check, addTrigger);
  const blank = page.getByRole('dialog', { name: 'Add a server', exact: true });
  await blank.waitFor();
  assert.equal(await blank.getByRole('button', { name: 'Add', exact: true }).isDisabled(), true, 'blank new form has no save action');
  const projectRadio = page.getByRole('radio', { name: /^Project\./ });
  let scopeReachable = true;
  try { await projectRadio.click({ trial: true, timeout: 800 }); } catch { scopeReachable = false; }
  assert.equal(scopeReachable, false, 'scope controls are not pointer-reachable behind the MCP modal');
  await blank.getByRole('button', { name: 'Cancel', exact: true }).click();
  await blank.waitFor({ state: 'hidden' });
  await expectFocused(page, addTrigger, 'Add cancel returns focus after the close lifecycle');

  await activate(check, addTrigger);
  const dialog = page.getByRole('dialog', { name: 'Add a server', exact: true });
  const label = dialog.getByLabel('Name it');
  await label.fill('Synthetic local fixture');
  await dialog.getByLabel('Command').fill(`${check.fixture.nodePath} ${FIXTURE_SERVER}`);
  const shortName = await dialog.getByLabel('Short name').inputValue();
  assert.equal(shortName, 'synthetic-local-fixture');
  await page.evaluate(name => { window.__independentFailMcpSave = name; }, shortName);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Synthetic transport failure' }).waitFor();
  assert.equal(await label.inputValue(), 'Synthetic local fixture', 'failed save keeps the draft');
  await dialog.getByText('Save it for Global settings.', { exact: true }).waitFor();
  const failedWrite = (await requestLog(page)).findLast(r => r.method === 'mcp/save' && r.name === shortName);
  assert.deepEqual({ cwd: failedWrite?.cwd, scope: failedWrite?.scope }, { cwd: neutral, scope: 'global' }, 'failed save retains the captured original target');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await expectFocused(page, addTrigger, 'successful Add returns focus');
  let globalList = await check.rpc('mcp/list', { cwd: neutral, view: 'global' });
  assert.ok(globalList.servers.some(s => s.scope === 'global' && s.config.name === shortName), 'custom add persisted in Global');

  const customRow = page.locator(`[data-server="global:${shortName}"] button`).first();
  await activate(check, customRow);
  const inspector = page.locator('[data-slot="mcp-inspector"]');
  await inspector.getByRole('button', { name: 'Edit', exact: true }).click();
  const editTrigger = inspector.getByRole('button', { name: 'Edit', exact: true });
  const edit = page.getByRole('dialog', { name: /Edit Synthetic local fixture/ });
  await edit.getByLabel('Name it').fill('Synthetic local fixture edited');
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  await expectFocused(page, editTrigger, 'successful Edit returns focus');
  globalList = await check.rpc('mcp/list', { cwd: neutral, view: 'global' });
  assert.equal(globalList.servers.find(s => s.config.name === shortName)?.config.label, 'Synthetic local fixture edited', 'edit persisted its after-state');
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();

  const importTrigger = page.getByRole('button', { name: 'Import', exact: true });
  await importTrigger.waitFor();
  await activate(check, importTrigger);
  const importDialog = page.getByRole('dialog', { name: 'Import servers', exact: true });
  assert.equal(await importDialog.getByRole('button', { name: 'Import servers', exact: true }).isDisabled(), true, 'blank import is clean and unsaveable');
  await importDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await importDialog.waitFor({ state: 'hidden' });
  await expectFocused(page, importTrigger, 'Import cancel returns focus after the close lifecycle');
  await activate(check, importTrigger);
  await page.getByRole('checkbox', { name: 'Import synthetic-import', exact: true }).check();
  await importDialog.getByRole('button', { name: 'Import 1 server', exact: true }).click();
  await importDialog.waitFor({ state: 'hidden' });
  await expectFocused(page, importTrigger, 'successful Import returns focus');
  globalList = await check.rpc('mcp/list', { cwd: neutral, view: 'global' });
  assert.ok(globalList.servers.some(s => s.scope === 'global' && s.config.name === 'synthetic-import'), 'import persisted through real mcp/import/apply');

  await selectProject(check, projectB, 'Project');
  const authRow = page.locator('[data-server="global:synthetic-oauth"]');
  await authRow.waitFor();
  assert.equal(await authRow.getByRole('button', { name: 'Sign in', exact: true }).count(), 0, 'inherited needs-auth Global row has no dead Sign in');
  await activate(check, authRow.getByRole('button').first());
  await inspector.getByRole('button', { name: 'Override for this project', exact: true }).click();
  const override = page.getByRole('dialog', { name: 'Override Synthetic OAuth fixture for Project settings', exact: true });
  await override.getByRole('button', { name: 'Save Project override', exact: true }).click();
  await override.waitFor({ state: 'hidden' });
  const signIn = page.getByRole('dialog', { name: 'Sign in to Synthetic OAuth fixture', exact: true });
  await signIn.waitFor();
  const signInElement = await signIn.elementHandle();
  assert.ok(signInElement);
  try {
    await page.waitForFunction(node => node.contains(document.activeElement), signInElement, { timeout: 3000 });
  } finally {
    await signInElement.dispose();
  }
  await page.waitForFunction(() => (window.__independentSettingsRequests ?? []).some(r => r.method === 'mcp/auth/start' && r.scope === 'project'));
  await signIn.getByRole('button', { name: 'Not now', exact: true }).click();
  const projectList = await check.rpc('mcp/list', { cwd: projectB, view: 'project' });
  assert.ok(projectList.servers.some(s => s.scope === 'project' && s.config.name === 'synthetic-oauth'), 'override created a Project-owned same-name copy');
  globalList = await check.rpc('mcp/list', { cwd: neutral, view: 'global' });
  assert.ok(globalList.servers.some(s => s.scope === 'global' && s.config.name === 'synthetic-oauth'), 'Project override did not modify Global ownership');
  await check.shot('independent-mcp-ownership');
  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

async function webSearchJourney(check, projectB) {
  const { page } = check;
  await openSettings(check);
  const firstUse = page.getByRole('dialog', { name: /works best installed/ });
  if (await firstUse.isVisible()) {
    await activate(check, firstUse.getByRole('button', { name: 'Not now', exact: true }));
    await firstUse.waitFor({ state: 'hidden' });
  }
  await openTab(check, 'Providers and models');
  const webTab = page.getByRole('tab', { name: 'Web search', exact: true });
  await webTab.waitFor();
  await activate(check, webTab);
  const global = page.getByRole('radio', { name: /^Global\./ });
  if (await global.count()) await activate(check, global);
  const searx = page.getByRole('button').filter({ hasText: 'SearXNG' }).first();
  await activate(check, searx);
  const address = page.getByPlaceholder('https://search.example.com');
  const fakeUrl = `https://synthetic-${check.state.width}-${check.state.theme}.invalid/search`;
  await address.fill(fakeUrl);
  const brave = page.getByRole('button').filter({ hasText: 'Brave' }).first();
  await activate(check, brave);
  const fakeKey = `synthetic-do-not-use-${check.state.width}-${check.state.theme}`;
  const braveBody = brave.locator('..').locator('..');
  const keys = page.getByPlaceholder('Paste an API key');
  await keys.last().fill(fakeKey);
  await activate(check, searx);
  await activate(check, brave);
  const filter = page.getByRole('textbox', { name: 'Find a search provider' });
  await filter.fill('DuckDuckGo');
  assert.equal(await searx.count(), 0);
  assert.equal(await brave.count(), 0);
  await filter.fill('');
  await activate(check, page.getByRole('radio', { name: /^Project\./ }));
  const guard = page.getByRole('dialog', { name: 'Keep these unsaved changes?', exact: true });
  await guard.waitFor();
  await guard.getByText('2 drafts belong to the current Settings target.', { exact: true }).waitFor();
  await guard.getByRole('listitem').filter({ hasText: 'SearXNG search connection' }).waitFor();
  await guard.getByRole('listitem').filter({ hasText: 'Brave search connection' }).waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await global.getAttribute('aria-checked'), 'true', 'Keep editing refuses navigation');
  await activate(check, page.getByRole('button').filter({ hasText: 'SearXNG' }).first());
  assert.equal(await page.getByPlaceholder('https://search.example.com').inputValue(), fakeUrl, 'SearXNG draft survived collapse/filter/refusal');
  await activate(check, page.getByRole('button').filter({ hasText: 'Brave' }).first());
  assert.equal(await page.getByPlaceholder('Paste an API key').last().inputValue(), fakeKey, 'Brave secret draft survived collapse/filter/refusal in memory');
  await page.getByPlaceholder('https://search.example.com').fill('');
  await activate(check, page.getByRole('radio', { name: /^Project\./ }));
  await guard.waitFor();
  await guard.getByText('Brave search connection belongs to the current Settings target.', { exact: true }).waitFor();
  assert.equal(await guard.getByText(/SearXNG search connection/).count(), 0, 'clearing one draft leaves the other registered');
  await guard.getByRole('button', { name: 'Discard and switch', exact: true }).click();
  await page.getByText('Choose a project for Project settings', { exact: true }).waitFor();
  await selectProject(check, projectB, 'Project');
  const status = await check.rpc('web-search/status', { cwd: (await check.rpc('pi/setup/state', {})).cwd });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(fakeKey), 'status never returns the synthetic secret');
  assert.equal(JSON.stringify(await requestLog(page)).includes(fakeKey), false, 'request evidence stores metadata only, never the synthetic secret');
  await check.shot('independent-two-search-drafts');
  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

async function navigationJourney(check, projectB) {
  const { page } = check;
  await openSettings(check);
  await openTab(check, 'Features');
  const global = page.getByRole('radio', { name: /^Global\./ });
  await global.focus();
  await global.press('ArrowRight');
  assert.equal(await page.getByRole('radio', { name: /^Project\./ }).getAttribute('aria-checked'), 'true', 'keyboard scope navigation uses the reachable radio group');
  await selectProject(check, projectB, 'Project');
  if (check.state.touch) {
    await activate(check, page.getByRole('radio', { name: /^Effective\./ }));
    assert.equal(await page.getByRole('radio', { name: /^Effective\./ }).getAttribute('aria-checked'), 'true', 'touch selects Effective');
  }
  await check.shot('independent-scope-navigation');
  await activate(check, page.getByRole('button', { name: 'Back to the session', exact: true }));
}

export default async function run(check) {
  const { page } = check;
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => activate(check, installPrompt.getByRole('button', { name: 'Not now', exact: true })));
  await installTransportProbe(page);
  const primary = check.state.width === 1360 && check.state.theme === 'dark';
  const { projectB } = await prepareProjects(check, primary && !check.state.touch && !check.state.reducedMotion);
  const neutral = (await check.rpc('pi/setup/state', {})).cwd;

  await focusReturnJourney(check);
  if (primary && !check.state.touch && !check.state.reducedMotion) {
    await keyboardJourney(check, projectB, neutral);
    await mcpJourney(check, projectB, neutral);
    await effectiveReadOnlyJourney(check, projectB);
  } else if ((check.state.width === 1360 && check.state.theme === 'light' && !check.state.touch) || check.state.reducedMotion) {
    await webSearchJourney(check, projectB);
  } else {
    await navigationJourney(check, projectB);
    if (check.state.width === 390) await effectiveReadOnlyJourney(check, projectB);
  }

  const result = {
    candidate: CANDIDATE,
    state: check.state,
    projectB,
    requests: await requestLog(page),
    findings: await page.evaluate(() => window.__independentSettingsFindings ?? []),
    mutationCount: countMutations(await requestLog(page)),
    syntheticOnly: true,
    externalProviderCalls: 0,
    mcpModalScopeReachability: primary && !check.state.touch && !check.state.reducedMotion ? 'blocked by modal focus/pointer boundary; no forced click used' : 'not exercised in this case',
  };
  writeFileSync(join(check.root, `independent-settings-${check.state.width}-${check.state.theme}${check.state.touch ? '-touch' : ''}${check.state.reducedMotion ? '-reduced' : ''}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await page.removeLocatorHandler(installPrompt);
}

if (process.argv[2] === '--oauth-child') {
  const wantedPort = Number(process.argv[3]);
  const { createServer } = await import('node:http');
  const { startFixtureOAuthServer } = await import(pathToFileURL(OAUTH_SERVER).href);
  // The official fixture chooses its own port. Proxy the fixed harness-owned
  // port to it so the target can publish a deterministic URL before the page runs.
  const fixtureServer = await startFixtureOAuthServer();
  const proxy = createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(new URL(req.url ?? '/', fixtureServer.url).href.replace('/mcp/', '/'), {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, value]) => value !== undefined)),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      redirect: 'manual',
    });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  proxy.listen(wantedPort, '127.0.0.1');
  process.once('SIGTERM', () => proxy.close(() => void fixtureServer.close().then(() => process.exit(0))));
}
