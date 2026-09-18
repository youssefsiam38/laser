import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { syntheticPng } from '../resource/fixtures.mjs';
import { dismissInstallPrompt, scrub, watchPage } from './support.mjs';

/**
 * Every image a person asked for stays reachable (M16-T82), against a real
 * host, through the real composer.
 *
 * Before this, a prompt carrying more pictures than the window may decode at
 * once left the extra ones permanently disabled: the admission limit answered
 * "no" and the row turned that into a failure it never came back from. The
 * twenty-fifth image of a twenty-five-image prompt sat in the middle of the
 * viewport saying "Image not kept in this window", after settlement and after
 * reload, and could not be opened.
 *
 * What this proves, and no unit test can:
 *
 *  1. The prompt really goes through the composer, with its caption, and the
 *     turn really settles — the assertions wait for `agent_settled` and for
 *     the body/history reads to go quiet, not for a timer.
 *  2. Every picture in the viewport decodes at its exact size, both after
 *     settlement and after a reload.
 *  3. The requested image — scrolled into view, the one furthest from the
 *     start — is never disabled, and opening it shows the actual picture.
 *  4. The caption survives all of it.
 *
 * `UAT_IMAGES` sets the size of the prompt: 24 is the old admission ceiling,
 * 25 is the reported defect, 40 is well past it.
 *
 * `UAT_IMAGE_FAILURE=1` runs one more phase, for the one state the product
 * cannot reach on its own: a picture whose bytes come back wrong. The reply for
 * the last image is rewritten in the page, so the row renders its real failure
 * tile — which must fit inside a 112 px tile at a phone width, in both themes,
 * carry its sentence under the grid, and recover when the person retries.
 */
export default async function imageAccessibility(check) {
  const { page } = check;
  await check.touch(check.state.width <= 600);
  const count = Number(process.env.UAT_IMAGES ?? 25);
  const failureLane = process.env.UAT_IMAGE_FAILURE === '1';
  const caption = `Image acceptance: ${count} requested images remain accessible.`;
  const files = Array.from({ length: count }, (_, index) => ({
    name: `image-${index + 1}.png`, mimeType: 'image/png', buffer: syntheticPng(768, index + 1),
  }));
  const watch = await watchPage(check);
  const writes = [], events = [], observations = [];
  const pending = new Set();
  let settledAt, settle, lastBodyActivity = Date.now();
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const request = JSON.parse(String(payload));
        if (['session/entries', 'session/entry_range', 'session/revision'].includes(request.method)) {
          pending.add(request.id); lastBodyActivity = Date.now();
        }
        if (request.method === 'session/prompt') writes.push({
          images: request.params.content.filter(part => part.type === 'image').length,
          imageDataBytes: request.params.content.filter(part => part.type === 'image').map(part => part.data?.length ?? 0),
          text: request.params.content.filter(part => part.type === 'text').map(part => part.text).join(''),
        });
      } catch {}
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (pending.delete(message.id)) lastBodyActivity = Date.now();
        const kind = message.params?.update?.kind;
        if (kind) events.push({ kind, at: Date.now() });
        if (writes.length && kind === 'agent_settled') { settledAt = Date.now(); settle?.(); }
      } catch {}
    });
  });

  /** Reads are finished, not merely started: no RPC in flight and none recent. */
  const quiet = async () => {
    lastBodyActivity = Date.now();
    const deadline = Date.now() + 15000;
    while (pending.size || Date.now() - lastBodyActivity < 300) {
      assert.ok(Date.now() < deadline, 'body/history reads must settle');
      await page.waitForTimeout(25);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };

  /** A diagnostic, not a gate: what the renderer's own heap is doing. */
  const heap = () => page.evaluate(() => {
    const measure = performance.memory;
    return measure ? { usedJSHeapSize: measure.usedJSHeapSize, totalJSHeapSize: measure.totalJSHeapSize } : null;
  });

  // A conversation cannot corrupt its own image on request, so the lane does:
  // one reply, rewritten where it arrives, is the only way to see the tile a
  // person sees when bytes come back that are not the picture.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__corruptImage = Number(localStorage.getItem('uat-corrupt-image') ?? '-1');
    const rewrite = (text) => {
      if (window.__corruptImage < 0) return undefined;
      let message;
      try { message = JSON.parse(text); } catch { return undefined; }
      const result = message?.result;
      if (!result || result.component?.kind !== 'image' || result.component?.index !== window.__corruptImage) return undefined;
      if (typeof result.text !== 'string' || result.text.length === 0) return undefined;
      // Valid base64, different bytes: the whole-image digest refuses it.
      result.text = result.text.startsWith('Q') ? `R${result.text.slice(1)}` : `Q${result.text.slice(1)}`;
      return JSON.stringify(message);
    };
    class Rewritten extends Native {
      set onmessage(handler) {
        super.onmessage = handler
          ? (event) => {
              const changed = typeof event.data === 'string' ? rewrite(event.data) : undefined;
              handler(changed === undefined ? event : new MessageEvent('message', { data: changed }));
            }
          : handler;
      }
      get onmessage() { return super.onmessage; }
    }
    window.WebSocket = Rewritten;
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  await dismissInstallPrompt(check);
  const heapBefore = await heap();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Attach file', exact: true }).click(),
  ]);
  await chooser.setFiles(files);
  await composer.fill(caption);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await new Promise((resolve, reject) => {
    if (settledAt) { resolve(); return; }
    const timeout = setTimeout(() => reject(new Error('No actual agent_settled event after send')), 120000);
    settle = () => { clearTimeout(timeout); resolve(); };
  });
  assert.equal(writes.at(-1)?.images, count, 'the prompt carried every image');
  assert.ok(writes.at(-1).imageDataBytes.every(size => size > 0), 'every image was sent with its bytes');

  const row = page.locator('[data-role="user"]').filter({ hasText: caption }).last();
  const observe = async phase => {
    await row.waitFor();
    const requested = row.getByRole('button', { name: `Open Image ${count}`, exact: true });
    // Into the middle of the reading area, not merely "in view": at the bottom
    // edge the live-edge pill sits over it, which is not what a person
    // requesting an image is looking at.
    const centre = async locator => { await locator.evaluate(node => node.scrollIntoView({ block: 'center' })); };
    await centre(requested);
    await quiet();
    // Decoding is the readiness signal, not the presence of a URL.
    await row.locator('[data-slot="message-image"]').evaluateAll(images => Promise.allSettled(images.map(image => image.decode())));
    const result = await row.evaluate((node, size) => {
      const pictures = [...node.querySelectorAll('[data-slot="message-image"]')];
      // What a person can actually see: inside the window, and the thing
      // painted at its own middle — not clipped away by the transcript's
      // scroller or covered by the composer.
      const seen = element => {
        const box = element.getBoundingClientRect();
        if (!(box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth)) return false;
        const x = Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1);
        const y = Math.min(Math.max(box.top + box.height / 2, 1), window.innerHeight - 1);
        const painted = document.elementFromPoint(x, y);
        return Boolean(painted && element.contains(painted));
      };
      const tiles = [...node.querySelectorAll('[data-slot="message-image-tile"]')];
      return {
        caption: node.textContent.includes('requested images remain accessible.'),
        tiles: tiles.length,
        pictures: pictures.length,
        decoded: pictures.filter(image => image.complete && image.naturalWidth === size && image.naturalHeight === size).length,
        visibleTiles: tiles.filter(seen).length,
        visibleDecoded: tiles.filter(seen).filter(tile => {
          const image = tile.querySelector('[data-slot="message-image"]');
          return image && image.complete && image.naturalWidth === size && image.naturalHeight === size;
        }).length,
        // What the window is not holding decoded right now, and where it is:
        // the residue policy is only meaningful next to these two numbers.
        waiting: tiles.filter(tile => !tile.querySelector('[data-slot="message-image"]')).length,
        waitingVisible: tiles.filter(seen).filter(tile => !tile.querySelector('[data-slot="message-image"]')).length,
        offscreenDecoded: tiles.filter(tile => !seen(tile)).filter(tile => tile.querySelector('[data-slot="message-image"]')).length,
        placeholders: [...node.querySelectorAll('[data-slot="message-image-placeholder"]')].map(item => item.textContent),
      };
    }, 768);
    result.requestedDisabled = await requested.isDisabled();
    result.requestedBounds = await requested.boundingBox();
    result.phase = phase;
    result.heap = await heap();

    // A picture this window has not decoded is off screen, not lost: scrolling
    // to it is all it takes. This is the state the defect made permanent.
    result.waitingIndex = await row.evaluate(node =>
      [...node.querySelectorAll('[data-slot="message-image-tile"]')].findIndex(tile => tile.querySelector('[data-slot="message-image-placeholder"]')));
    if (result.waitingIndex >= 0) {
      const tile = row.locator('[data-slot="message-image-tile"]').nth(result.waitingIndex);
      await centre(tile);
      await quiet();
      result.waitingDecoded = await tile.evaluate(async (node, size) => {
        const image = node.querySelector('[data-slot="message-image"]');
        if (!image) return false;
        await image.decode().catch(() => {});
        return image.complete && image.naturalWidth === size && image.naturalHeight === size;
      }, 768);
      await check.shot(`image-recovered-${phase}`);
      await centre(requested);
      await quiet();
    }
    if (!result.requestedDisabled) {
      // This case's own pointer once, keyboard once: both paths reach the
      // same viewer, and a touch case really taps.
      if (phase === 'settled') { if (check.state.touch) await requested.tap(); else await requested.click(); }
      else { await requested.focus(); await page.keyboard.press('Enter'); }
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const picture = dialog.locator('img').first();
      await picture.waitFor();
      result.opened = await picture.evaluate(async img => { await img.decode(); return img.naturalWidth === 768 && img.naturalHeight === 768; });
      await check.shot(`image-opened-${phase}`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    }
    await check.shot(`image-visible-${phase}`);
    observations.push(result);
  };

  await observe('settled');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  await observe('reopened');
  // The one state the conversation cannot reach on its own.
  const failure = failureLane ? await failureTile(check, { count, caption, composer, quiet }) : undefined;

  writeFileSync(join(check.root, `image-accessibility-${count}.json`), JSON.stringify({
    count,
    encodedFileBytes: files.reduce((sum, file) => sum + file.buffer.length, 0),
    decodedSurfaceBytes: count * 768 * 768 * 4,
    writes, events, settledAt, heapBefore, observations, failure,
  }, null, 2));
  console.log(JSON.stringify({ count, observations, failure }));

  for (const result of observations) {
    assert.equal(result.caption, true, `${result.phase}: the caption stays visible`);
    assert.equal(result.tiles, count, `${result.phase}: every image keeps its place in the row (${result.tiles}/${count})`);
    assert.equal(result.requestedDisabled, false, `${result.phase}: the requested visible image cannot be disabled`);
    assert.equal(result.opened, true, `${result.phase}: the requested image opens and decodes at its own size`);
    // Everything a person can actually see is a picture, not a placeholder.
    // What is off screen may legitimately be waiting for its turn; what is on
    // screen may not.
    assert.equal(result.visibleDecoded, result.visibleTiles,
      `${result.phase}: every image in the viewport decoded (${result.visibleDecoded}/${result.visibleTiles})`);
    assert.ok(result.decoded >= result.visibleTiles,
      `${result.phase}: at least what is on screen is decoded (${result.decoded} of ${count})`);
    for (const placeholder of result.placeholders) {
      assert.doesNotMatch(scrub(placeholder), /not kept|failed|error|could not/i,
        `${result.phase}: no permanent unavailable placeholder (${placeholder})`);
    }
    if (result.waitingIndex >= 0) {
      assert.equal(result.waitingDecoded, true,
        `${result.phase}: image ${result.waitingIndex + 1} decoded once it was scrolled into view`);
    }
  }

  await watch.assertClean();
}

/**
 * The tile a person sees when an image's bytes really are wrong.
 *
 * A multi-image tile is 112 px. A failure there shows the icon and the way out
 * of it; the sentence that explains it belongs under the grid, where there is
 * room for it. This phase proves the tile fits its own content at the width
 * this case is running at, that the sentence is on screen, and that trying
 * again actually brings the picture back.
 */
async function failureTile(check, { count, caption, composer, quiet }) {
  const { page } = check;
  await page.evaluate(index => localStorage.setItem('uat-corrupt-image', String(index)), count - 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  const row = page.locator('[data-role="user"]').filter({ hasText: caption }).last();
  await row.waitFor();
  const retry = row.getByRole('button', { name: new RegExp(`^Try image ${count} again`) });
  await retry.waitFor({ timeout: 30000 });
  await retry.scrollIntoViewIfNeeded();
  await quiet();

  const tile = row.locator('[data-slot="message-image-tile"]').nth(count - 1);
  const fit = await retry.evaluate(node => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      width: Math.round(box.width), height: Math.round(box.height),
      // A component that cannot fit its content shows less content, never
      // smaller text and never overflow.
      overflowX: node.scrollWidth - node.clientWidth,
      overflowY: node.scrollHeight - node.clientHeight,
      fontSize: style.fontSize,
      label: node.getAttribute('aria-label'),
      text: node.textContent,
    };
  });
  const problem = await row.locator('[data-slot="image-problem"]').textContent();
  const tileBox = await tile.boundingBox();
  await check.shot('image-failure');

  assert.ok(fit.overflowY <= 1, `the failure tile must not overflow its 112 px tile (${fit.overflowY} px below the fold, ${JSON.stringify(fit)})`);
  assert.ok(fit.overflowX <= 1, `the failure tile must not overflow sideways (${fit.overflowX} px, ${JSON.stringify(fit)})`);
  assert.equal(fit.text.trim(), 'Try again', 'the 112 px tile shows the way out, not a wrapped sentence');
  assert.match(scrub(fit.label), /^Try image \d+ again: .+/, 'the accessible name carries the sentence the tile has no room for');
  assert.match(scrub(problem ?? ''), new RegExp(`^Image ${count} `), 'the sentence itself is under the grid');
  assert.equal(parseFloat(fit.fontSize) >= 12, true, `data never goes below 12 px (${fit.fontSize})`);

  // Trying again is not decoration: with the bytes intact, the picture comes
  // back into the same tile.
  await page.evaluate(() => { window.__corruptImage = -1; localStorage.removeItem('uat-corrupt-image'); });
  if (check.state.touch) await retry.tap(); else await retry.click();
  const picture = tile.locator('[data-slot="message-image"]');
  await picture.waitFor({ timeout: 20000 });
  const recovered = await picture.evaluate(async (image, size) => {
    await image.decode();
    return image.naturalWidth === size && image.naturalHeight === size;
  }, 768);
  await check.shot('image-retried');
  assert.equal(recovered, true, 'the retried image comes back at its own size');
  return { phase: 'failure', fit, problem, tileBox, recovered };
}
