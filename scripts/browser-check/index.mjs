import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname, basename } from 'node:path';
import { lifecycle, isolatedEnvironment, freePort, until } from './lifecycle.mjs';
import { startBrowser, matrixCases } from './browser.mjs';

export function outsideCheckout(root, checkout) {
  let ancestor = resolve(root);
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const rel = relative(realpathSync(checkout), join(realpathSync(ancestor), ...suffix));
  if (!rel || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Artifacts must be outside the checkout.');
}
/** Every process a target starts must use runtime.spawn (owned process groups).
 * A target returns {url, theme?, ready?, rpc?, preparePage?}; fixture is a
 * separate function receiving that target and this same isolated runtime. */
export async function browserCheck(options, script = async check => { await check.snapshot(); await check.shot('page'); }) {
  if (!options?.target) throw new Error('Provide a target: an existing URL or an async startup function.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Browser checks require Node 24 or newer; run with a Node 24 executable.');
  const base = resolve(options.artifacts ?? '/tmp/browser-check');
  outsideCheckout(base, options.checkout ?? process.cwd());
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, 'run-'));
  const env = isolatedEnvironment(root);
  for (const value of Object.values(env)) if (value.startsWith(root)) mkdirSync(value.endsWith('npmrc') || value.endsWith('gitconfig') ? resolve(value, '..') : value, { recursive: true, mode: 0o700 });
  const life = lifecycle(root, env);
  const timeout = options.timeout ?? 30000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Timeout must be a positive number of milliseconds.');
  const runtime = { root, env, timeout, spawn: life.spawn, freePort, until, node: process.execPath };
  const evidence = { root, startedAt: new Date().toISOString(), cases: [], processes: life.records };
  let browser;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    try { if (browser) await Promise.race([browser.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timed out')), 5000).unref())]); }
    catch (error) { evidence.closeError = error.message; }
    finally { evidence.survivors = await life.close(); writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
  })();
  const interrupt = signal => { evidence.error = signal; void close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  try {
    const target = typeof options.target === 'string' ? { url: options.target } : await options.target(runtime);
    if (!target.url) throw new Error('Target startup must return a URL.');
    await until(async () => (await fetch(target.url, { signal: AbortSignal.timeout(1000) })).ok, `target ${target.url}`, timeout);
    const fixture = options.fixture ? await options.fixture(target, runtime, options.fixtureName ?? 'empty') : null;
    evidence.fixture = fixture; evidence.target = target.url; evidence.build = target.build;
    browser = await startBrowser({ ...options, root, env, life, target, timeout });
    browser.rpc = target.rpc ?? (() => { throw new Error('This target does not provide RPC.'); });
    browser.fixture = fixture; browser.root = root;
    if (target.preparePage) await target.preparePage(browser, fixture);
    for (const entry of options.matrix ? matrixCases(options.touch ?? false) : [{ width: options.width ?? 1360, theme: options.theme ?? 'light', touch: options.touch ?? false }]) {
      await browser.viewport(entry.width); await browser.touch(entry.touch);
      await browser.open(options.path ?? '/');
      if (target.theme) await browser.theme(entry.theme);
      else if (options.matrix) throw new Error('Matrix requires a target theme adapter that applies stored preferences.');
      await browser.reducedMotion(options.reducedMotion ?? false);
      await script(browser);
      evidence.cases.push({ ...browser.state, metrics: await browser.metrics() });
    }
    evidence.playwright = browser.playwrightPath;
    evidence.shots = browser.shots;
    if (options.matrix) evidence.contactSheet = await browser.contactSheet();
    return evidence;
  } catch (error) {
    evidence.error = error.message;
    writeFileSync(join(root, 'error.log'), error.stack ?? String(error));
    if (browser) { try { await browser.shot('failure'); await browser.snapshot(); } catch {} }
    throw error;
  }
  finally { await close(); process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm); console.log(`Artifacts: ${root}`); }
}
