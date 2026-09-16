/**
 * RP-11 acceptance: a conversation this device has seen before is on screen in
 * the frame of the click, truthfully labelled, fenced until the host confirms
 * it, readable when the host cannot be reached at all — and replaced, once, by
 * what the host actually says, without losing the draft, the focus or the place
 * the person was reading.
 *
 * Everything here drives the real app: the sessions sidebar, the composer and
 * the app's own words. Nothing reads a store and nothing installs a hook the
 * product does not have. The only instrumentation is a per-frame sampler of
 * what is on screen, which is how "within one animation frame" is measured
 * rather than asserted from a timer.
 *
 * The mismatch is deterministic, not hoped for: after this device has cached a
 * conversation's tail, the run adds one more turn to it through the host's own
 * API, so the cached tail and the authoritative one are knowably different. The
 * network is then taken away, which holds the host's answer while the paint
 * happens, and given back, which releases it.
 */
import assert from 'node:assert/strict';
import { storageKey } from '../../packages/protocol/dist/index.js';
import { selectSession, waitForConnected } from './resource/sidebar.mjs';

/** Conversations this run creates so the renderer must release one (RP-5). */
const CONVERSATIONS = 8;
/** Turns the measured conversation carries, so its transcript really scrolls. */
const TARGET_TURNS = 10;
const alias = index => `Immediate paint ${index + 1}`;
const marker = index => `Paint marker ${index + 1}: this is what this device last saw.`;
/** The text only the host can know about: never in the cached tail. */
const authoritativeOnly = label => `Authoritative only ${label}: the host added this after the cache was written.`;

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
    const turns = index === 0 ? TARGET_TURNS : 1;
    for (let turn = 0; turn < turns; turn++) {
      const text = turn === 0 ? marker(index) : `${marker(index)} Turn ${turn + 1}.`;
      const accepted = await check.rpc('session/prompt', { path: state.path, content: [{ type: 'text', text }] });
      assert.ok(accepted.accepted, 'The fixture prompt was refused.');
    }
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
const words = async check => ((await statusWords(check).textContent()) ?? '').trim();

const composer = check => check.page.getByRole('textbox', { name: 'Message', exact: true });
const sendButton = check => check.page.getByRole('button', { name: /^Send/ }).first();
const transcriptText = async check =>
  (await check.page.locator('[data-slot="thread-viewport"]').first().textContent()) ?? '';

const sendEnabled = check => check.page.waitForFunction(() => {
  const button = [...document.querySelectorAll('button')].find(node => /^Send/.test(node.getAttribute('aria-label') ?? node.textContent ?? ''));
  return !!button && !button.disabled;
}, undefined, { timeout: 120_000 });

const waitForTranscript = (check, text, timeout = 60_000) => check.page.waitForFunction(
  expected => document.querySelector('[data-slot="thread-viewport"]')?.textContent.includes(expected) === true,
  text,
  { timeout },
);

/**
 * Where the person is reading: the first message the viewport actually shows,
 * how far down it sits, and the scroll offset itself.
 */
const readingPlace = check => check.page.evaluate(() => {
  const viewport = document.querySelector('[data-slot="thread-viewport"]');
  if (!viewport) return null;
  const top = viewport.getBoundingClientRect().top;
  const rows = [...document.querySelectorAll('[data-message-id]')];
  const visible = rows.find(row => row.getBoundingClientRect().bottom > top + 8);
  return visible
    ? { id: visible.getAttribute('data-message-id'), offset: visible.getBoundingClientRect().top - top, scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
    : null;
});

/**
 * Bring the newest turn into view and prove it is there.
 *
 * The transcript is windowed: a row the person has scrolled away from is not
 * in the DOM at all, so "the host's newest turn is on screen" is only a
 * question that can be asked at the live edge. The app's own "Jump to latest"
 * is how a person gets there; a wheel is the fallback when it is not offered.
 */
async function showLatest(check, text) {
  const jump = check.page.getByRole('button', { name: /jump to latest/i }).first();
  if (await jump.isVisible().catch(() => false)) {
    if (check.state.touch) await jump.tap().catch(() => {}); else await jump.click().catch(() => {});
  } else {
    const viewport = check.page.locator('[data-slot="thread-viewport"]').first();
    const box = await viewport.boundingBox();
    if (box) {
      await check.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 12; step++) { await check.page.mouse.wheel(0, 400); await check.page.waitForTimeout(50); }
    }
  }
  await waitForTranscript(check, text);
}

/**
 * One real finger drag from `from` to `to`, through the browser's own touch
 * events: Playwright's touchscreen can tap and nothing else, so the gesture is
 * driven with CDP's input domain, which is the same path a tap takes. Dragging
 * down the screen scrolls the conversation back; dragging up moves it on.
 */
async function drag(check, x, from, to) {
  const session = await check.page.context().newCDPSession(check.page);
  try {
    const point = y => ({ x, y, radiusX: 8, radiusY: 8, force: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from + ((to - from) * step) / steps)] });
      await check.page.waitForTimeout(16);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Read back up the transcript: a real wheel with a pointer, a real drag with a finger. */
async function scrollUp(check) {
  const viewport = check.page.locator('[data-slot="thread-viewport"]').first();
  const box = await viewport.boundingBox();
  assert.ok(box, 'The transcript viewport has no box to scroll.');
  const start = await readingPlace(check);
  assert.ok(start, 'The transcript showed no message to scroll.');
  const range = start.scrollHeight - start.clientHeight;
  assert.ok(range > 200, `The transcript does not scroll (${range}px of range); this check needs a conversation that does.`);
  // Back up about a third of the way: far enough to leave the live edge, never
  // so far that it lands on the top and has nothing above it.
  const distance = Math.max(160, Math.floor(range / 3));
  if (check.state.touch) {
    // A finger, because that is how this person reads: real touch drags down
    // the page, which is what tells the transcript they have left the live edge
    // on a phone. A drag carries momentum, so each one is measured rather than
    // counted out in advance: enough to leave the edge, never so far that the
    // conversation has nothing above it.
    const x = Math.round(box.x + box.width / 2);
    const near = Math.round(box.y + box.height * 0.3);
    const far = Math.round(box.y + box.height * 0.75);
    for (let stroke = 0; stroke < 8; stroke++) {
      const place = await readingPlace(check);
      if (!place) break;
      const edge = place.scrollHeight - place.clientHeight - place.scrollTop;
      if (edge >= Math.min(distance, 240)) break;
      if (place.scrollTop <= 0) break;
      await drag(check, x, near, far);
      await check.page.waitForTimeout(200);
    }
    // A fling that carried all the way to the top: come back down a little, so
    // the person is reading the conversation rather than its beginning.
    for (let stroke = 0; stroke < 4; stroke++) {
      const place = await readingPlace(check);
      if (!place || place.scrollTop > 0) break;
      await drag(check, x, far, near);
      await check.page.waitForTimeout(200);
    }
  } else {
    await check.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let moved = 0; moved < distance; moved += 240) {
      await check.page.mouse.wheel(0, -240);
      await check.page.waitForTimeout(60);
    }
  }
  await check.page.waitForTimeout(250);
  const place = await readingPlace(check);
  assert.ok(place && place.scrollTop > 0, 'The transcript did not scroll away from the top.');
  assert.ok(place.scrollTop < place.scrollHeight - place.clientHeight - 8,
    'The transcript is still pinned to the live edge after scrolling back.');
}

/**
 * Sample what is on screen every animation frame, and mark the frame the
 * person's own click landed in. The paint is measured in frames, not
 * milliseconds: the **first** frame after the click is the whole claim.
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
      // The frames already sampled; the next one is the first after the click.
      state.clickFrame = state.frames.length;
      state.clickAt = performance.now();
    }, true);
    state.raf = requestAnimationFrame(tick);
  }, text);
}

async function readSampler(check) {
  return check.page.evaluate(() => {
    const state = window.__immediatePaint;
    if (!state) return null;
    cancelAnimationFrame(state.raf);
    delete window.__immediatePaint;
    return { frames: state.frames, clickFrame: state.clickFrame, clickAt: state.clickAt };
  });
}

/**
 * The bound, and the words. `clickFrame` is the count of frames sampled before
 * the click, so the first frame sampled after it is exactly `clickFrame`:
 * anything later is a frame the person waited.
 */
function assertPaintedInOneFrame(check, sampled, label) {
  assert.ok(sampled, 'The sampler was never installed.');
  assert.ok(sampled.clickFrame !== null, 'The sampler never saw the click that chose the conversation.');
  const painted = sampled.frames.findIndex(frame => frame.text);
  assert.ok(painted >= 0, 'The conversation this device had cached never appeared.');
  assert.ok(
    painted <= sampled.clickFrame,
    `The cached conversation painted ${painted - sampled.clickFrame} frame(s) after the click; the first frame after it is the bound.`,
  );
  assert.ok(!sampled.frames.some(frame => frame.skeleton), 'A loading skeleton appeared over content this device already had.');
  const said = sampled.frames.map(frame => frame.status);
  assert.ok(
    said.some(status => /showing your last view/i.test(status)),
    `The app never said the conversation was this device's last view rather than the host's; it said: ${JSON.stringify([...new Set(said)])}`,
  );
  console.log(`immediate paint (${label}): painted ${painted - sampled.clickFrame} frame(s) after the click, `
    + `${(sampled.frames[painted].at - sampled.clickAt).toFixed(1)} ms, over ${sampled.frames.length} sampled frames, no skeleton.`);
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
  await composer(check).waitFor({ timeout: 60_000 });
}

/**
 * One real click or tap on a conversation's own row. The phone keeps the list
 * behind a control, so this opens it the way a person does and gives up only
 * after the product's own affordance has failed three times.
 */
async function openRow(check, session, { before = async () => {} } = {}) {
  let ready = false;
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureSidebar(check);
      const trigger = rowTrigger(check, session);
      await trigger.waitFor({ state: 'visible', timeout: 15_000 });
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      if (!ready) { await before(); ready = true; }
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
  await ensureSidebar(check);
  const newest = sessions.at(-1).alias;
  await check.page.waitForFunction(
    alias => [...document.querySelectorAll('[data-slot="aui_thread-list-item-title"]')].some(node => node.textContent?.trim() === alias),
    newest,
    { timeout: 120_000 },
  );
}

export default async function immediatePaint(check) {
  const label = `${check.state.width}px ${check.state.theme}${check.state.touch ? ' touch' : ''}${check.state.reducedMotion ? ' reduced-motion' : ''}`;
  await dismissInstallOffer(check);
  const sessions = await conversations(check);
  await waitForConnected(check, 120_000);
  await catalogReady(check, sessions);
  const target = sessions[0];

  // 1. Visit every conversation, so the renderer's bounded view cache releases
  //    the oldest ones and this device keeps their recent tails (RP-5 → RP-10).
  for (const session of sessions) await selectSession(check, session);

  // 2. The host, and only the host, learns one more turn of the target. What
  //    this device holds is now knowably behind: a replacement, not a delta
  //    this run could confuse with one.
  const fresh = authoritativeOnly(label);
  const accepted = await check.rpc('session/prompt', { path: target.path, content: [{ type: 'text', text: fresh }] });
  assert.ok(accepted.accepted, 'The host refused the authoritative-only turn.');

  // 3. Take the network away, so the app cannot reach its host at all, and come
  //    back to the target. The paint is this device's, and nothing else's.
  await check.page.context().setOffline(true);
  let sampled;
  let before;
  try {
    await check.page.waitForFunction(() => /disconnected from the host|reconnecting to the host|offline/i
      .test(document.querySelector('[data-slot="status-line"] [role="status"]')?.textContent ?? ''), undefined, { timeout: 60_000 });
    await openRow(check, target, { before: () => startSampler(check, target.marker) });
    await waitForTranscript(check, target.marker, 30_000);
    sampled = await readSampler(check);

    const offline = await transcriptText(check);
    assert.ok(offline.includes(target.marker), 'The conversation that was chosen is not the one on screen while the host is unreachable.');
    assert.ok(!offline.includes(sessions[sessions.length - 1].marker), 'The conversation left behind is still on screen instead of the chosen one.');
    assert.ok(!offline.includes(fresh), 'The host was unreachable, yet its newest turn is on screen.');
    assert.match(await words(check), /offline · showing your last view/i);
    assert.equal(await check.page.locator('[data-slot="conversation-skeleton"]').count(), 0,
      'A loading skeleton replaced a conversation that could still be read.');
    assert.equal(await composer(check).isDisabled(), false, 'The composer was taken away while the host was unreachable.');
    assert.equal(await sendButton(check).isDisabled(), true, 'Send was offered while the host was unreachable.');
    await check.shot('immediate-paint-offline');

    // The person reads back up the page — with a real wheel, which is what
    // tells the transcript they are no longer following the live edge — writes
    // a message, and leaves the cursor in the composer.
    await scrollUp(check);
    await composer(check).fill('A draft written before the host answered');
    await composer(check).focus();
    await check.page.waitForTimeout(150);
    // Read the place while the host still cannot answer: after this the
    // replacement may land at any moment.
    before = await readingPlace(check);
  } finally {
    await check.page.context().setOffline(false);
  }
  assertPaintedInOneFrame(check, sampled, label);
  assert.ok(before, 'The transcript showed no message to read.');

  // 4. Give the network back: the host's answer is released, and it disagrees
  //    with what this device painted. One atomic replacement follows.
  await waitForConnected(check, 120_000);
  // Authority is the app's own state, not a title and not a row that happens to
  // be rendered: sending is fenced until the host has confirmed this
  // conversation, so an enabled Send is the observable that it has.
  await sendEnabled(check);
  assert.equal(await check.page.locator('[data-slot="conversation-skeleton"]').count(), 0,
    'A skeleton appeared while the host\'s answer replaced what this device had.');

  // What the person kept through the replacement: their words, their focus,
  // and the place they were reading.
  assert.equal(await composer(check).inputValue(), 'A draft written before the host answered',
    'The draft did not survive the replacement.');
  assert.equal(
    await check.page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null),
    'Message',
    'Focus did not survive the replacement.',
  );
  const after = await readingPlace(check);
  assert.ok(after, 'The transcript showed no message after the replacement.');
  console.log(`reading place (${label}): ${before.id} at ${Math.round(before.offset)}px, scroll ${Math.round(before.scrollTop)} → ${Math.round(after.scrollTop)} of ${Math.round(after.scrollHeight - after.clientHeight)}.`);
  assert.equal(after.id, before.id, 'The message the person was reading is not the one on screen after the replacement.');
  assert.ok(Math.abs(after.offset - before.offset) <= 80,
    `The message the person was reading moved ${Math.round(after.offset - before.offset)}px through the replacement.`);
  assert.ok(after.scrollTop > 0, 'The transcript jumped back to the top through the replacement.');
  assert.ok(after.scrollTop < after.scrollHeight - after.clientHeight - 8,
    'The transcript jumped to the live edge through the replacement, losing where the person was reading.');
  await check.shot('immediate-paint-replaced');

  // And what replaced the cached tail really is the host's: the turn only the
  // host knew about is there, at the live edge the person can go back to.
  await showLatest(check, fresh);

  // 5. The keyboard opens a conversation exactly as the pointer does, and the
  //    composer stays the person's there too.
  await composer(check).fill('');
  await selectSession(check, sessions[2]);
  await ensureSidebar(check);
  const keyboardRow = rowTrigger(check, target);
  await keyboardRow.waitFor({ state: 'visible', timeout: 30_000 });
  await keyboardRow.focus();
  await check.page.keyboard.press('Enter');
  await waitForTranscript(check, target.marker, 30_000);
  assert.equal(await composer(check).isDisabled(), false, 'The composer was disabled after a keyboard navigation.');
  await sendEnabled(check);
  await showLatest(check, fresh);
  await check.shot('immediate-paint-recovered');
}
