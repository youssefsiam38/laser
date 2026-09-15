/**
 * The small plumbing two feature scripts share.
 *
 * Deliberately not a framework and deliberately not imposed on the scripts
 * that came before it: a script keeps its own assertions, its own locators and
 * its own story. What lives here is the handful of things that are *the same
 * fact about the harness* — how a control is operated when the case is a touch
 * screen, what the browser says when this script has unplugged the network on
 * purpose, and the install prompt that can appear over anything.
 *
 * Nothing here registers a process, a timer or a teardown of its own: the
 * listeners belong to the page the engine already owns and tears down.
 */
import assert from 'node:assert/strict';

/** One line, single-spaced: how a person reads a surface, not how it is marked up. */
export const scrub = text => text.replace(/\s+/g, ' ').trim();

/**
 * Operate a control the way this case's pointer does.
 *
 * `activator(check)` once per script, then `activate(locator)` everywhere: a
 * touch case really taps, a pointer case really clicks, and neither forces.
 */
export const activator = check => async locator => {
  await locator.scrollIntoViewIfNeeded();
  if (check.state.touch) await locator.tap(); else await locator.click();
};

/** The app's install prompt can appear over any surface; it is not this script's subject. */
export async function dismissInstallPrompt(check) {
  const prompt = check.page.getByRole('button', { name: 'Not now', exact: true });
  await check.page.addLocatorHandler(prompt, button => button.click());
}

/** The browser's own message for a socket that cannot reach a host we unplugged. */
const DISCONNECT_NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|WebSocket connection to/;

/** One watcher per page, because the page outlives a matrix case. */
const watchers = new WeakMap();

/**
 * Console errors, and the deliberate network drop that would otherwise fill
 * them with noise.
 *
 * The two belong together: the only console errors these scripts tolerate are
 * the ones the browser prints *because* the script switched the network off,
 * so the tolerance lasts exactly as long as `offline(true)` does and a real
 * error at any other moment still fails the case.
 */
export async function watchPage(check) {
  const existing = watchers.get(check.page);
  if (existing) return existing;

  const errors = [];
  let unplugged = false;
  check.page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = scrub(message.text());
    if (unplugged && DISCONNECT_NOISE.test(text)) return;
    errors.push(text);
  });
  check.page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  // Also what lets a script read WebSocket frames; enabling it twice is a no-op.
  await check.cdp.send('Network.enable');

  const watcher = {
    errors,
    /**
     * Really unplug the network (CDP), and tolerate the noise while it is off.
     *
     * Plugging it back in does not end the tolerance: the browser prints the
     * last failed attempt after the network returns, and that message is still
     * this script's doing. {@link reconnected} ends it, once the app has said
     * it is back.
     */
    async offline(on) {
      if (on) unplugged = true;
      await check.cdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
    /** The reconnect has settled: a console error from here on is a real one. */
    reconnected() {
      unplugged = false;
    },
    assertClean() {
      assert.deepEqual(errors, [], `no console errors: ${errors.join(' | ')}`);
    },
  };
  watchers.set(check.page, watcher);
  return watcher;
}
