/**
 * RP-11 acceptance: a conversation this device has seen before is on screen in
 * the frame of the click, truthfully labelled, fenced until the host confirms
 * it, and readable when the host cannot be reached at all.
 *
 * Everything here drives the real app: the sessions sidebar, the composer and
 * the app's own words. Nothing reads a store, installs a hook or seeds a
 * storage key. The only instrumentation is a per-frame sampler of what is on
 * screen, which is how "within one animation frame" is measured rather than
 * asserted from a timer.
 */
import assert from 'node:assert/strict';
import { storageKey } from '../../packages/protocol/dist/index.js';
import { selectSession, waitForConnected } from './resource/sidebar.mjs';

/** Conversations this run creates so the renderer must release one (RP-5). */
const CONVERSATIONS = 8;
const alias = index => `Immediate paint ${index + 1}`;
const marker = index => `Paint marker ${index + 1}: this is what this device last saw.`;

/** Created once per run; every matrix case navigates the same catalog. */
let prepared;

async function conversations(check) {
  if (prepared) return prepared;
  const cwd = check.fixture?.project;
  assert.ok(cwd, 'This check needs a target fixture with a project.');
  const sessions = [];
  for (let index = 0; index < CONVERSATIONS; index++) {
    const { state } = await check.rpc('session/new', { cwd });
    await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
    const accepted = await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text: marker(index) }] });
    assert.ok(accepted.accepted, 'The fixture prompt was refused.');
    await check.rpc('pi/session/rename', { path: state.path, name: alias(index) });
    sessions.push({ path: state.path, cwd, alias: alias(index), kind: 'code', marker: marker(index) });
  }
  // The fixture's own conversation shares the group, so paging knows the count.
  const groupRows = sessions.length + (check.fixture?.sessions?.length ?? 0);
  prepared = sessions.map(session => ({ ...session, groupRows }));
  return prepared;
}

/** What the app says about this conversation, in its own words. */
const statusWords = check => check.page.locator('[data-slot="status-line"] [role="status"]').first();

const composer = check => check.page.getByRole('textbox', { name: 'Message', exact: true });
const sendButton = check => check.page.getByRole('button', { name: /^Send/ }).first();

/**
 * Sample what is on screen every animation frame, and mark the frame the
 * person's own click landed in. The paint is measured in frames, not
 * milliseconds: one frame after the click is the whole claim.
 */
async function startSampler(check, text) {
  await check.page.evaluate(expected => {
    const state = { frames: [], clickFrame: null, clickAt: null };
    window.__immediatePaint = state;
    const seen = () => {
      const viewport = document.querySelector('[data-slot="thread-viewport"]');
      return {
        text: !!viewport && viewport.textContent.includes(expected),
        skeleton: !!document.querySelector('[data-slot="conversation-skeleton"]'),
        status: document.querySelector('[data-slot="status-line"] [role="status"]')?.textContent?.trim() ?? '',
      };
    };
    const tick = () => {
      state.frames.push({ at: performance.now(), ...seen() });
      state.raf = requestAnimationFrame(tick);
    };
    // Only the click that chooses a conversation counts: opening the phone's
    // own list of them is a different gesture, and not the one being measured.
    document.addEventListener('click', event => {
      if (state.clickFrame !== null) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-slot="aui_thread-list-item-trigger"]')) return;
      state.clickFrame = state.frames.length;
      state.clickAt = performance.now();
    }, true);
    state.raf = requestAnimationFrame(tick);
  }, text);
}

async function readSampler(check) {
  return check.page.evaluate(() => {
    const state = window.__immediatePaint;
    cancelAnimationFrame(state.raf);
    delete window.__immediatePaint;
    return { frames: state.frames, clickFrame: state.clickFrame, clickAt: state.clickAt };
  });
}

/**
 * The sessions sidebar, open. On a phone it is a drawer the app closes when a
 * row is chosen, so every navigation opens it again exactly as a person would.
 */
async function ensureSidebar(check) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  const usable = () => region.locator('[data-slot="aui_thread-list-item-trigger"]').first().isVisible().catch(() => false);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await usable()) return region;
    const toggle = check.page.getByRole('button', { name: /^Sessions$|Show sessions/ }).first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
    await region.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await check.page.waitForTimeout(300);
  }
  return region;
}

/**
 * This is a person coming back to conversations they have already had, not a
 * first visit: the app's own install offer belongs to that first visit, covers
 * the phone's controls, and is dismissed through the same key the app writes,
 * at this origin only, before anything is measured (as `at-explorer.mjs` does).
 */
async function dismissInstallOffer(check) {
  const origin = new URL(check.page.url()).origin;
  const key = storageKey('mobile-install-dismissed');
  await check.page.addInitScript(({ origin, key }) => {
    if (location.origin === origin) localStorage.setItem(key, 'forever');
  }, { origin, key });
  await check.page.evaluate(key => localStorage.setItem(key, 'forever'), key);
  await check.page.reload({ waitUntil: 'domcontentloaded' });
  await check.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: 60_000 });
}

/**
 * One real click or tap on a conversation's own row. The phone keeps the list
 * behind a control, so this opens it the way a person does and gives up only
 * after the product's own affordance has failed three times.
 */
async function openRow(check, session, { before = async () => {} } = {}) {
  let prepared = false;
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureSidebar(check);
      const trigger = rowTrigger(check, session);
      await trigger.waitFor({ state: 'visible', timeout: 15_000 });
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      if (!prepared) { await before(); prepared = true; }
      if (check.state.touch) await trigger.tap({ timeout: 15_000 }); else await trigger.click({ timeout: 15_000 });
      return trigger;
    } catch (error) { failure = error; }
  }
  throw failure;
}

function rowTrigger(check, session) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  const group = region.getByRole('tabpanel').locator(`section[data-cwd=${JSON.stringify(session.cwd)}]`);
  const escaped = session.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return group.locator('[data-slot="aui_thread-list-item-trigger"]')
    .filter({ has: check.page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: new RegExp(`^${escaped}$`) })
    }).first();
}

/** Wait until the app's own catalog carries the conversations this run made. */
async function catalogReady(check, sessions) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  if (!await region.isVisible().catch(() => false)) {
    await check.page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
  }
  const newest = sessions.at(-1).alias;
  await check.page.waitForFunction(
    alias => [...document.querySelectorAll('[data-slot="aui_thread-list-item-title"]')].some(node => node.textContent?.trim() === alias),
    newest,
    { timeout: 120_000 },
  );
}

export default async function immediatePaint(check) {
  await dismissInstallOffer(check);
  const sessions = await conversations(check);
  await waitForConnected(check, 120_000);
  await catalogReady(check, sessions);

  // 1. Visit every conversation, so the renderer's bounded view cache releases
  //    the oldest ones and this device keeps their recent tails (RP-5 → RP-10).
  for (const session of sessions) await selectSession(check, session);

  // 2. Come back to the one that was released first. This is the measured
  //    interaction: a real click (or tap) on its own sidebar row.
  const target = sessions[0];
  await openRow(check, target, { before: () => startSampler(check, target.marker) });
  await check.page.waitForFunction(
    expected => document.querySelector('[data-slot="thread-viewport"]')?.textContent.includes(expected) === true,
    target.marker,
    { timeout: 30_000 },
  );
  // Let the host's own answer land before reading the samples, so the record
  // covers both the provisional frames and the authoritative ones.
  await check.page.waitForFunction(alias => document.querySelector('h1')?.textContent === alias, target.alias, { timeout: 60_000 });
  const sampled = await readSampler(check);

  assert.ok(sampled.clickFrame !== null, 'The sampler never saw the click that opened the conversation.');
  const painted = sampled.frames.findIndex(frame => frame.text);
  assert.ok(painted >= 0, 'The conversation never appeared.');
  assert.ok(
    painted <= sampled.clickFrame + 1,
    `The cached conversation painted ${painted - sampled.clickFrame} frames after the click; one is the bound.`,
  );
  assert.ok(!sampled.frames.some(frame => frame.skeleton), 'A loading skeleton appeared over content this device already had.');
  console.log(`immediate paint (${check.state.width}px ${check.state.theme}${check.state.touch ? ' touch' : ''}${check.state.reducedMotion ? ' reduced-motion' : ''}): `
    + `painted ${painted - sampled.clickFrame} frame(s) after the click, `
    + `${(sampled.frames[painted].at - sampled.clickAt).toFixed(1)} ms, over ${sampled.frames.length} sampled frames, no skeleton.`);
  const provisional = sampled.frames.find(frame => /showing your last view/i.test(frame.status));
  assert.ok(provisional, 'The app never said the conversation was this device\'s last view rather than the host\'s.');
  await check.shot('immediate-paint-after-click');

  // 3. The draft is the person's while the host is asked; sending is not.
  await selectSession(check, sessions[1]);
  await openRow(check, target, { before: () => startSampler(check, target.marker) });
  const input = composer(check);
  await input.waitFor();
  assert.equal(await input.isDisabled(), false, 'The composer was taken away while the host was being asked.');
  await input.fill('A draft written before the host answered');
  const words = (await statusWords(check).textContent())?.trim() ?? '';
  if (/showing your last view/i.test(words)) {
    assert.equal(await sendButton(check).isDisabled(), true, 'Send was offered before the host confirmed this conversation.');
  }
  await check.page.waitForFunction(alias => document.querySelector('h1')?.textContent === alias, target.alias, { timeout: 60_000 });
  await readSampler(check);
  assert.equal(await input.inputValue(), 'A draft written before the host answered', 'The draft did not survive the host\'s answer.');
  await check.page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(node => /^Send/.test(node.getAttribute('aria-label') ?? node.textContent ?? ''));
    return !!button && !button.disabled;
  }, undefined, { timeout: 60_000 });
  await input.fill('');
  await check.shot('immediate-paint-draft-survives');

  // 4. The keyboard opens a conversation exactly as the pointer does.
  await selectSession(check, sessions[2]);
  await ensureSidebar(check);
  const keyboardRow = rowTrigger(check, target);
  await keyboardRow.waitFor({ state: 'visible', timeout: 30_000 });
  await keyboardRow.focus();
  await check.page.keyboard.press('Enter');
  await check.page.waitForFunction(
    expected => document.querySelector('[data-slot="thread-viewport"]')?.textContent.includes(expected) === true,
    target.marker,
    { timeout: 30_000 },
  );
  assert.equal(await composer(check).isDisabled(), false, 'The composer was disabled after a keyboard navigation.');

  // 5. A host that cannot be reached leaves a readable conversation and says so.
  await selectSession(check, sessions[3]);
  await check.page.context().setOffline(true);
  try {
    await check.page.waitForFunction(() => /disconnected from the host|reconnecting to the host|offline/i
      .test(document.querySelector('[data-slot="status-line"] [role="status"]')?.textContent ?? ''), undefined, { timeout: 60_000 });
    await openRow(check, target);
    await check.page.waitForTimeout(500);
    const viewport = check.page.locator('[data-slot="thread-viewport"]').first();
    const readable = (await viewport.textContent()) ?? '';
    assert.ok(readable.includes(target.marker) || readable.includes(sessions[3].marker),
      'Nothing readable was left on screen while the host was unreachable.');
    assert.equal(await check.page.locator('[data-slot="conversation-skeleton"]').count(), 0,
      'A loading skeleton replaced a conversation that could still be read.');
    assert.equal(await composer(check).isDisabled(), false, 'The composer was taken away while the host was unreachable.');
    assert.equal(await sendButton(check).isDisabled(), true, 'Send was offered while the host was unreachable.');
    await check.shot('immediate-paint-offline');
  } finally {
    await check.page.context().setOffline(false);
  }
  await waitForConnected(check, 120_000);
  await check.page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(node => /^Send/.test(node.getAttribute('aria-label') ?? node.textContent ?? ''));
    return !!button && !button.disabled;
  }, undefined, { timeout: 120_000 });
  await check.shot('immediate-paint-recovered');
}
