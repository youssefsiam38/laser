#!/usr/bin/env node
/**
 * Same-image instrumentation diagnostic for the RP-2 soak.
 *
 * The full soak's renderer crossed the unchanged 1.5 GiB per-process ceiling in
 * the phase that renders the fixture's twelve 2048px images, while its memory
 * dump was collected by tracing the whole workload at the detailed level of
 * detail. This runs that identical image payload three ways — no tracing at
 * all, the corrected bounded dump, and the old always-on detailed trace — and
 * reports each renderer's own PSS. Fixture and ceiling are untouched; only the
 * measurement varies, which is the whole point.
 *
 *   node scripts/browser-check/resource-image-diagnostic.mjs [--artifacts DIR]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lifecycle, isolatedEnvironment, freePort, until } from './lifecycle.mjs';
import { resolvePlaywright } from './browser.mjs';
import { modeConfig, SAFETY } from './resource/config.mjs';
import { imagePayload } from './resource/fixtures.mjs';
import { processSample } from './resource/process-sampler.mjs';
import { dumpAllocators, aggregate } from './resource/memory-infra.mjs';
import { descendantPids } from './resource/inspector.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The soak's own image workload: decode every image, open one, decode again. */
async function imageWorkload(page) {
  const images = page.locator('[data-slot="message-image"]');
  await images.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
  await images.first().click();
  await page.keyboard.press('Escape');
  await images.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
}

/** PSS of every Chrome process in the launched tree, largest first. */
async function treeSample(rootPid) {
  const rows = [];
  for (const pid of await descendantPids(rootPid)) {
    try { rows.push(await processSample(pid)); } catch {}
  }
  rows.sort((a, b) => (b.pssBytes ?? 0) - (a.pssBytes ?? 0));
  return { processCount: rows.length, totalPssBytes: rows.reduce((sum, row) => sum + (row.pssBytes ?? 0), 0),
    largestPssBytes: rows[0]?.pssBytes ?? null, largestPrivateResidentBytes: rows[0]?.privateResidentBytes ?? null };
}

async function runVariant(name, { page: pageDir, config }) {
  const root = mkdtempSync(join(tmpdir(), `resource-image-${name}-`));
  const env = isolatedEnvironment(root);
  for (const path of ['home', 'tmp', 'config', 'data', 'cache', 'state', 'runtime', 'logs']) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  const life = lifecycle(root, env);
  let survivors = [];
  try {
    const resolved = await resolvePlaywright();
    const executable = ['/usr/bin/google-chrome', '/usr/bin/chromium', resolved.chromium.executablePath()].find(Boolean);
    const port = await freePort();
    const chrome = life.spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(root, 'chrome-profile')}`, 'about:blank'], { name: 'chrome', env });
    await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok, 'Chrome debugging endpoint', 30_000);
    const browser = await resolved.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 60_000 });
    for (const existing of browser.contexts()) for (const blank of existing.pages()) await blank.close();
    const browserCdp = await browser.newBrowserCDPSession();
    const context = await browser.newContext();
    const page = await context.newPage();

    const before = await treeSample(chrome.pid);
    let allocators = null;
    if (name === 'detailed-around-workload') {
      // Exactly what the harness used to do: trace the whole workload at the
      // detailed level, then dump.
      let resolveComplete;
      const completed = new Promise(done => { resolveComplete = done; });
      browserCdp.once('Tracing.tracingComplete', resolveComplete);
      await browserCdp.send('Tracing.start', { categories: 'disabled-by-default-memory-infra', transferMode: 'ReturnAsStream' });
      await page.goto(pathToFileURL(join(pageDir, 'index.html')).href, { waitUntil: 'load' });
      await imageWorkload(page);
      await browserCdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
      await browserCdp.send('Tracing.end');
      const { stream } = await completed;
      let text = '';
      let truncated = false;
      while (true) {
        const part = await browserCdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
        text += part.data;
        if (Buffer.byteLength(text) > 64 * 1024 * 1024) { truncated = true; break; }
        if (part.eof) break;
      }
      await browserCdp.send('IO.close', { handle: stream }).catch(() => {});
      allocators = truncated
        ? { available: false, reason: 'memory trace exceeded 67108864 bytes', owners: 0, traceBytes: Buffer.byteLength(text) }
        : { available: true, owners: aggregate(JSON.parse(text)).length, traceBytes: Buffer.byteLength(text) };
    } else {
      await page.goto(pathToFileURL(join(pageDir, 'index.html')).href, { waitUntil: 'load' });
      await imageWorkload(page);
      if (name === 'corrected-bounded-dump') {
        const dump = await dumpAllocators(browserCdp, { timeoutMs: 60_000 });
        allocators = { available: dump.available, owners: dump.allocators.length, traceBytes: dump.traceBytes ?? null,
          levelOfDetail: dump.levelOfDetail ?? null, attempts: dump.attempts, top: dump.allocators.slice(0, 8) };
      }
    }
    await sleep(1_000);
    const after = await treeSample(chrome.pid);
    await page.close();
    await context.close();
    await browser.close().catch(() => {});
    return { variant: name, images: config.images, imageSide: config.imageSide, before, after, allocators,
      crossesProcessCeiling: (after.largestPssBytes ?? 0) > SAFETY.processPssBytes, ceilingBytes: SAFETY.processPssBytes };
  } finally {
    survivors = await life.close();
    await rm(root, { recursive: true, force: true });
    if (survivors.length) throw new Error(`${name} left ${survivors.length} Chrome processes running`);
  }
}

async function imagePage(config) {
  const dir = mkdtempSync(join(tmpdir(), 'resource-image-page-'));
  const images = imagePayload(config);
  const files = [];
  for (const image of images) {
    const name = `image-${image.index}.png`;
    await writeFile(join(dir, name), image.bytes, { mode: 0o600 });
    files.push(name);
  }
  const body = files.map(name => `<img data-slot="message-image" src="${name}" width="640">`).join('\n');
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>image diagnostic</title><body>${body}</body>`, { mode: 0o600 });
  return { dir, logicalBytes: images.reduce((sum, image) => sum + image.logicalBytes, 0), encodedBytes: images.reduce((sum, image) => sum + image.bytes.length, 0) };
}

export async function runImageDiagnostic({ artifacts = '/tmp/resource-image-diagnostic', variants = ['no-tracing', 'corrected-bounded-dump', 'detailed-around-workload'] } = {}) {
  if (process.platform !== 'linux') throw new Error('The image diagnostic requires Linux /proc PSS accounting.');
  const config = modeConfig('full');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const page = await imagePage(config);
  try {
    const results = [];
    for (const variant of variants) results.push(await runVariant(variant, { page: page.dir, config }));
    const report = { schemaVersion: 1, fixture: { images: config.images, imageSide: config.imageSide, logicalBytes: page.logicalBytes, encodedBytes: page.encodedBytes },
      ceilingBytes: SAFETY.processPssBytes, results };
    await writeFile(join(artifacts, 'image-diagnostic.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { artifacts: { type: 'string' }, variants: { type: 'string' } } });
  const report = await runImageDiagnostic({
    artifacts: resolve(values.artifacts ?? '/tmp/resource-image-diagnostic'),
    ...(values.variants ? { variants: values.variants.split(',') } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}
