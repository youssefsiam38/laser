import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lifecycle, isolatedEnvironment, freePort, until } from '../lifecycle.mjs';
import { resolvePlaywright } from '../browser.mjs';
import { processSample } from './process-sampler.mjs';
import { captureHeap } from './heap.mjs';
import { dispatchFindShortcut } from './keyboard.mjs';
import { connectInspector, linuxStartToken } from './inspector.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rpc(url, version, method, params = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/ws`);
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    const finish = (error, value) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, clientVersion: version }));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1) finish(message.error ? new Error(`${method}: ${message.error.message}`) : null, message.result);
    };
    socket.onerror = () => finish(new Error(`${method} socket failed`));
  });
}

function displayNumber() {
  for (let number = 90; number < 190; number++) if (!existsSync(`/tmp/.X11-unix/X${number}`)) return number;
  throw new Error('No bounded Xvfb display number was available.');
}

function summarizeSnapshot(result) {
  const snapshot = result.snapshot;
  return {
    processCount: snapshot.processes.length,
    coverage: snapshot.totals.coverage,
    knownPhysicalBytes: snapshot.totals.knownPhysicalBytes,
    crossCheck: snapshot.health.crossCheck.status,
    roles: snapshot.byRole.map(row => ({ role: row.role, processes: row.coverage.processes, measured: row.coverage.measured,
      complete: row.coverage.complete, knownPhysicalBytes: row.knownPhysicalBytes })),
  };
}

async function sampleTree(snapshot, mainPid) {
  const rows = [];
  for (const process of snapshot.snapshot.processes) {
    try {
      const row = await processSample(process.pid, process.startToken);
      rows.push({ role: process.role, pssBytes: row.pssBytes, privateResidentBytes: row.privateResidentBytes,
        residentBytes: row.residentBytes, peakResidentBytes: row.peakResidentBytes, cpuSeconds: row.cpuSeconds });
    } catch {}
  }
  if (!rows.some(row => row.role === 'desktop_main')) {
    const row = await processSample(mainPid, await linuxStartToken(mainPid));
    rows.push({ role: 'desktop_main', pssBytes: row.pssBytes, privateResidentBytes: row.privateResidentBytes,
      residentBytes: row.residentBytes, peakResidentBytes: row.peakResidentBytes, cpuSeconds: row.cpuSeconds });
  }
  return rows;
}

export async function runElectronLane({ checkout, root, mode, timeoutMs }) {
  const electron = join(checkout, 'packages/desktop/node_modules/electron/dist/electron');
  const app = join(checkout, 'packages/desktop');
  const provider = new URL('./provider.mjs', import.meta.url).pathname;
  const preload = new URL('./inspect-preload.cjs', import.meta.url).pathname;
  if (!existsSync(electron)) throw new Error('The built Electron runtime is unavailable.');
  const laneRoot = join(root, 'electron-scratch');
  mkdirSync(laneRoot, { recursive: true, mode: 0o700 });
  const env = isolatedEnvironment(laneRoot);
  for (const value of Object.values(env)) if (value.startsWith(laneRoot)) mkdirSync(value.endsWith('npmrc') || value.endsWith('gitconfig') ? join(value, '..') : value, { recursive: true, mode: 0o700 });
  const life = lifecycle(laneRoot, env);
  const checkpoint = name => writeFileSync(join(laneRoot, 'stage.json'), JSON.stringify({ name }), { mode: 0o600 });
  let browser;
  let mainInspector;
  try {
    const { ENV, ENV_PREFIX } = await import('../../../packages/protocol/dist/index.js');
    const bridgeKey = 'desktop';
    const agentDir = join(laneRoot, 'agent');
    const sessionDir = join(laneRoot, 'sessions');
    const stateDir = join(laneRoot, 'state');
    const inspectDir = join(laneRoot, 'inspect');
    for (const directory of [agentDir, sessionDir, stateDir, inspectDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    life.spawn(process.execPath, [provider, laneRoot, mode], { name: 'electron-provider', env: { ...env, [ENV.agentDir]: agentDir, [ENV.sessionDir]: sessionDir, [ENV.stateDir]: stateDir } });
    await until(() => existsSync(join(laneRoot, 'provider.json')), 'Electron lane provider', timeoutMs);
    const display = displayNumber();
    life.spawn('/usr/bin/Xvfb', [`:${display}`, '-screen', '0', '1360x900x24', '-nolisten', 'tcp'], { name: 'xvfb', env });
    await until(() => existsSync(`/tmp/.X11-unix/X${display}`), 'owned Xvfb display', 10_000);
    const debugPort = await freePort();
    const mainInspectPort = await freePort();
    const port = await freePort();
    const electronEnv = { ...env, DISPLAY: `:${display}`, [ENV.agentDir]: agentDir, [ENV.sessionDir]: sessionDir,
      [ENV.stateDir]: stateDir, [ENV.node]: process.execPath, [ENV.port]: String(port),
      [`${ENV_PREFIX}_RESOLVE_SHELL_ENV`]: '0', NODE_OPTIONS: `--require=${preload}`, RESOURCE_SOAK_INSPECT_DIR: inspectDir };
    const args = [`--inspect=${mainInspectPort}`, app, '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'];
    checkpoint('launching');
    const first = life.spawn(electron, args, { name: 'electron-main', env: electronEnv });
    await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok,
      'Electron debugging endpoint', timeoutMs);
    const mainTarget = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${mainInspectPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return false;
      return (await response.json()).find(row => typeof row.webSocketDebuggerUrl === 'string') ?? false;
    }, 'Electron main inspector endpoint', timeoutMs);
    mainInspector = await connectInspector({ pid: first.pid, startToken: await linuxStartToken(first.pid), url: mainTarget.webSocketDebuggerUrl }, { rootPid: first.pid, label: 'electron-main' });
    const mainWindowState = async () => {
      const result = await mainInspector.send('Runtime.evaluate', { expression: `(()=>{const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/resource-inspector.cjs');const {BrowserWindow}=require('electron');const windows=BrowserWindow.getAllWindows();return {count:windows.length,visible:windows.some(window=>window.isVisible()),destroyed:windows.map(window=>window.isDestroyed())}})()`, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Electron main visibility inspection failed');
      if (!result.result?.value || typeof result.result.value.visible !== 'boolean') throw new Error('Electron main visibility inspection returned no state');
      return result.result.value;
    };
    const mainVisible = async () => (await mainWindowState()).visible;
    const mainMetrics = async () => {
      const result = await mainInspector.send('Runtime.evaluate', { expression: `(()=>{const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/resource-inspector.cjs');return require('electron').app.getAppMetrics()})()`, returnByValue: true });
      if (result.exceptionDetails || !Array.isArray(result.result?.value)) throw new Error('Electron main metrics inspection failed');
      return result.result.value;
    };
    const hostFile = join(stateDir, 'host.json');
    await until(() => existsSync(hostFile), 'Electron-owned host record', timeoutMs);
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    const version = JSON.parse(readFileSync(join(checkout, 'packages/cli/package.json'), 'utf8')).version;
    await rpc(host.url, version, 'pi/setup/complete', { completed: true }, timeoutMs);
    const resolved = await resolvePlaywright();
    browser = await resolved.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: timeoutMs });
    const page = await until(() => browser.contexts().flatMap(value => value.pages()).find(value => {
      try { return new URL(value.url()).origin === new URL(host.url).origin; } catch { return false; }
    }) ?? false, 'Electron app renderer page', timeoutMs);
    const context = page.context();
    const rendererConsole = [];
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      rendererConsole.push({ type: message.type(), text: message.text().slice(0, 1_000) });
      if (rendererConsole.length > 20) rendererConsole.shift();
    });
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: timeoutMs });
    checkpoint('renderer-ready');
    const project = join(laneRoot, 'desktop-project');
    mkdirSync(project, { recursive: true, mode: 0o700 });
    await rpc(host.url, version, 'pi/project/add', { cwd: project }, timeoutMs);
    await rpc(host.url, version, 'pi/project/trust', { cwd: project, trusted: true, remember: true }, timeoutMs);
    const session = (await rpc(host.url, version, 'session/new', { cwd: project }, timeoutMs)).state;
    await rpc(host.url, version, 'pi/model/set', { path: session.path, model: { provider: 'stub', id: 'stub-1' } }, timeoutMs);
    await rpc(host.url, version, 'session/prompt', { path: session.path, content: [{ type: 'text', text: 'desktop resource checkpoint' }] }, timeoutMs);
    await until(async () => !(await rpc(host.url, version, 'session/load', { path: session.path }, timeoutMs)).state.isStreaming,
      'desktop synthetic session settlement', timeoutMs);
    checkpoint('session-settled');
    const { electronProcessReport } = await import(pathToFileURL(join(checkout, 'packages/desktop/dist/resource-metrics.js')).href);
    await rpc(host.url, version, 'resource/snapshot', { refresh: true }, timeoutMs);
    const desktopReport = electronProcessReport(await mainMetrics(), { mainPid: first.pid });
    const reported = await rpc(host.url, version, 'resource/report', desktopReport, timeoutMs);
    assert.equal(reported.verified, true, 'host did not verify Electron process identities');
    const visibleSnapshot = await until(async () => {
      await delay(500);
      const value = await rpc(host.url, version, 'resource/snapshot', { refresh: true }, timeoutMs);
      return value.snapshot.byRole.some(row => row.role === 'desktop_renderer') ? value : false;
    }, 'verified Electron process report to enter the resource snapshot', Math.min(timeoutMs, 15_000));
    checkpoint('inventory-visible');
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const visibleHeap = await captureHeap(cdp, join(laneRoot, 'electron-visible.heapsnapshot'));
    checkpoint('renderer-heap-visible');
    const visibleMainHeap = await captureHeap(mainInspector, join(laneRoot, 'electron-main-visible.heapsnapshot'));
    checkpoint('main-heap-visible');
    const mainStartToken = await linuxStartToken(first.pid);
    const visible = { visibility: await page.evaluate(() => document.visibilityState), nativeWindowVisible: await mainVisible(), inventory: summarizeSnapshot(visibleSnapshot),
      processes: await sampleTree(visibleSnapshot, first.pid), rendererHeap: { available: visibleHeap.available, rawBytes: visibleHeap.rawBytes },
      mainHeap: { available: visibleMainHeap.available, rawBytes: visibleMainHeap.rawBytes } };
    assert.deepEqual(await mainWindowState(), { count: 1, visible: true, destroyed: [false] }, 'desktop main window was not naturally visible');
    await page.evaluate(key => window[key].window.close(), bridgeKey);
    await until(async () => !(await mainVisible()), 'desktop window to hide', timeoutMs);
    checkpoint('hidden');
    await delay(5_000);
    const hiddenSnapshot = await rpc(host.url, version, 'resource/snapshot', { refresh: true }, timeoutMs);
    const hidden = { visibility: await page.evaluate(() => document.visibilityState), nativeWindowVisible: await mainVisible(), inventory: summarizeSnapshot(hiddenSnapshot),
      processes: await sampleTree(hiddenSnapshot, first.pid) };
    const second = life.spawn(electron, args, { name: 'electron-second-instance', env: electronEnv });
    await until(() => second.exitCode !== null, 'second Electron invocation to yield its instance lock', timeoutMs);
    assert.equal(second.exitCode, 0);
    await until(mainVisible, 'same desktop window to restore', timeoutMs);
    checkpoint('restored');
    await delay(5_000);
    const restoredSnapshot = await rpc(host.url, version, 'resource/snapshot', { refresh: true }, timeoutMs);
    const restoredHeap = await captureHeap(cdp, join(laneRoot, 'electron-restored.heapsnapshot'));
    checkpoint('renderer-heap-restored');
    const restoredMainHeap = await captureHeap(mainInspector, join(laneRoot, 'electron-main-restored.heapsnapshot'));
    checkpoint('main-heap-restored');
    const restored = { visibility: await page.evaluate(() => document.visibilityState), nativeWindowVisible: await mainVisible(), inventory: summarizeSnapshot(restoredSnapshot),
      processes: await sampleTree(restoredSnapshot, first.pid), rendererHeap: { available: restoredHeap.available, rawBytes: restoredHeap.rawBytes },
      mainHeap: { available: restoredMainHeap.available, rawBytes: restoredMainHeap.rawBytes } };
    assert.equal(await linuxStartToken(first.pid), mainStartToken, 'Electron main generation changed across hide/restore');
    assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).startToken, host.startToken, 'host generation changed across hide/restore');
    assert.ok(restored.inventory.roles.some(row => row.role === 'desktop_main'), 'resource inventory omitted Electron main');
    assert.ok(restored.inventory.roles.some(row => row.role === 'desktop_renderer'), 'resource inventory omitted Electron renderer');
    let keyboard;
    try { keyboard = await dispatchFindShortcut({ cdp, page, timeoutMs: Math.min(timeoutMs, 15_000) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; browserConsole=${JSON.stringify(rendererConsole)}`, { cause: error });
    }
    checkpoint('keyboard-verified');
    await mainInspector.close();
    mainInspector = undefined;
    await browser.close();
    browser = undefined;
    const survivors = await life.close();
    assert.equal(survivors.length, 0, 'Electron lane left owned process survivors');
    await rm(laneRoot, { recursive: true, force: true });
    return { visible, hidden, restored, keyboard, sameMainGeneration: true, sameHostGeneration: true,
      secondInstanceExitCode: second.exitCode, teardown: 'owned process-tree lifecycle', survivors: 0 };
  } catch (error) {
    await mainInspector?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await life.close();
    throw error;
  }
}
