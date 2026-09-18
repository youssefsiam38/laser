import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { identity } from '../../identity/identity.mjs';

export default async function settingsScope(check) {
  const { page } = check;
  const activate = async locator => {
    await locator.scrollIntoViewIfNeeded();
    if (check.state.touch) await locator.tap(); else await locator.click();
  };
  const installPrompt = page.getByRole('dialog', { name: /works best installed/ });
  await page.addLocatorHandler(installPrompt, async () => {
    await activate(installPrompt.getByRole('button', { name: 'Not now', exact: true }));
  });

  // This case owns both projects. Common fixtures stay untouched.
  const caseSuffix = `${check.state.width}-${check.state.theme}-${check.state.touch ? 'touch' : 'pointer'}`;
  const first = join(check.root, `settings-scope-project-one-${caseSuffix}`);
  const second = join(check.root, `settings-scope-project-two-${caseSuffix}`);
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  await check.rpc('pi/project/add', { cwd: first });
  await check.rpc('pi/project/trust', { cwd: first, trusted: true, remember: true });
  await check.rpc('pi/project/add', { cwd: second });
  const registered = await check.rpc('pi/project/list', {});
  assert.equal(registered.projects.find(project => project.cwd === second)?.trust, 'not_required',
    'Project B starts without trust-gated content');
  // Distinct resolved values make an out-of-order response visible without
  // pre-trusting Project B: A overrides Goals Off, while B inherits Global On.
  await check.rpc('feature/set', { id: 'goals', enabled: true, scope: 'global' });
  await check.rpc('feature/set', { id: 'goals', enabled: false, scope: 'project', cwd: first });
  const definition = (name, scope, description) => ({
    name, scope, ...(scope === 'project' ? { projectCwd: second } : {}), description,
    instructions: `Work as ${name}.`, engineInstructions: false, excludeCoreInstructions: false,
    model: null, thinkingLevel: null, supportsSubagents: false, allowedAgents: [], scopedSkills: false, skills: [],
  });
  const agentsBefore = (await check.rpc('agents/list', {})).agents;
  if (!agentsBefore.some(agent => agent.name === 'scope-shared' && agent.scope === 'global')) {
    await check.rpc('agents/save', { agent: definition('scope-shared', 'global', 'Global shared source'), originalName: null });
  }
  if (!agentsBefore.some(agent => agent.name === 'scope-global-only' && agent.scope === 'global')) {
    await check.rpc('agents/save', { agent: definition('scope-global-only', 'global', 'Global source ready to override'), originalName: null });
  }

  // Script-local transport fault: delay only one feature/list answer. The app
  // still uses its real socket, host and payload; no common fixture is edited.
  await page.addInitScript(() => {
    if (window.__settingsScopeDelayInstalled) return;
    window.__settingsScopeDelayInstalled = true;
    window.__settingsScopeDelay = null;
    window.__settingsScopeFailSetup = localStorage.getItem('__settings-scope-fail-setup') === '1';
    window.__settingsScopeFailedSetupRequests = 0;
    window.__settingsScopeRequests = [];
    localStorage.removeItem('__settings-scope-fail-setup');
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class SettingsScopeWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.__settingsScopeDelayedIds = new Set();
        this.__settingsScopeOnMessage = null;
      }
      send(data) {
        try {
          const request = JSON.parse(String(data));
          if (request?.method) window.__settingsScopeRequests.push({ method: request.method, params: request.params });
          const delay = window.__settingsScopeDelay;
          if (delay && request.method === delay.method && request.params?.cwd === delay.cwd) {
            this.__settingsScopeDelayedIds.add(request.id);
          }
          if (window.__settingsScopeFailSetup && request.method === 'pi/setup/state') {
            window.__settingsScopeFailedSetupRequests += 1;
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
              data: JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32000, message: 'Settings service unavailable for browser test' },
              }),
            })));
            return;
          }
        } catch {
          // Non-JSON frames are the native socket's concern.
        }
        return super.send(data);
      }
      set onmessage(handler) {
        this.__settingsScopeOnMessage = handler;
        super.onmessage = event => {
          let delayed = false;
          try {
            const response = JSON.parse(String(event.data));
            delayed = this.__settingsScopeDelayedIds.delete(response.id);
          } catch {
            // Forward malformed/non-JSON frames without changing behavior.
          }
          const deliver = () => handler?.call(this, event);
          if (delayed) setTimeout(deliver, window.__settingsScopeDelay?.ms ?? 1800);
          else deliver();
        };
      }
      get onmessage() {
        return this.__settingsScopeOnMessage;
      }
    };
  });

  // Every matrix case proves the actual default rather than inheriting the
  // previous case's persisted choice. The key shape remains owned by the app;
  // this removes only the suffix under the active environment namespace.
  await page.evaluate(() => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.endsWith(':settings-scope')) localStorage.removeItem(key);
    }
  });
  await page.evaluate(() => localStorage.setItem('__settings-scope-fail-setup', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.deepEqual(await page.evaluate(() => ({
    installed: window.__settingsScopeDelayInstalled,
    armed: window.__settingsScopeFailSetup,
  })), { installed: true, armed: true }, 'the route-failure transport shim is armed before Settings opens');

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const openSettings = async () => {
    await page.waitForTimeout(300);
    if (!(await settings.isVisible())) {
      const sessionsButton = page.getByRole('button', { name: /(?:Sessions|Show sessions)/ }).first();
      await sessionsButton.waitFor();
      await activate(sessionsButton);
    }
    await settings.waitFor();
    await activate(settings);
  };
  const destinationBefore = await page.evaluate(() => [...Array(localStorage.length).keys()]
    .map(index => localStorage.key(index))
    .filter(key => key?.endsWith(':destination'))
    .map(key => [key, localStorage.getItem(key)]));

  await openSettings();
  await page.getByText('Could not prepare Global settings', { exact: true }).waitFor();
  await page.getByText('Settings service unavailable for browser test', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.__settingsScopeFailedSetupRequests) > 0,
    'the route-failure transport shim saw pi/setup/state');
  await page.evaluate(() => { window.__settingsScopeFailSetup = false; });
  await activate(page.getByRole('button', { name: 'Retry global settings', exact: true }));

  const globalScope = page.getByRole('radio', { name: /^Global\./ });
  await globalScope.waitFor();
  assert.equal(await globalScope.getAttribute('aria-checked'), 'true', 'Settings opens Global even while a project is open in Code');
  assert.equal(await page.getByRole('button', { name: /settings project/i }).count(), 0, 'Global has no borrowed project target');

  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  await activate(page.getByRole('radio', { name: /^Project\./ }));
  await page.getByText('Choose a project for Project settings', { exact: true }).waitFor();

  const choose = async (cwd) => {
    await activate(page.getByRole('button', { name: /(?:Project settings target|Effective settings project):/ }));
    const item = page.getByRole('menuitemradio').filter({ hasText: basename(cwd) });
    await item.waitFor();
    await activate(item);
  };

  await page.evaluate(cwd => {
    window.__settingsScopeDelay = { method: 'feature/list', cwd, ms: 1800 };
  }, first);
  await choose(first);
  await page.waitForTimeout(100);
  await choose(second);

  const secondTarget = page.getByRole('button', { name: new RegExp(`Project settings target:.*${basename(second)}`) });
  await secondTarget.waitFor();
  await page.getByRole('button', { name: 'Disable Goals', exact: true }).waitFor();
  await page.waitForTimeout(2100);
  const resolvedGoals = page.getByRole('button', { name: 'Disable Goals', exact: true });
  await resolvedGoals.waitFor();
  assert.equal(await resolvedGoals.count(), 1,
    'the delayed Off response from the old project did not replace the selected project');
  if (await installPrompt.isVisible()) await activate(installPrompt.getByRole('button', { name: 'Not now', exact: true }));
  assert.match(await secondTarget.getAttribute('aria-label'), new RegExp(basename(second)));

  const destinationAfter = await page.evaluate(() => [...Array(localStorage.length).keys()]
    .map(index => localStorage.key(index))
    .filter(key => key?.endsWith(':destination'))
    .map(key => [key, localStorage.getItem(key)]));
  assert.deepEqual(destinationAfter, destinationBefore, 'choosing a Settings project did not change the Code destination');

  // The same authority is visible on every migrated surface.
  await activate(page.getByRole('button', { name: 'General', exact: true }));
  await page.getByRole('button', { name: new RegExp(`Project settings target:.*${basename(second)}`) }).waitFor();
  await activate(page.getByRole('button', { name: 'Advanced', exact: true }));
  await activate(page.getByRole('tab', { name: 'Configuration', exact: true }));
  await page.getByRole('button', { name: new RegExp(`Project settings target:.*${basename(second)}`) }).waitFor();
  await activate(page.getByRole('button', { name: 'Features', exact: true }));

  // The Radix radio group owns genuine roving focus and selection.
  const projectScope = page.getByRole('radio', { name: /^Project\./ });
  const effective = page.getByRole('radio', { name: /^Effective\./ });
  await projectScope.focus();
  await projectScope.press('ArrowRight');
  await page.getByText(/Resolved feature choices are read-only here/).waitFor();
  assert.equal(await effective.getAttribute('aria-checked'), 'true', 'ArrowRight selects the next LTR scope');
  assert.equal(await page.getByRole('button', { name: 'Disable Goals', exact: true }).isDisabled(), true);
  await effective.press('Home');
  assert.equal(await globalScope.getAttribute('aria-checked'), 'true', 'Home selects Global');
  await activate(projectScope);
  await choose(second);
  await projectScope.focus();
  await projectScope.press('End');
  assert.equal(await effective.getAttribute('aria-checked'), 'true', 'End selects Effective');

  // Direction comes from the real Appearance setting and Radix provider.
  await activate(page.getByRole('button', { name: 'Appearance', exact: true }));
  await activate(page.getByRole('radio', { name: 'Right to left', exact: true }));
  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  await activate(page.getByRole('radio', { name: /^Project\./ }));
  const rtlProject = page.getByRole('radio', { name: /^Project\./ });
  await rtlProject.focus();
  await rtlProject.press('ArrowRight');
  assert.equal(await page.getByRole('radio', { name: /^Global\./ }).getAttribute('aria-checked'), 'true',
    'ArrowRight selects the visually next scope in RTL');
  await activate(page.getByRole('button', { name: 'Appearance', exact: true }));
  await activate(page.getByRole('radio', { name: 'Follow system', exact: true }));
  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  await activate(page.getByRole('radio', { name: /^Project\./ }));
  await choose(second);
  await activate(page.getByRole('radio', { name: /^Effective\./ }));

  await activate(page.getByRole('button', { name: 'Back to the session', exact: true }));
  await openSettings();
  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  assert.equal(await page.getByRole('radio', { name: /^Effective\./ }).getAttribute('aria-checked'), 'true', 'scope persisted after closing Settings');
  await page.getByRole('button', { name: new RegExp(`Effective settings project:.*${basename(second)}`) }).waitFor();

  const waitForRequest = async (method, expected) => {
    await page.waitForFunction(({ method, expected }) => window.__settingsScopeRequests.some(request =>
      request.method === method && Object.entries(expected).every(([key, value]) => request.params?.[key] === value)),
    { method, expected });
  };
  const neutral = (await check.rpc('pi/setup/state', {})).cwd;

  // Remaining Settings services expose their target in the real RPC shape.
  await activate(page.getByRole('button', { name: 'MCP servers', exact: true }));
  await waitForRequest('mcp/list', { cwd: second, view: 'effective' });
  assert.equal(await page.getByRole('button', { name: 'Add a server', exact: true }).count(), 0,
    'Effective MCP is read-only');
  assert.equal(await page.getByRole('button', { name: 'Look again', exact: true }).count(), 0,
    'Effective MCP has no inert discovery action');
  await check.shot('settings-scope-mcp');
  await activate(page.getByRole('radio', { name: /^Global\./ }));
  await waitForRequest('mcp/list', { cwd: neutral, view: 'global' });
  await waitForRequest('mcp/import/detect', { cwd: neutral, scope: 'global' });
  await activate(page.getByRole('radio', { name: /^Project\./ }));
  await choose(second);
  await waitForRequest('mcp/list', { cwd: second, view: 'project' });
  await waitForRequest('mcp/import/detect', { cwd: second, scope: 'project' });

  await activate(page.getByRole('button', { name: 'Providers and models', exact: true }));
  await waitForRequest('pi/models/catalog', { cwd: second, settingsView: 'effective' });
  await waitForRequest('pi/providers/list', { cwd: neutral });
  await check.shot('settings-scope-models');
  await activate(page.getByRole('radio', { name: /^Global\./ }));
  await waitForRequest('pi/models/catalog', { cwd: neutral, settingsView: 'global' });
  const searchTab = page.getByRole('tab', { name: 'Web search', exact: true });
  if (await searchTab.count()) {
    await activate(searchTab);
    await waitForRequest('web-search/status', { cwd: neutral });
    const searxng = page.getByRole('button').filter({ hasText: 'SearXNG' }).first();
    await activate(searxng);
    const address = page.getByPlaceholder('https://search.example.com');
    await address.fill('https://browser-check.invalid/search');
    await activate(searxng);
    await activate(page.getByRole('radio', { name: /^Project\./ }));
    await page.getByRole('dialog', { name: 'Keep these unsaved changes?' }).waitFor();
    await activate(page.getByRole('button', { name: 'Keep editing', exact: true }));
    assert.equal(await globalScope.getAttribute('aria-checked'), 'true', 'a dirty Web Search draft refused the scope change');
    await activate(searxng);
    assert.equal(await address.inputValue(), 'https://browser-check.invalid/search', 'collapse preserved the Web Search draft');
    const providerFilter = page.getByRole('textbox', { name: 'Find a search provider' });
    await providerFilter.fill('Bright Data');
    assert.equal(await searxng.count(), 0, 'filtering removed only the provider presentation');
    await providerFilter.fill('');
    await page.getByRole('button').filter({ hasText: 'SearXNG' }).first().waitFor();
    assert.equal(await page.getByPlaceholder('https://search.example.com').inputValue(), 'https://browser-check.invalid/search',
      'filtering preserved the Web Search draft');
    await check.shot('settings-scope-web-search-draft');
    await activate(page.getByRole('radio', { name: /^Project\./ }));
    await activate(page.getByRole('button', { name: 'Discard and switch', exact: true }));
    await choose(second);
  }

  await activate(page.getByRole('radio', { name: /^Effective\./ }));
  await activate(page.getByRole('button', { name: 'Help and shortcuts', exact: true }));
  await waitForRequest('pi/keybindings/get', { cwd: neutral });
  await page.getByText('Agent keybindings are global and stay in force for every project.', { exact: true }).waitFor();
  const interruptEdit = page.getByRole('button', { name: 'Change the key for Cancel or abort', exact: true });
  await interruptEdit.waitFor();
  assert.equal(await interruptEdit.isDisabled(), false, 'remembered Effective does not disable global keybinding edits');
  assert.equal(await page.getByText(/Effective settings are a read-only preview/).count(), 0,
    'global Keyboard does not show scoped read-only copy');
  await check.shot('settings-scope-keyboard');

  await activate(page.getByRole('button', { name: 'Projects', exact: true }));
  const firstProject = page.getByRole('button', { name: new RegExp(`project settings$`, 'i') }).filter({ hasText: basename(first) });
  const secondProject = page.getByRole('button', { name: new RegExp(`project settings$`, 'i') }).filter({ hasText: basename(second) });
  const [firstBox, secondBox] = await Promise.all([firstProject.boundingBox(), secondProject.boundingBox()]);
  assert.ok(firstBox && secondBox && firstBox.y < secondBox.y,
    'Projects stay name-sorted instead of promoting the selected Settings project');

  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  await activate(page.getByRole('radio', { name: /^Effective\./ }));
  await choose(second);

  // Agents is another owner of the same explicit target, not a second scope
  // chooser. Effective resolves shadows and exposes no definition mutations.
  await activate(page.getByRole('button', { name: 'Back to the session', exact: true }));
  const agentsButton = page.locator('[data-slot="agents-button"]');
  await page.waitForTimeout(300);
  if (!(await agentsButton.isVisible())) {
    const sessionsButton = page.getByRole('button', { name: /(?:Sessions|Show sessions)/ }).first();
    await sessionsButton.waitFor();
    await activate(sessionsButton);
  }
  await agentsButton.waitFor();
  await activate(agentsButton);
  assert.equal(await page.getByRole('radio', { name: /^Effective\./ }).getAttribute('aria-checked'), 'true',
    'Agents inherited the one Settings scope');
  await page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="global"]').waitFor();
  assert.equal(await page.locator('[data-slot="agent-row"][data-agent="scope-shared"]').count(), 1,
    'Effective initially resolves the Global source because Project B has no override');
  assert.equal(await page.getByRole('button', { name: 'New agent', exact: true }).count(), 0,
    'Effective Agents has zero write affordances');
  assert.equal(await page.getByText('Built in', { exact: true }).count(), 0, 'Effective hides Global-only built-ins');
  await page.waitForTimeout(400);
  await check.shot('settings-scope-agents-effective');

  await activate(page.getByRole('radio', { name: /^Project\./ }));
  await page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="global"]').waitFor();
  assert.equal(await page.locator('[data-slot="agent-row"][data-agent="scope-shared"]').count(), 1,
    'Project shows the read-only Global source before an override exists');
  assert.equal(await page.locator('[data-slot="agent-row"][data-agent="scope-shared"] [data-slot="agent-global-badge"]').innerText(), 'Global');
  await page.waitForTimeout(400);
  await check.shot('settings-scope-agents-project');

  await activate(page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="global"]'));
  await activate(page.getByRole('button', { name: 'Create Project override', exact: true }));
  await page.locator('[data-slot="agent-definition-destination"]').getByText(`Project · ${basename(second)}`, { exact: true }).waitFor();
  await page.locator('textarea[name="description"]').fill('Project B resolved source');
  await activate(page.getByRole('button', { name: /^(?:Create agent|Save)$/ }));

  let projectTrust;
  let savedOverride;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [projects, agents] = await Promise.all([
      check.rpc('pi/project/list', {}),
      check.rpc('agents/list', {}),
    ]);
    projectTrust = projects.projects.find(project => project.cwd === second)?.trust;
    savedOverride = agents.agents.find(agent => agent.name === 'scope-shared' && agent.scope === 'project' && agent.projectCwd === second);
    if (projectTrust === 'trusted' && savedOverride) break;
    await page.waitForTimeout(100);
  }
  assert.equal(projectTrust, 'trusted', 'the first person-authored Project definition persisted trust');
  assert.equal(savedOverride?.description, 'Project B resolved source', 'the saved definition belongs to Project B');
  const overridePath = join(second, `.${identity.name}`, 'agents', 'scope-shared.md');
  assert.equal(existsSync(overridePath), true, 'the Project override was written at its exact location');
  assert.match(readFileSync(overridePath, 'utf8'), /Project B resolved source/);
  await check.shot('settings-scope-agents-saved-override');

  await activate(page.getByRole('radio', { name: /^Effective\./ }));
  const effectiveProjectRow = page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="project"]');
  if (await effectiveProjectRow.count()) {
    await effectiveProjectRow.waitFor();
    assert.equal(await page.locator('[data-slot="agent-row"][data-agent="scope-shared"]').count(), 1,
      'Effective resolves the newly persisted Project shadow');
  } else {
    assert.equal(await page.locator('textarea[name="description"]').inputValue(), 'Project B resolved source',
      'Effective keeps the resolved Project shadow open on a phone');
  }
  await check.shot('settings-scope-agents-effective-shadow');

  await activate(page.getByRole('radio', { name: /^Project\./ }));
  const persistedProjectRow = page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="project"]');
  if (await persistedProjectRow.isVisible()) await activate(persistedProjectRow);
  else await page.locator('[data-slot="agent-definition-destination"]').getByText(`Project · ${basename(second)}`, { exact: true }).waitFor();
  await page.locator('textarea[name="description"]').fill('Unsaved guard check');
  await activate(page.getByRole('radio', { name: /^Global\./ }));
  await page.getByRole('dialog', { name: 'Keep these unsaved changes?' }).waitFor();
  await activate(page.getByRole('button', { name: 'Keep editing', exact: true }));
  assert.equal(await page.getByRole('radio', { name: /^Project\./ }).getAttribute('aria-checked'), 'true',
    'the dirty persisted override refused the scope change');
  await check.shot('settings-scope-agents-draft');
  await activate(page.getByRole('radio', { name: /^Global\./ }));
  await activate(page.getByRole('button', { name: 'Discard and switch', exact: true }));
  await page.getByText('Built in', { exact: true }).waitFor();

  await activate(page.getByRole('radio', { name: /^Project\./ }));
  await choose(second);
  await activate(page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="project"]'));
  await activate(page.getByRole('button', { name: 'Delete', exact: true }));
  const deleteDialog = page.getByRole('dialog', { name: 'Delete scope-shared?' });
  await deleteDialog.waitFor();
  await activate(deleteDialog.getByRole('button', { name: 'Delete', exact: true }));
  await page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="global"]').waitFor({ state: 'attached' });
  assert.equal(existsSync(overridePath), false, 'deleting the Project shadow removed only its exact file');
  const afterDelete = (await check.rpc('agents/list', {})).agents.filter(agent => agent.name === 'scope-shared');
  assert.deepEqual(afterDelete.map(agent => agent.scope), ['global'], 'the Global source survived Project shadow deletion');
  await check.shot('settings-scope-agents');

  await check.reducedMotion(true);
  const backToAgents = page.locator('[data-slot="agents-back"]');
  if (await backToAgents.isVisible()) await activate(backToAgents);
  await activate(page.locator('[data-slot="agent-row"][data-agent="scope-shared"][data-scope="global"]'));
  const editorAnimation = await page.locator('[data-slot="agents-editor-column"]').evaluate(element =>
    getComputedStyle(element).animationName);
  assert.equal(editorAnimation, 'none', 'the Agents transition is removed under reduced motion');
  await check.shot('settings-scope-agents-reduced-motion');
  await check.reducedMotion(false);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Settings and Agents scope overflowed horizontally by ${overflow}px`);
  await check.shot('settings-scope');
}
