import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This device is scoped to the environment it is talking to (M18-T13 B, RP-13).
 *
 * Two things are proved here against a real host, in a real browser:
 *
 *  1. **The namespace.** After an ordinary handshake, every key this app has
 *     written is either `<prefix>-env:<the host's own opaque environment key>:
 *     <suffix>` or one of the enumerated neutral preferences. Nothing carries a
 *     path, a session id or the host's raw environment id — which this script
 *     reads from the host's own state directory so the assertion is about the
 *     real secret rather than a pattern.
 *  2. **The failure a person can get out of.** A device that already holds more
 *     keys than one purge may scan cannot be made safe, so the environment
 *     never opens: a persistent notice explains it in full, the connection line
 *     stays out of its way, nothing is read, written or resumed while it lasts,
 *     and the notice's own button clears the browser and recovers — including
 *     past the scan ceiling, which is the case that made the ceiling a bug.
 *
 * The >5,000-key device is seeded through the page, not through a shipped seam:
 * the app has no test hook for this and must not grow one.
 *
 * Environment switching and capability downgrade need a second host identity
 * mid-connection, which no production route offers; they stay covered by
 * `packages/ui/test/runtime/environment-switch.test.tsx` and
 * `device-storage.test.ts`.
 */

/** Comfortably past `MAX_SCANNED_KEYS` (5,000) without filling the quota. */
const SEEDED_LEGACY_KEYS = 5_200;

let listening = false;
let unplugged = false;
const console_ = [];
const DISCONNECT_NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|WebSocket connection to/;

const scrub = text => text.replace(/\s+/g, ' ').trim();

export default async function environmentStorage(check) {
  const { page } = check;
  const phone = check.state.width <= 600;
  const label = `${check.state.width}-${check.state.theme}`;
  await check.touch(phone);

  const { storageKey, dottedStorageKey, ENVIRONMENT_KEY_PATTERN } = await import('../../../packages/protocol/dist/index.js');
  const namespace = storageKey('env');
  const environmentPattern = new RegExp(`^${namespace}:(${ENVIRONMENT_KEY_PATTERN.source.slice(1, -1)}):([a-z-]+)$`);
  // Exactly the keys that belong to no environment (device-storage.ts), plus
  // the appearance store, which is the same kind of thing under the dotted
  // form the persisted store uses.
  const NEUTRAL = new Set([
    ...['panels', 'sessions-tab', 'setup-step', 'mobile-install-dismissed', 'mobile-notify-hint-dismissed'].map(storageKey),
    dottedStorageKey('theme'),
  ]);
  const NEUTRAL_PREFIXES = [storageKey('mobile-insecure-dismissed:')];
  const SUFFIXES = new Set([
    'destination', 'sessions', 'project', 'beam-session', 'archived', 'session-groups', 'session-pins',
    'session-folds', 'activity-detail', 'activity-disclosure', 'fleet-cleared', 'drafts', 'descriptor',
  ]);

  if (!listening) {
    listening = true;
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = scrub(message.text());
      if (unplugged && DISCONNECT_NOISE.test(text)) return;
      console_.push(text);
    });
    page.on('pageerror', error => console_.push(`pageerror: ${error.message}`));
    await check.cdp.send('Network.enable');
  }
  const activate = async locator => {
    await locator.scrollIntoViewIfNeeded();
    if (check.state.touch) await locator.tap(); else await locator.click();
  };
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  const storageState = () => page.evaluate(() => ({
    local: Object.keys(localStorage).sort(),
    session: Object.keys(sessionStorage).sort(),
    values: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key).slice(0, 400)])),
  }));

  // --------------------------------------------------- 1. the real namespace
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  const described = await check.rpc('environment/describe', {});
  const environmentKey = described.environment.environmentKey;
  assert.match(environmentKey, ENVIRONMENT_KEY_PATTERN, `the host publishes an opaque key: ${environmentKey}`);
  // The raw identity the host keeps to itself. Never a substring of anything
  // this browser stores.
  const rawEnvironmentId = JSON.parse(readFileSync(join(check.root, 'state/environment.json'), 'utf8')).id;
  assert.match(rawEnvironmentId, /^[0-9a-f-]{36}$/, 'the host minted a raw environment id');
  assert.ok(!environmentKey.includes(rawEnvironmentId), 'the public key is not the raw id');

  // A draft is the only content this device stores: type one, so the content
  // key is in the inventory rather than merely allowed by it.
  const draft = `Environment-scoped draft ${label}`;
  await composer.fill(draft);
  await page.waitForTimeout(1_000);

  const before = await storageState();
  assert.deepEqual(before.session, [], 'nothing is kept in session storage');
  /** Every key is either this environment's or an enumerated neutral preference. */
  const classify = keys => {
    const suffixes = [];
    for (const key of keys) {
      if (NEUTRAL.has(key) || NEUTRAL_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
      const match = environmentPattern.exec(key);
      assert.ok(match, `every other key is environment-scoped: ${key}`);
      assert.equal(match[1], environmentKey, `key ${key} hangs from the host's own environment key`);
      assert.ok(SUFFIXES.has(match[2]), `known suffix in ${key}`);
      suffixes.push(match[2]);
    }
    return suffixes.sort();
  };
  const namespaced = classify(before.local);
  assert.ok(namespaced.includes('descriptor'), 'the namespace records what it was written under');
  assert.ok(namespaced.includes('drafts'), `the typed draft is stored inside the namespace: ${namespaced.join(', ')}`);
  const drafts = JSON.parse(before.values[`${namespace}:${environmentKey}:drafts`]);
  assert.ok(JSON.stringify(drafts).includes(draft), 'the draft really is the one that was typed');
  // No path, no session id, no raw environment id anywhere in the key space.
  for (const key of before.local) {
    for (const [what, secret] of [['project path', check.fixture.project], ['session path', check.fixture.path], ['raw environment id', rawEnvironmentId]]) {
      assert.ok(!key.includes(secret), `no ${what} in the key namespace: ${key}`);
    }
    assert.ok(!key.includes('/'), `no path separator in a storage key: ${key}`);
  }
  // The fingerprint beside the namespace is what the environment could do and
  // keep — never the actor, the scopes or the deployment.
  const fingerprint = JSON.parse(before.values[`${namespace}:${environmentKey}:descriptor`]);
  assert.deepEqual(Object.keys(fingerprint).sort(), ['cache', 'capabilities', 'contract'], 'the fingerprint holds only what stored data derives from');
  console.log(`environment ${label}: ${environmentKey} · ${before.local.length} keys · ${namespaced.join(', ')}`);

  // ------------------------------------------ 2. a reconnect keeps the device
  const offline = async on => check.cdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const transcript = page.getByText('Checkpoint 120 is complete.', { exact: false }).first();
  await transcript.waitFor();
  unplugged = true;
  await offline(true);
  // Nothing pings the host on a timer, so the app has to talk before it can
  // find the socket gone. Advanced → Resources is the one surface that asks
  // the host on its own; opening it is a real interaction, not a poke at the
  // transport.
  if (phone) await activate(page.getByRole('button', { name: 'Sessions', exact: true }));
  await activate(page.getByRole('button', { name: 'Settings', exact: true }).first());
  await activate(page.getByRole('button', { name: 'Advanced', exact: true }));
  const strip = page.locator('[data-slot=connection-state]');
  await strip.waitFor({ timeout: 60_000 });
  assert.equal(await strip.getAttribute('data-phase'), 'dropped', 'the socket really dropped');
  // Back to the conversation, where the line is the only thing on screen
  // saying the host is gone — Settings covers it while it is open.
  await page.keyboard.press('Escape');
  await composer.waitFor();
  assert.equal(await strip.getAttribute('data-phase'), 'dropped', 'the line is still the dropped line');
  // Its one action is reachable with a thumb, and the line grew to hold it
  // rather than clipping it.
  const retry = await strip.evaluate(node => {
    const button = node.querySelector('button');
    if (!button) return undefined;
    const line = node.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return { height: Math.round(box.height), inside: box.top >= line.top - 1 && box.bottom <= line.bottom + 1, line: Math.round(line.height) };
  });
  assert.ok(retry, 'a dropped connection offers a way back');
  assert.ok(retry.inside, `the retry sits inside the line (${JSON.stringify(retry)})`);
  if (phone) assert.ok(retry.height >= 44, `the retry clears the coarse-pointer floor (${retry.height}px in a ${retry.line}px line)`);
  await check.shot(`environment-dropped-${label}`);
  await offline(false);
  await strip.waitFor({ state: 'detached', timeout: 30_000 });
  unplugged = false;
  assert.equal(await page.locator('[data-slot=environment-notice]').count(), 0, 'the same environment is not a failure');
  assert.ok(await transcript.isVisible(), 'the conversation on screen survives the reconnect');
  assert.equal(await composer.inputValue(), draft, 'so does what was being typed');
  const after = await storageState();
  // Neutral preferences may change for unrelated reasons (dismissing the
  // install prompt is one); the environment's own keys may not.
  assert.deepEqual(classify(after.local), namespaced, 'and the device keeps the same namespaced keys');

  // -------------------------- 3. a device that cannot be made safe stays shut
  // What this device holds the moment before the failure: the refused view
  // must neither read nor change a byte of it.
  const sealed = Object.fromEntries(Object.entries((await storageState()).values).filter(([key]) => key.startsWith(`${namespace}:`)));
  await page.evaluate(({ prefix, count }) => {
    for (let index = 0; index < count; index += 1) localStorage.setItem(`${prefix}${index}`, 'x');
  }, { prefix: storageKey('draft:'), count: SEEDED_LEGACY_KEYS });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const notice = page.locator('[data-slot=environment-notice]');
  await notice.waitFor();
  const noticeText = scrub(await notice.innerText());
  assert.match(noticeText, /cannot use this connection/, `the notice says what state this is: ${noticeText}`);
  assert.match(
    noticeText,
    /This browser's stored data could not be cleared of other environments, so nothing is being kept on this device\./,
    `the whole reason, not an ellipsis of it: ${noticeText}`,
  );
  assert.match(noticeText, /Nothing is being kept on this device while this lasts, and nothing on the host has changed/, `what it costs: ${noticeText}`);
  assert.match(noticeText, /Clear this browser.s data and reload/, `the way out: ${noticeText}`);
  await check.shot(`environment-notice-${label}`);

  // It wraps rather than truncating, and it is legible at this width.
  const shape = await notice.evaluate(node => {
    const paragraphs = [...node.querySelectorAll('p')].map(p => {
      const style = getComputedStyle(p);
      return {
        text: p.textContent.trim(),
        lines: Math.round(p.getBoundingClientRect().height / parseFloat(style.lineHeight)),
        clipped: style.textOverflow === 'ellipsis' || p.scrollWidth > p.clientWidth + 1,
        size: Math.round(parseFloat(style.fontSize) * 10) / 10,
        hidden: style.display === 'none' || style.visibility === 'hidden',
      };
    });
    return {
      paragraphs,
      button: node.querySelector('button').getBoundingClientRect().height,
      overflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  for (const paragraph of shape.paragraphs) {
    assert.equal(paragraph.clipped, false, `nothing in the notice is cut off: ${paragraph.text}`);
    assert.equal(paragraph.hidden, false, `nothing in the notice is hidden at this width: ${paragraph.text}`);
    assert.ok(paragraph.size >= 12, `the notice stays above the legibility floor (${paragraph.size}px)`);
  }
  assert.equal(shape.overflowsX, false, 'the notice never makes the page scroll sideways');
  if (phone) {
    const reason = shape.paragraphs.find(paragraph => paragraph.text.startsWith('This browser'));
    assert.ok(reason.lines >= 2, `on a phone the reason wraps onto ${reason.lines} lines instead of truncating`);
    assert.ok(shape.button >= 44, `the recovery clears the coarse-pointer floor (${shape.button}px)`);
  }

  // The connection line does not flicker over it while the socket retries, and
  // nothing is read, written or resumed while the environment is unresolved.
  // The namespace this device already held is closed, not reopened: no key is
  // added, none is rewritten, and the fingerprint is not renewed. The bytes
  // stay at rest until the person clears them, which is what the notice
  // offers — a refused view that silently deleted them would be deciding for
  // somebody whose environment it could not even establish.
  const heldNow = () => page.evaluate(prefix => Object.fromEntries(Object.keys(localStorage)
    .filter(key => key.startsWith(prefix))
    .map(key => [key, localStorage.getItem(key).slice(0, 400)])), `${namespace}:`);
  const baseline = await heldNow();
  assert.deepEqual(Object.keys(baseline).sort(), Object.keys(sealed).sort(), 'the refused view neither adds nor removes an environment key');
  for (let sample = 0; sample < 20; sample += 1) {
    assert.equal(await strip.count(), 0, 'the reconnect line stays out of the notice’s way');
    assert.deepEqual(await heldNow(), baseline, 'nothing in the environment namespace is written or renewed while the environment is refused');
    await page.waitForTimeout(250);
  }
  assert.equal(await composer.count(), 0, 'no session is resumed behind the notice');
  assert.equal(await page.getByText('Checkpoint 120 is complete.', { exact: false }).count(), 0, 'no conversation content is read back');

  // The recovery works past the ceiling that caused the failure.
  await activate(notice.getByRole('button', { name: /Clear this browser/ }));
  await composer.waitFor({ timeout: 60_000 });
  const recovered = await storageState();
  assert.equal(recovered.local.filter(key => key.startsWith(storageKey('draft:'))).length, 0, 'the seeded legacy keys are gone');
  assert.ok(recovered.local.length < 50, `the browser really was cleared (${recovered.local.length} keys left)`);
  assert.ok(
    recovered.local.some(key => key.startsWith(`${namespace}:${environmentKey}:`)),
    `the environment opens again after the clear: ${recovered.local.join(', ')}`,
  );
  assert.equal(await page.locator('[data-slot=environment-notice]').count(), 0, 'and the notice is gone');
  await check.shot(`environment-recovered-${label}`);

  assert.deepEqual(console_, [], `no console errors: ${console_.join(' | ')}`);
}
