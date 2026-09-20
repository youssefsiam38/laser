/**
 * M16-T95 / D-334: pressing New shows the existing project landing with an
 * enabled composer before worker/session preparation is a thing the person
 * waits on. Interaction, not a screenshot-only check.
 */
import assert from 'node:assert/strict';
import { waitForConnected } from '../resource/sidebar.mjs';
import { activator, dismissInstallPrompt, scrub } from './support.mjs';

const FORBIDDEN = /Opening conversation|Preparing workspace|loading the conversation|preparing the workspace|opening the conversation/i;

export default async function immediateNewSession(check) {
  await dismissInstallPrompt(check);
  const activate = activator(check);
  const page = check.page;
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  await waitForConnected(check, 120_000);

  const phone = check.state.width === 390;
  if (phone) {
    const sessions = page.getByRole('button', { name: 'Sessions', exact: true });
    if (await sessions.isVisible().catch(() => false)) await activate(sessions);
  }

  const headerNew = page.locator('[data-slot="new-session"]');
  const groupNew = page.getByRole('button', { name: /^New session in / });
  if (await headerNew.first().isVisible().catch(() => false)) await activate(headerNew.first());
  else await activate(groupNew.first());

  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.isDisabled(), false, 'New Session left the composer disabled.');
  const copy = scrub(await page.locator('body').innerText());
  assert.equal(FORBIDDEN.test(copy), false, `New Session showed wait copy: ${copy.slice(0, 280)}`);
  const title = scrub(await page.locator('h1').first().innerText());
  assert.equal(/Opening conversation|Preparing workspace/.test(title), false, `Top bar still waited: ${title}`);

  await activate(composer);
  await composer.fill('typed on the landing before preparation settled');
  assert.equal(await composer.inputValue(), 'typed on the landing before preparation settled');
  assert.equal(await composer.evaluate((node) => node === document.activeElement), true);

  await check.snapshot();
  await check.shot('new-session-landing');
}
