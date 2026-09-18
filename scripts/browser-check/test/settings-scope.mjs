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
  await page.reload({ waitUntil: 'domcontentloaded' });

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
  const globalScope = page.getByRole('tab', { name: /^Global\./ });
  await globalScope.waitFor();
  assert.equal(await globalScope.getAttribute('aria-selected'), 'true', 'Settings opens Global even while a project is open in Code');
  assert.equal(await page.getByRole('button', { name: /settings project/i }).count(), 0, 'Global has no borrowed project target');

  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  await activate(page.getByRole('tab', { name: /^Project\./ }));
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

  // Keyboard scope selection and Effective's read-only contract.
  const effective = page.getByRole('tab', { name: /^Effective\./ });
  await effective.focus();
  await effective.press('Enter');
  await page.getByText(/Resolved feature choices are read-only here/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Disable Goals', exact: true }).isDisabled(), true);

  await activate(page.getByRole('button', { name: 'Back to the session', exact: true }));
  await openSettings();
  await activate(page.getByRole('button', { name: 'Features', exact: true }));
  assert.equal(await page.getByRole('tab', { name: /^Effective\./ }).getAttribute('aria-selected'), 'true', 'scope persisted after closing Settings');
  await page.getByRole('button', { name: new RegExp(`Effective settings project:.*${basename(second)}`) }).waitFor();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Settings scope overflowed horizontally by ${overflow}px`);
  await check.shot('settings-scope');
}
