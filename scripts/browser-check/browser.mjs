import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort, until } from './lifecycle.mjs';

export async function resolvePlaywright(explicit) {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  else {
    try { candidates.push(require.resolve('playwright')); } catch {}
    const cache = join(process.env.npm_config_cache ?? join(homedir(), '.npm'), '_npx');
    if (existsSync(cache)) for (const entry of readdirSync(cache).sort()) candidates.push(join(cache, entry, 'node_modules/playwright/index.mjs'));
  }
  for (const path of candidates) if (existsSync(path)) {
    const module = await import(pathToFileURL(path).href);
    return { chromium: module.chromium, path };
  }
  throw new Error('Playwright is unavailable; pass --playwright /path/to/playwright/index.mjs or populate the npm cache with npx playwright --version.');
}
export function shotName(name, state, matrix) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Screenshot names must contain only letters, numbers, hyphens and underscores.');
  return `${name}${matrix ? `-${state.width}-${state.theme}${state.touch ? '-touch' : ''}` : ''}.png`;
}
export const matrixCases = (touch = false) => [1360, 390].flatMap(width => ['dark', 'light'].map(theme => ({ width, theme, touch })));

export async function startBrowser({ root, env, life, target, timeout, playwright, chrome, matrix }) {
  const resolved = await resolvePlaywright(playwright);
  const executable = chrome ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', resolved.chromium.executablePath()].find(existsSync);
  if (!executable) throw new Error('Chrome is unavailable; pass --chrome /path/to/chrome.');
  const port = await freePort();
  life.spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(root, 'chrome-profile')}`, 'about:blank'], { name: 'chrome', env });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok, 'Chrome debugging endpoint (see logs/chrome.log)', timeout);
  const browser = await resolved.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout, artifactsDir: join(root, 'artifacts') });
  // hasTouch enables Playwright's touchscreen API. CDP below switches the actual
  // device capability on/off without destroying the page or its scroll state.
  const context = await browser.newContext({ hasTouch: true, acceptDownloads: false });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  await context.addInitScript(() => {
    window.__browserCheckLongTasks = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__browserCheckLongTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const state = { width: 1360, height: 900, theme: 'light', touch: false, reducedMotion: false };
  const shots = [];
  const consoleLog = [];
  page.on('console', message => consoleLog.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => consoleLog.push({ type: 'pageerror', text: error.message }));
  async function media() {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: state.theme }, { name: 'prefers-reduced-motion', value: state.reducedMotion ? 'reduce' : 'no-preference' }] });
  }
  const api = {
    page, context, state, shots,
    async open(path = '/') { await page.goto(new URL(path, target.url).href, { waitUntil: 'domcontentloaded' }); await api.touch(state.touch); await media(); if (target.ready) await target.ready(api); },
    async viewport(value) { const size = typeof value === 'number' ? { width: value, height: value <= 600 ? 844 : 900 } : value; await page.setViewportSize(size); Object.assign(state, size); },
    async theme(value) {
      if (!['dark', 'light'].includes(value)) throw new Error('Theme must be dark or light.');
      state.theme = value; await media();
      if (!target.theme) throw new Error('Target must provide theme(api, value) to apply its own stored preference.');
      await target.theme(api, value);
      // Navigation can restore the context's initial touch/media overrides.
      await api.touch(state.touch); await media();
      const background = await until(async () => {
        const background = await page.evaluate(selector => getComputedStyle(document.querySelector(selector)).backgroundColor, target.backgroundSelector ?? 'body');
        const rgb = background.match(/[\d.]+/g)?.map(Number);
        if (!rgb || rgb.length < 3 || (rgb.length === 4 && rgb[3] === 0)) return false;
        const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
        return (value === 'dark' ? brightness < 128 : brightness >= 128) ? background : false;
      }, `${value} computed background at ${target.backgroundSelector ?? 'body'}`, timeout);
      state.background = background;
    },
    async touch(on) { await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: 1 }); state.touch = on; },
    async reducedMotion(on) { state.reducedMotion = on; await media(); },
    async shot(name) { const filename = shotName(name, state, matrix); const path = join(root, filename); await page.screenshot({ path, timeout }); shots.push({ path, ...state }); return path; },
    async snapshot() { const text = await page.locator('body').ariaSnapshot({ timeout }); writeFileSync(join(root, `snapshot-${state.width}-${state.theme}.yml`), text); return text; },
    async waitFor(value) { const locator = typeof value === 'string' ? page.getByText(value, { exact: false }).first() : page.locator(value.selector).first(); try { await locator.waitFor({ state: 'visible', timeout }); } catch { throw new Error(`Timed out after ${timeout}ms waiting for ${JSON.stringify(value)} at ${page.url()}`); } },
    async metrics() { return page.evaluate(() => ({ domNodes: document.querySelectorAll('*').length, longTasks: window.__browserCheckLongTasks, renderCounts: window.__renderCounts ?? null })); },
    async contactSheet() {
      const sheet = await context.newPage();
      try {
        await sheet.setViewportSize({ width: 1440, height: 1000 });
        await sheet.setContent('<html><body style="margin:0;background:#ddd;font:18px sans-serif"><main style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px"></main></body></html>');
        await sheet.evaluate(items => { for (const item of items) { const figure = document.createElement('figure'); figure.style.margin = '0'; const label = document.createElement('figcaption'); label.textContent = item.name; const image = document.createElement('img'); image.src = item.data; image.style.cssText = 'width:100%;height:440px;object-fit:contain;background:white'; figure.append(label, image); document.querySelector('main').append(figure); } }, shots.map(shot => ({ name: shot.path.split('/').at(-1), data: `data:image/png;base64,${readFileSync(shot.path).toString('base64')}` })));
        await sheet.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
        const path = join(root, 'contact-sheet.png'); await sheet.screenshot({ path, fullPage: true }); return path;
      } finally { await sheet.close(); }
    },
    async close() { writeFileSync(join(root, 'logs/browser.json'), JSON.stringify(consoleLog, null, 2)); await browser.close(); },
    playwrightPath: resolved.path,
  };
  await api.viewport(1360); await api.touch(false);
  return api;
}
