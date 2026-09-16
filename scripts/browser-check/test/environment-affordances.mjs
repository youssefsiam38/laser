import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { target as appTarget } from '../targets/app.mjs';
import { fixture as appFixture } from '../targets/fixtures.mjs';

/**
 * Build the long fixture with normal local authority, then restart the exact
 * same host against a narrowed `<state>/policy.json` before any page opens.
 */
export async function target(runtime) {
  let hostLaunch;
  let hostChild;
  const wrapped = {
    ...runtime,
    spawn(command, args, options = {}) {
      const child = runtime.spawn(command, args, options);
      if (options.name === 'host') { hostLaunch = { command, args, options }; hostChild = child; }
      return child;
    },
  };
  const target = await appTarget(wrapped);
  return {
    ...target,
    async theme() {
      // The isolated profile starts in follow-system mode; the harness emulates
      // each matrix color scheme without needing a denied settings mutation.
    },
    async narrow() {
      const stateDir = join(runtime.root, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'policy.json'), JSON.stringify({
        local: { scopes: ['handshake', 'read', 'diagnostics'] },
        remote: { scopes: ['handshake', 'read', 'diagnostics'] },
      }));
      if (!hostLaunch || !hostChild?.pid) throw new Error('The app target did not expose its owned host launch.');
      process.kill(-hostChild.pid, 'SIGTERM');
      await new Promise((resolve) => hostChild.once('close', resolve));
      hostChild = runtime.spawn(hostLaunch.command, hostLaunch.args, { ...hostLaunch.options, name: 'host-narrowed' });
      await runtime.until(async () => (await fetch(`${target.url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok, 'narrowed host', runtime.timeout);
    },
  };
}

export async function fixture(target, runtime, name) {
  const prepared = await appFixture(target, runtime, name);
  await target.narrow();
  return prepared;
}

/** Read-only affordances in every desktop/phone, theme, touch and motion case. */
export default async function environmentAffordances(check) {
  const { page } = check;
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), check.state.reducedMotion);
  if (check.state.touch) assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);

  await page.getByText('This conversation is read-only here', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).count(), 0, 'composer input stays hidden');
  assert.equal(await page.locator('[data-slot="new-session"], [data-slot="new-chat"]').count(), 0, 'new-session affordances stay hidden');
  await check.shot('environment-read-only-conversation');

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!await settings.isVisible()) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Beam', exact: true }).count(), 0, 'Beam affordance stays hidden');
  await settings.click();
  await page.getByRole('button', { name: 'General', exact: true }).waitFor();
  await page.getByText(/read these settings/i).first().waitFor();

  // Read navigation remains live; only mutation controls are denied.
  const search = page.getByPlaceholder('Search settings');
  await search.fill('model');
  assert.equal(await search.inputValue(), 'model');
  const enabledMutations = await page.locator('section[aria-label="Settings"] input:not([disabled]):not([placeholder="Search settings"]), section[aria-label="Settings"] select:not([disabled])').count();
  assert.equal(enabledMutations, 0, 'settings mutations stay disabled');
  await check.shot('environment-read-only-settings');
}
