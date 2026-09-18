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
 */
export default async function imageAccessibility(check) {
  const { page } = check;
  await check.touch(check.state.width <= 600);
  const count = Number(process.env.UAT_IMAGES ?? 25);
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

  writeFileSync(join(check.root, `image-accessibility-${count}.json`), JSON.stringify({
    count,
    encodedFileBytes: files.reduce((sum, file) => sum + file.buffer.length, 0),
    decodedSurfaceBytes: count * 768 * 768 * 4,
    writes, events, settledAt, heapBefore, observations,
  }, null, 2));
  console.log(JSON.stringify({ count, observations }));

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
