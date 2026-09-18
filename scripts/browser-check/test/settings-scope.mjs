import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

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
  const first = join(check.root, 'settings-scope-project-one');
  const second = join(check.root, 'settings-scope-project-two');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  for (const cwd of [first, second]) {
    await check.rpc('pi/project/add', { cwd });
    await check.rpc('pi/project/trust', { cwd, trusted: true, remember: true });
  }
  // Distinct resolved values make an out-of-order response visible: the old
  // project's Goals card is Off, while the selected project's card is On.
  await check.rpc('feature/set', { id: 'goals', enabled: false, scope: 'project', cwd: first });
  await check.rpc('feature/set', { id: 'goals', enabled: true, scope: 'project', cwd: second });

  // Script-local transport fault: delay only one feature/list answer. The app
  // still uses its real socket, host and payload; no common fixture is edited.
  await page.addInitScript(() => {
    if (window.__settingsScopeDelayInstalled) return;
    window.__settingsScopeDelayInstalled = true;
    window.__settingsScopeDelay = null;
    window.__settingsScopeFailSetup = localStorage.getItem('__settings-scope-fail-setup') === '1';
    window.__settingsScopeFailedSetupRequests = 0;
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
    await activate(page.getByRole('button', { name: /Project settings target:/ }));
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

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Settings scope overflowed horizontally by ${overflow}px`);
  await check.shot('settings-scope');
}
