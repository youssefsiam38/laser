#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket as NodeWebSocket } from '../../packages/host/node_modules/ws/wrapper.mjs';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { browserCheck } from './index.mjs';
import { resourceTarget, fixture, checkout } from './targets/resource-soak.mjs';
import { modeConfig, expected, SAFETY } from './resource/config.mjs';
import { createSessions, imagePayload, prompt, settle } from './resource/fixtures.mjs';
import { waitForRegistrations, connectInspector, queryInstances, scalarCounters, tailBufferCounters, descendantPids, removeRegistrations, linuxStartToken } from './resource/inspector.mjs';
import { captureHeap } from './resource/heap.mjs';
import { processSample, enforceSafety } from './resource/process-sampler.mjs';
import { runElectronLane } from './resource/electron.mjs';
import { captureMemoryInfra } from './resource/memory-infra.mjs';
import { closeNodeWebSocket } from './resource/websocket.mjs';
import { writeReport, compareRuns, slopeSummary, assertRedacted, sanitizeOwner } from './resource/report.mjs';

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const hostModule = pathToFileURL(join(checkout, 'packages/host/dist/server.js')).href;
const workerModule = pathToFileURL(join(checkout, 'packages/worker/dist/server.js')).href;
const tailModule = pathToFileURL(join(checkout, 'packages/pi-extension/dist/modules/background-work.js')).href;

function until(fn, label, timeout) {
  const deadline = Date.now() + timeout;
  return (async () => { while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(50); } throw new Error(`Timed out waiting for ${label}.`); })();
}
function total(rows, key) { return rows.every(row => Number.isFinite(row[key])) ? rows.reduce((sum,row) => sum + row[key], 0) : null; }
function allocationRows(profile) {
  const by = new Map();
  const walk = node => { const name = node.callFrame?.functionName || '(anonymous)'; by.set(name, (by.get(name) ?? 0) + (node.selfSize ?? 0)); for (const child of node.children ?? []) walk(child); };
  if (profile?.head) walk(profile.head);
  for (const sample of profile?.samples ?? []) by.set('sampled-allocation', (by.get('sampled-allocation') ?? 0) + (sample.size ?? 0));
  return [...by].map(([owner,bytes]) => ({ owner, bytes })).filter(row => row.bytes > 0).sort((a,b) => b.bytes-a.bytes).slice(0,20);
}

export async function connectWorkerInspector(record, hostPid, { connect = connectInspector, query = queryInstances } = {}) {
  let client;
  let ownershipTransferred = false;
  try {
    client = await connect(record, { rootPid: hostPid, label: 'worker' });
    const found = await query(client, workerModule, 'WorkerServer');
    const handle = { record, client, found };
    ownershipTransferred = true;
    return handle;
  } finally {
    if (client && !ownershipTransferred) await client.close();
  }
}

/**
 * Runtime.queryObjects stays the hard discovery checkpoint, and the instance it
 * finds is re-acquired immediately before its own capture: a handle taken at
 * the start of a phase can belong to an execution context that is already gone
 * by the time that phase reaches its snapshot.
 */
export async function captureInstanceHeap(client, file, moduleUrl, exportName, { capture = captureHeap, query = queryInstances } = {}) {
  const found = await query(client, moduleUrl, exportName);
  try {
    return await capture(client, file, { [exportName]: found.instanceId });
  } finally {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: found.group }).catch(() => {});
  }
}

async function inspectorSet(check, { includeWorkers = true } = {}) {
  const records = await waitForRegistrations(check.fixture.inspectDir, { rootPid: check.fixture.hostRecord.pid, minimum: 1, timeoutMs: 10_000 });
  const hostRecord = records.find(record => record.pid === check.fixture.hostRecord.pid);
  if (!hostRecord) throw new Error('The owned host inspector registration is missing.');
  const host = await connectInspector(hostRecord, { rootPid: check.fixture.hostRecord.pid, label: 'host' });
  const hostFound = await queryInstances(host, hostModule, 'HostServer');
  const workers = [];
  if (includeWorkers) for (const record of records.filter(record => record.pid !== hostRecord.pid)) {
    try { workers.push(await connectWorkerInspector(record, hostRecord.pid)); }
    catch {}
  }
  return { records, host: { record: hostRecord, client: host, found: hostFound }, workers };
}
async function closeInspectorSet(set) {
  await set.host.client.send('Runtime.releaseObjectGroup', { objectGroup: set.host.found.group }).catch(() => {});
  await set.host.client.close();
  for (const worker of set.workers) {
    await worker.client.send('Runtime.releaseObjectGroup', { objectGroup: worker.found.group }).catch(() => {});
    await worker.client.close();
  }
}

async function activeRendererPid(check) {
  if (check._resourceRendererPid) return check._resourceRendererPid;
  const marker = `resource-renderer-${Date.now()}`;
  let resolveComplete;
  const completed = new Promise(resolveValue => { resolveComplete = resolveValue; });
  check.browserCdp.once('Tracing.tracingComplete', resolveComplete);
  await check.browserCdp.send('Tracing.start', { categories: 'blink.user_timing,devtools.timeline', transferMode: 'ReturnAsStream' });
  await check.page.evaluate(value => { performance.mark(value); console.timeStamp(value); }, marker);
  await sleep(100);
  await check.browserCdp.send('Tracing.end');
  const { stream } = await Promise.race([completed, sleep(10_000).then(() => { throw new Error('Chrome trace marker timed out.'); })]);
  let text = '';
  while (true) {
    const part = await check.browserCdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
    text += part.data;
    if (text.length > 8 * 1024 * 1024) throw new Error('Chrome marker trace exceeded 8 MiB.');
    if (part.eof) break;
  }
  await check.browserCdp.send('IO.close', { handle: stream });
  const trace = JSON.parse(text);
  const matches = trace.traceEvents.filter(event => event.name === marker || event.args?.data?.message === marker || event.args?.name === marker);
  const pids = [...new Set(matches.map(event => event.pid).filter(Number.isInteger))];
  if (pids.length !== 1) throw new Error(`Could not map the measured page to one renderer PID; marker matched ${pids.length}.`);
  check._resourceRendererPid = pids[0]; return pids[0];
}

/**
 * What a sampled process is, from structural evidence only: the host's own
 * process tree, the renderer the measured page actually runs in (mapped
 * through a trace marker), and the host's structural inventory role when that
 * process is one the host knows. Never argv, never a path.
 */
export function classifySampledProcess(pid, { hostPid = null, hostDescendants = [], rendererPid = null, inventoryRole = null, inventoryLabel = null } = {}) {
  const structural = pid === hostPid ? 'host'
    : pid === rendererPid ? 'renderer of the measured page'
    : hostDescendants.includes(pid) ? 'host descendant (worker or worker child)'
    : 'browser child outside the host process tree';
  return inventoryRole ? `${structural} · inventory role ${inventoryRole}${inventoryLabel ? ` (${inventoryLabel})` : ''}` : structural;
}

/** Count-only description of a refusal; no pid, no start token, no path. */
export function safetyRefusalDetail({ phase, reason, offenders = [], totalPssBytes = null, processCount = null, lastRendererSnapshot = null, ceilingBytes = SAFETY.processPssBytes }) {
  return { phase, enforcedAt: "start of phase, before this phase's heap capture", reason, ceilingBytes,
    offenders: offenders.map(offender => ({ role: offender.role, pssBytes: offender.pssBytes ?? null, privateResidentBytes: offender.privateResidentBytes ?? null })),
    totalPssBytes, processCount, lastRendererSnapshot };
}

export function safetyRefusalMessage(detail) {
  const offenders = detail.offenders.map(offender => `${offender.role} PSS ${offender.pssBytes}`).join('; ') || 'no single process over the ceiling';
  const snapshot = detail.lastRendererSnapshot
    ? `last renderer heap snapshot: phase ${detail.lastRendererSnapshot.phase}, ${detail.lastRendererSnapshot.ageMs} ms earlier`
    : 'no renderer heap snapshot had been taken yet';
  return `${detail.reason} Enforced at the ${detail.enforcedAt} "${detail.phase}"; ceiling ${detail.ceilingBytes}; ${offenders}; `
    + `total PSS ${detail.totalPssBytes} over ${detail.processCount} sampled processes; ${snapshot}.`;
}

function lastRendererSnapshotOf(report) {
  for (let index = report.phases.length - 1; index >= 0; index--) {
    const phase = report.phases[index];
    if (phase.rendererHeap?.available) return { phase: phase.name, ageMs: Math.max(0, Date.now() - (report.startedAtMs + phase.atMs)) };
  }
  return null;
}

async function describeSafetyRefusal(check, report, { phase, rows, rendererPid, hostDescendants, error }) {
  let inventory = [];
  try {
    const snapshot = await check.rpc('resource/snapshot', { refresh: true });
    inventory = snapshot.snapshot.processes ?? [];
  } catch {}
  const offenders = rows.filter(row => (row.pssBytes ?? 0) > SAFETY.processPssBytes).map(row => {
    const known = inventory.find(item => item.key === `${row.pid}@${row.startToken}`);
    return { role: classifySampledProcess(row.pid, { hostPid: check.fixture.hostRecord.pid, hostDescendants, rendererPid,
      inventoryRole: known?.role ?? null, inventoryLabel: known?.label ?? null }), pssBytes: row.pssBytes, privateResidentBytes: row.privateResidentBytes };
  });
  const raw = error instanceof Error ? error.message : String(error);
  const detail = safetyRefusalDetail({ phase, reason: sanitizeOwner(raw.replace(/process \d+/g, 'a sampled process')),
    offenders, totalPssBytes: total(rows, 'pssBytes'), processCount: rows.length, lastRendererSnapshot: lastRendererSnapshotOf(report) });
  report.safetyRefusal = detail;
  return new Error(safetyRefusalMessage(detail));
}

async function rendererCounters(check) {
  await check.cdp.send('Performance.enable');
  const [metrics, dom, state] = await Promise.all([
    check.cdp.send('Performance.getMetrics'), check.cdp.send('Memory.getDOMCounters'),
    check.page.evaluate(() => {
      const store = window.__resourceSoak?.store; if (!store) return { storeReachable: false };
      const snapshot = store.getSnapshot(); const pairs = Object.entries(snapshot.open); const views = pairs.map(([, value]) => value);
      return { storeReachable: true, openSessions: views.length, hydratedSessions: views.filter(view => view?.hydrated).length,
        entries: views.reduce((n,view) => n + (view?.entries?.length ?? 0), 0),
        ownerBytes: pairs.map(([path, view], index) => ({ owner: window.__resourceSoak.aliases[path] ?? `session-${index + 1}`,
          bytes: new TextEncoder().encode(JSON.stringify(view?.entries ?? [])).byteLength })),
        mountedRows: document.querySelectorAll('[data-window-message]').length,
        images: [...document.querySelectorAll('[data-slot="message-image"]')].map(image => ({ width: image.naturalWidth, height: image.naturalHeight, decoded: image.complete && image.naturalWidth > 0 })) };
    }),
  ]);
  const values = Object.fromEntries(metrics.metrics.map(row => [row.name, row.value]));
  return { ...state, jsHeapUsedBytes: values.JSHeapUsedSize ?? null, jsHeapTotalBytes: values.JSHeapTotalSize ?? null,
    documents: values.Documents ?? null, listeners: values.JSEventListeners ?? null, domNodes: dom.nodes, detachedNodes: dom.detachedNodes };
}

/**
 * The renderer half of a phase sample. After the app page is closed on purpose
 * there is no page, CDP session or renderer process to ask, so this mode never
 * touches one and the phase says so instead of inventing numbers.
 */
/** What a case reports for a page that was deliberately closed before teardown. */
export function closedPageMetrics() {
  return { domNodes: null, longTasks: null, renderCounts: null,
    note: 'app page closed before teardown; renderer metrics are unavailable by design' };
}

export async function rendererSample(check, { pageClosed = false } = {}, { pid = activeRendererPid, counters = rendererCounters } = {}) {
  if (pageClosed) return { pid: null, renderer: null, status: 'unavailable: app page closed before this phase' };
  const rendererPid = await pid(check);
  const renderer = check.page.url() === 'about:blank' ? null : await counters(check);
  return { pid: rendererPid, renderer, status: renderer ? 'available' : 'unavailable: blank page' };
}

async function samplePhase(check, name, report, { heap = false, includeWorkers = true, pageClosed = false } = {}) {
  const set = await inspectorSet(check, { includeWorkers });
  try {
    const pids = [...await descendantPids(check.fixture.hostRecord.pid)];
    const { pid: rendererPid, renderer, status: rendererStatus } = await rendererSample(check, { pageClosed });
    if (rendererPid !== null && !pids.includes(rendererPid)) pids.push(rendererPid);
    const rows = [];
    for (const pid of pids) { try { rows.push(await processSample(pid)); } catch {} }
    let safety;
    try { safety = await enforceSafety(rows); }
    catch (error) { throw await describeSafetyRefusal(check, report, { phase: name, rows, rendererPid, hostDescendants: pids, error }); }
    const inventory = await check.rpc('resource/snapshot', { refresh: true });
    const hostCounters = await scalarCounters(set.host.client, set.host.found.instanceId, 'host');
    const workerCounters = includeWorkers ? (await Promise.all(set.workers.map(worker => scalarCounters(worker.client, worker.found.instanceId, 'worker').catch(error => ({ kind: 'worker', available: false, reason: error.message, sessions: 0, tasks: 0 }))))) : [];
    const tails = [];
    for (const worker of set.workers) {
      try { tails.push(await tailBufferCounters(worker.client, tailModule)); } catch (error) { tails.push({ available: false, reason: error.message }); }
    }
    const phase = { name, atMs: Date.now() - report.startedAtMs, processCount: rows.length, totalPssBytes: total(rows, 'pssBytes'),
      totalPrivateResidentBytes: total(rows, 'privateResidentBytes'), safety, renderer, rendererStatus, host: hostCounters, workers: workerCounters,
      inventory: { processCount: inventory.snapshot.processes.length, coverage: inventory.snapshot.totals.coverage,
        knownPhysicalBytes: inventory.snapshot.totals.knownPhysicalBytes, physicalBytes: inventory.snapshot.totals.physical.value ?? null,
        roles: inventory.snapshot.byRole.map(row => ({ role: row.role, processes: row.coverage.processes, measured: row.coverage.measured,
          complete: row.coverage.complete, knownPhysicalBytes: row.knownPhysicalBytes })),
        collectors: inventory.snapshot.health.collectors.map(row => ({ name: row.name, status: row.status })), crossCheck: inventory.snapshot.health.crossCheck.status },
      tailBuffers: { count: tails.reduce((n,row) => n + (row.count ?? 0), 0), bytes: tails.reduce((n,row) => n + (row.bytes ?? 0), 0) } };
    if (heap) {
      phase.hostHeap = await captureInstanceHeap(set.host.client, join(check.root, `${name}-host.heapsnapshot`), hostModule, 'HostServer');
      if (renderer) {
        const object = await check.cdp.send('Runtime.evaluate', { expression: 'window.__resourceSoak.store.getSnapshot().open', objectGroup: 'resource-open' });
        phase.rendererHeap = await captureHeap(check.cdp, join(check.root, `${name}-renderer.heapsnapshot`), { stateOpen: object.result.objectId });
        await check.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'resource-open' });
      }
      phase.workerHeaps = [];
      for (const [index, worker] of set.workers.slice(0, report.mode === 'full' ? 3 : 1).entries()) {
        try {
          phase.workerHeaps.push(await captureInstanceHeap(worker.client, join(check.root, `${name}-worker-${index + 1}.heapsnapshot`), workerModule, 'WorkerServer'));
        } catch (error) {
          phase.workerHeaps.push({ available: false, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      await sleep(1_000);
      const postGcRows = [];
      for (const row of rows) { try { postGcRows.push(await processSample(row.pid, row.startToken)); } catch {} }
      phase.postGc = { totalPssBytes: total(postGcRows, 'pssBytes'), totalPrivateResidentBytes: total(postGcRows, 'privateResidentBytes'),
        renderer: renderer ? await rendererCounters(check) : null,
        host: await scalarCounters(set.host.client, set.host.found.instanceId, 'host') };
    }
    report.phases.push(phase);
    for (const row of renderer?.ownerBytes ?? []) (report.rankings['renderer-state-projection'] ??= []).push({ owner: `renderer/state.open/${row.owner}/entries`, bytes: row.bytes });
    for (const [category, result] of [['host', phase.hostHeap], ['renderer', phase.rendererHeap]]) {
      const targets = result?.targets ?? {};
      for (const [owner, item] of Object.entries(targets)) if (item.available) {
        (report.rankings[category] ??= []).push({ owner: `${name}/${owner}`, bytes: item.retainedBytes });
        for (const child of item.largestOwnedNodes ?? []) (report.rankings[`${category}-nodes`] ??= []).push({ owner: `${child.type}/${child.name}`, bytes: child.bytes });
      }
    }
    for (const [index, result] of (phase.workerHeaps ?? []).entries()) {
      for (const [owner, item] of Object.entries(result?.targets ?? {})) if (item.available) {
        (report.rankings.worker ??= []).push({ owner: `${name}/worker-${index + 1}/${owner}`, bytes: item.retainedBytes });
        for (const child of item.largestOwnedNodes ?? []) (report.rankings['worker-nodes'] ??= []).push({ owner: `${child.type}/${child.name}`, bytes: child.bytes });
      }
    }
    return phase;
  } finally { await closeInspectorSet(set); }
}

async function hydrate(check, sessions, onCheckpoint = async () => {}) {
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    await check.page.evaluate(async ({ path, alias }) => {
      const stable = window.__resourceSoak?.stable; if (!stable) throw new Error('UI stable provider action is unreachable.');
      window.__resourceSoak.aliases[path] = alias;
      await stable.openSession(path);
    }, { path: session.path, alias: session.alias });
    if ((index + 1) % 10 === 0 || index + 1 === sessions.length) await onCheckpoint(index + 1);
  }
  return check.page.evaluate(() => Object.keys(window.__resourceSoak.store.getSnapshot().open).length);
}
async function createWorkspaceSessions(check, count) {
  const snapshot = await check.rpc('agents/list', {});
  const sessions = [];
  for (const name of ['beam', 'chat']) {
    const cwd = snapshot.workspaces?.[name];
    assert.equal(typeof cwd, 'string', `${name} workspace is unavailable from the authoritative catalog`);
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      const state = (await check.rpc('session/new', { cwd, agentName: name })).state;
      await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
      await check.rpc('pi/session/rename', { path: state.path, name: `${name === 'beam' ? 'Beam' : 'Chat'}-${ordinal}` });
      sessions.push({ path: state.path, cwd, alias: `${name === 'beam' ? 'Beam' : 'Chat'}-${ordinal}`, kind: name, groupRows: count });
    }
  }
  await hydrate(check, sessions);
  for (const session of sessions) await selectSession(check, session);
  return sessions;
}
/**
 * The sidebar as this run reads it: the one visible tabpanel of the selected
 * kind, the group section that owns this session's directory, that group's own
 * rows and that group's own real "Load more" control. Nothing here reaches into
 * another tab's panel, another group's control or a test-only hook.
 */
export function sidebarRowView(check, session) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  const group = region.getByRole('tabpanel').locator(`section[data-cwd=${JSON.stringify(session.cwd)}]`);
  const escaped = session.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trigger = group.locator('[data-slot="aui_thread-list-item-trigger"]')
    .filter({ has: check.page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: new RegExp(`^${escaped}$`) }) });
  const rows = group.locator('[data-slot="aui_thread-list-item-trigger"]');
  const control = group.getByRole('button', { name: /^(Load more|Show fewer|Loading chats…)$/ });
  return {
    region, group, trigger,
    isRowVisible: () => trigger.first().isVisible().catch(() => false),
    rowCount: () => rows.count().catch(() => 0),
    async loadMore() {
      const first = control.first();
      if (!await first.isVisible().catch(() => false)) return null;
      const label = ((await first.textContent().catch(() => '')) ?? '').trim();
      return { label, click: () => first.click() };
    },
  };
}

/**
 * Reveal one titled row by using the product's own paging, never by widening a
 * fixture or reading the store. Each real click reveals one more page, so the
 * number of clicks is bounded by the retained rows the run created (plus one
 * for a catalog page the group still has to fetch), and a click that moves
 * neither the row into view nor the row count is a failure, not a retry.
 */
export async function revealSessionRow(view, { alias, expectedRows, pageSize = 7, settleMs = 10_000, pollMs = 100, sleepFor = sleep, now = () => Date.now() } = {}) {
  if (await view.isRowVisible()) return { alias, clicks: 0, revealedBy: 'already shown' };
  if (!Number.isInteger(expectedRows) || expectedRows < 1) {
    throw new Error(`Paging the sidebar for ${alias} needs the known retained row count of its group.`);
  }
  // The group already shows one page, so the rows it created need one click
  // less than its page count, plus one for a catalog page it still has to fetch.
  const maxClicks = Math.max(1, Math.ceil(expectedRows / pageSize) - 1) + 1;
  for (let clicks = 1; clicks <= maxClicks; clicks++) {
    const before = await view.rowCount();
    const control = await view.loadMore();
    if (!control) throw new Error(`The sidebar row for ${alias} is absent and its own group offers no "Load more" control at ${before} rows.`);
    if (control.label === 'Show fewer') throw new Error(`The sidebar group for ${alias} is fully expanded at ${before} rows and does not hold it.`);
    await control.click();
    const deadline = now() + settleMs;
    let revealed = false, progressed = false;
    while (now() <= deadline) {
      if (await view.isRowVisible()) { revealed = true; break; }
      if (await view.rowCount() > before) { progressed = true; break; }
      await sleepFor(pollMs);
    }
    if (revealed) return { alias, clicks, revealedBy: 'Load more' };
    if (!progressed) throw new Error(`"Load more" made no progress for ${alias}: ${before} rows before and after one real click within ${settleMs} ms.`);
  }
  throw new Error(`The sidebar row for ${alias} did not appear after ${maxClicks} real "Load more" clicks, the bound for ${expectedRows} retained rows in pages of ${pageSize}.`);
}

/**
 * Wait out the app's own reconnection. A bounded heap capture or a forced GC
 * stalls the host past the UI's heartbeat, and the app then rebuilds its
 * sidebar from the catalog when the socket is back. That is the product
 * behaving correctly under this run's own instrumentation, so the harness waits
 * for it rather than reading a sidebar that is still being rebuilt.
 */
async function waitForConnected(check, timeoutMs) {
  await check.page.getByText(/(?:Re)?[Cc]onnecting to the host…|Disconnected from the host/).first()
    .waitFor({ state: 'hidden', timeout: timeoutMs });
}

async function selectSession(check, session, { attempts = 3, connectTimeoutMs = 120_000, openTimeoutMs = 60_000 } = {}) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
      if (!await region.isVisible().catch(() => false)) await check.page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
      await waitForConnected(check, connectTimeoutMs);
      const kindTab = region.getByRole('tab', { name: session.kind === 'chat' ? 'Chat' : 'Code', exact: true });
      if (await kindTab.getAttribute('aria-selected') !== 'true') await kindTab.click();
      const view = sidebarRowView(check, session);
      await view.group.first().waitFor({ state: 'visible', timeout: connectTimeoutMs });
      await revealSessionRow(view, { alias: session.alias, expectedRows: session.groupRows });
      await view.trigger.first().click();
      await check.page.waitForFunction(title => document.querySelector('h1')?.textContent === title, session.alias, { timeout: openTimeoutMs });
      return;
    } catch (error) { failure = error; }
  }
  throw failure;
}

export async function traverseRetainedViews(check, sessions, workspaceSessions, expectedCount, { select = selectSession } = {}) {
  const retained = [...sessions, ...workspaceSessions];
  assert.equal(retained.length, expectedCount, 'retirement traversal has the expected retained view count');
  assert.equal(new Set(retained.map(session => session.path)).size, expectedCount, 'retirement traversal paths are unique');
  const rank = session => session.kind === 'chat' ? 2 : session.kind === 'beam' ? 1 : 0;
  const ordered = retained.map((session, index) => ({ session, index })).sort((a, b) => rank(a.session) - rank(b.session) || a.index - b.index);
  for (const { session } of ordered) await select(check, session);
  const kinds = ordered.reduce((counts, { session }) => {
    const kind = session.kind === 'chat' ? 'chat' : session.kind === 'beam' ? 'beam' : 'project';
    counts[kind] += 1; return counts;
  }, { project: 0, beam: 0, chat: 0 });
  return { visited: ordered.length, unique: expectedCount, ...kinds };
}

export function retirementGuardSnapshot(host = {}, workers = []) {
  const sum = key => workers.reduce((total, worker) => total + (Number(worker?.[key]) || 0), 0);
  return {
    productConnections: Number(host.connections) || 0,
    attachmentRefs: Number(host.attachmentRefs) || 0,
    attachedPaths: Number(host.attachedPaths) || 0,
    runningSessions: Number(host.runningSessions) || 0,
    liveRuns: Number(host.liveRuns) || 0,
    runningTasks: (Number(host.runningTasks) || 0) + sum('runningTasks'),
    attentionDialogs: Number(host.attentionDialogs) || 0,
    pendingQuestions: sum('pendingQuestions'),
    pendingApprovals: sum('pendingApprovals'),
    runningTools: sum('runningTools'),
  };
}

export function liveWorkOf(snapshot = {}) {
  const { productConnections: _connections, attachmentRefs: _refs, attachedPaths: _paths, ...work } = snapshot;
  return work;
}

export function assertNoLiveWork(snapshot) {
  const work = liveWorkOf(snapshot);
  assert.deepEqual(work, {
    runningSessions: 0, liveRuns: 0, runningTasks: 0, attentionDialogs: 0,
    pendingQuestions: 0, pendingApprovals: 0, runningTools: 0,
  }, `retirement prerequisites are not settled: ${JSON.stringify(work)}`);
}

/**
 * Prove the retirement prerequisites, tolerating only the observation race: a
 * worker may exit between its identity-checked inspector connect and the
 * counter read, and a vanished worker is neither live work nor a zero. The
 * whole set is re-sampled within one explicit deadline until every currently
 * connected worker answered and every work count is zero.
 */
export async function proveNoLiveWork(sample, { deadlineMs = 15_000, now = () => Date.now(), sleepFor = sleep, pollMs = 250 } = {}) {
  const deadline = now() + deadlineMs;
  let attempts = 0;
  let last = { guards: retirementGuardSnapshot(), readable: 0, unreadable: ['no sample taken'] };
  while (true) {
    attempts += 1;
    last = await sample();
    const work = liveWorkOf(last.guards);
    if (last.unreadable.length === 0 && Object.values(work).every(value => value === 0)) {
      assertNoLiveWork(last.guards);
      return { ...last, attempts };
    }
    if (now() >= deadline) break;
    await sleepFor(pollMs);
  }
  throw new Error('Retirement prerequisites were not provable before the guard deadline; '
    + `attempts=${attempts} readableWorkers=${last.readable} unreadableWorkers=${last.unreadable.length} `
    + `reasons=${JSON.stringify(last.unreadable.map(reason => sanitizeOwner(reason)))} guards=${JSON.stringify(last.guards)}`);
}

/**
 * Which worker process currently serves a project, as an identity that cannot
 * be confused by PID reuse. Anything a worker holds in memory — the
 * extension's TailBuffers, the worker's own task rows — belongs to exactly one
 * of these, and a natural retirement ends it. Identities stay inside the run;
 * only normalized counts reach the report.
 */
async function workerGeneration(check, cwd) {
  const row = (await check.rpc('pi/worker/list', {})).workers.find(worker => worker.cwd === cwd);
  if (!row || row.status !== 'ready' || !Number.isInteger(row.pid)) return null;
  const token = await linuxStartToken(row.pid).catch(() => null);
  return token ? `${row.pid}:${token}` : null;
}

/** What one worker process can still be holding, given where each call ran. */
export function expectedRetainedCounts({ calls = [], heavyToolGeneration = null, currentGeneration = null } = {}) {
  const same = value => value !== null && currentGeneration !== null && value === currentGeneration;
  const retained = calls.filter(call => same(call.generation));
  return {
    tailBuffers: retained.length + (same(heavyToolGeneration) ? 1 : 0),
    workerBackgroundTasks: retained.filter(call => call.background).length,
    sameGenerationCalls: retained.length,
    replacedGenerationCalls: calls.length - retained.length,
    heavyToolGenerationSurvived: same(heavyToolGeneration),
  };
}

async function sampleRetirementGuards(check) {
  const set = await inspectorSet(check);
  try {
    const host = await scalarCounters(set.host.client, set.host.found.instanceId, 'host');
    const workers = [];
    const unreadable = [];
    for (const worker of set.workers) {
      try { workers.push(await scalarCounters(worker.client, worker.found.instanceId, 'worker')); }
      catch (error) { unreadable.push(error instanceof Error ? error.message : String(error)); }
    }
    return { guards: retirementGuardSnapshot(host, workers), readable: workers.length, unreadable };
  } finally { await closeInspectorSet(set); }
}

function workerStatusCounts(workers) {
  return workers.reduce((counts, worker) => {
    const status = ['starting', 'ready', 'retiring', 'retired', 'crashed'].includes(worker.status) ? worker.status : 'other';
    counts[status] = (counts[status] ?? 0) + 1; return counts;
  }, {});
}

async function waitForNaturalRetirement(check, timeoutMs, guards) {
  const deadline = Date.now() + timeoutMs; let statuses = {};
  while (Date.now() < deadline) {
    const workers = (await check.rpc('pi/worker/list', {})).workers;
    statuses = workerStatusCounts(workers);
    if (workers.every(worker => !['starting', 'ready'].includes(worker.status))) return workers;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for natural worker retirement; guards=${JSON.stringify(guards)} statuses=${JSON.stringify(statuses)}`);
}

async function runBrowserSoak(check, mode, report) {
  const config = modeConfig(mode); const exp = expected(config);
  const browserVersion = await check.browserCdp.send('Browser.getVersion');
  report.runtime = { node: process.versions.node, chrome: browserVersion.product, platform: process.platform, architecture: process.arch };
  report.fixture = { projects: config.projects, sessionsPerProject: config.sessionsPerProject, longSessions: config.longSessions,
    longMessages: config.longMessages, children: config.children, foregroundCalls: config.foregroundCalls,
    backgroundCalls: config.backgroundCalls, images: config.images, imageSide: config.imageSide,
    reasoningBytes: config.reasoningBytes, markdownBytes: config.markdownBytes, toolBytes: config.toolBytes,
    snapshotByteCeiling: SAFETY.snapshotBytes, processPssCeiling: SAFETY.processPssBytes,
    totalPssCeiling: SAFETY.totalPssBytes, minimumAvailableBytes: SAFETY.minimumAvailableBytes };
  report.capabilities = { linuxProc: 'available', nodeInspector: 'available', rendererCdp: 'available',
    physicalDecodedImageOwnership: 'unavailable', relayConsumer: 'not measured; local host WebSocket backpressure only' };
  const prototype = await inspectorSet(check);
  try {
    const state = await check.page.evaluate(() => ({ store: !!window.__resourceSoak?.store, stable: !!window.__resourceSoak?.stable, matches: window.__resourceSoak?.matches, error: window.__resourceSoak?.error }));
    assert.deepEqual(state, { store: true, stable: true, matches: 1, error: null }, 'renderer state-store prototype checkpoint');
    assert.equal(prototype.workers.length, 0, 'baseline has no project worker');
  } finally { await closeInspectorSet(prototype); }
  await sleep(mode === 'full' ? 10_000 : 500);
  const baselineNatural = [];
  for (let index = 0; index < (mode === 'full' ? 5 : 2); index++) {
    if (index) await sleep(1_000);
    baselineNatural.push(await samplePhase(check, `baseline-natural-${index + 1}`, report));
  }
  const baseline = await samplePhase(check, 'baseline', report, { heap: true });
  assert.equal(baseline.host.tasks, 0, 'baseline host task register is empty');
  assert.equal(baseline.host.workers, 0, 'baseline host worker pool is empty');
  assert.equal(baseline.host.transcriptLoaded, 0, 'baseline transcript delivery holds no loaded paths');
  report.temporaryPeaks = { baselinePssBytes: Number.isFinite(baseline.postGc?.totalPssBytes)
    ? Math.max(...baselineNatural.map(row => row.totalPssBytes).filter(Number.isFinite), baseline.totalPssBytes ?? 0) - baseline.postGc.totalPssBytes : null };
  report.scenarios['1-baseline'] = 'complete';

  const sessions = await createSessions(check, config);
  assert.equal(sessions.length, exp.projectSessions);
  const visitCheckpoints = [];
  const open = await hydrate(check, sessions, async visited => {
    const checkpoint = await samplePhase(check, `visited-${visited}`, report);
    visitCheckpoints.push({ visited, openSessions: await check.page.evaluate(() => Object.keys(window.__resourceSoak.store.getSnapshot().open).length),
      rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null, totalPssBytes: checkpoint.totalPssBytes });
  });
  assert.equal(open, sessions.length, 'every distinct project session is held by the UI store');
  for (const session of sessions) await selectSession(check, session);
  const workspaceSessions = await createWorkspaceSessions(check, exp.workspaceSessions / 2);
  assert.equal(workspaceSessions.length, exp.workspaceSessions);
  report.visitCheckpoints = visitCheckpoints;
  report.workspaceSessions = { beam: workspaceSessions.filter(row => row.kind === 'beam').length, chat: workspaceSessions.filter(row => row.kind === 'chat').length };
  const onePerWorkspace = [...new Map([...sessions, ...workspaceSessions].map(session => [session.cwd, session])).values()];
  // Every project and private workspace ready at one moment. A worker that
  // retired naturally between the loads and the list is not a failure; the
  // whole observation is repeated until it holds at a single instant.
  const readyWorkers = await until(async () => {
    for (const session of onePerWorkspace) await check.rpc('session/load', { path: session.path });
    const workers = (await check.rpc('pi/worker/list', {})).workers;
    return workers.filter(worker => worker.status === 'ready').length === config.projects + exp.workspaceSessions ? workers : false;
  }, 'one ready worker per project and private workspace', Math.min(config.phaseTimeoutMs, 30_000));
  assert.equal(readyWorkers.filter(worker => worker.status === 'ready').length, config.projects + exp.workspaceSessions, 'every project and private workspace has one ready worker before cleanup');
  const distinctPhase = await samplePhase(check, 'distinct-sessions', report, { heap: true });
  assert.equal(distinctPhase.host.workers, config.projects + exp.workspaceSessions, 'host retains one row per project/private workspace');
  report.slopes.rendererDistinctSessionHeapBytesPerSession = slopeSummary(visitCheckpoints.map(row => ({ x: row.visited, y: row.rendererJsHeapBytes })), null);
  report.scenarios['2-distinct-sessions'] = 'complete';
  report.scenarios['6-multiple-projects-and-workspaces'] = 'complete';

  const pageCheckpoints = [{ pages: 0, rendererJsHeapBytes: distinctPhase.renderer?.jsHeapUsedBytes ?? null }];
  let loadedPages = 0;
  for (const session of sessions.filter(session => session.messages === config.longMessages)) {
    await selectSession(check, session);
    const pages = Math.max(0, Math.ceil((session.messages - 40) / 40));
    for (let i = 0; i < pages; i++) {
      const button = check.page.getByRole('button', { name: 'Load earlier messages', exact: true });
      if (!await button.isVisible().catch(() => false)) break;
      await button.click(); await check.page.getByText('Loading earlier messages…').waitFor({ state: 'hidden' }).catch(() => {});
    }
    const entries = await check.rpc('pi/session/entries', { path: session.path });
    assert.equal(entries.entries.filter(entry => entry.type === 'message').length, session.messages);
    loadedPages += pages;
    const checkpoint = await samplePhase(check, `paged-${session.alias}`, report);
    pageCheckpoints.push({ pages: loadedPages, rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null });
  }
  await samplePhase(check, 'paged-history', report, { heap: true });
  report.slopes.rendererPagedHistoryHeapBytesPerPage = slopeSummary(pageCheckpoints.map(row => ({ x: row.pages, y: row.rendererJsHeapBytes })), null);
  report.scenarios['3-backward-pagination'] = 'complete';

  const heavy = sessions[0];
  await selectSession(check, heavy);
  await prompt(check.rpc, heavy.path, 'resource:large-stream RESOURCE-SOAK-PROMPT-CANARY', until, config.phaseTimeoutMs);
  const afterReasoning = await samplePhase(check, 'large-reasoning-markdown', report);
  await prompt(check.rpc, heavy.path, 'resource:tool-large', until, config.phaseTimeoutMs);
  const tailCheckpointSet = await inspectorSet(check);
  let tailCheckpointCount = 0;
  try {
    assert.ok(tailCheckpointSet.workers.length >= 1, 'WorkerServer Runtime.queryObjects checkpoint found no live worker');
    for (const worker of tailCheckpointSet.workers) {
      try { tailCheckpointCount += (await tailBufferCounters(worker.client, tailModule)).count; } catch {}
    }
    assert.ok(tailCheckpointCount >= 1, 'TailBuffer Runtime.queryObjects checkpoint failed after the first real Bash call');
  } finally { await closeInspectorSet(tailCheckpointSet); }
  // The worker process that is holding that TailBuffer right now. If it retires
  // naturally later, the buffer goes with it and the retention expectation has
  // to know that rather than assume one process for the whole run.
  const heavyToolGeneration = await workerGeneration(check, heavy.cwd);
  const afterTool = await samplePhase(check, 'large-tool-output', report);
  const images = imagePayload(config);
  const accepted = await check.rpc('session/prompt', { path: heavy.path, content: [{ type: 'text', text: 'resource:images' }, ...images.map(image => ({ type: 'image', mimeType: 'image/png', data: image.bytes.toString('base64') }))] });
  assert.equal(accepted.accepted, true); await settle(check.rpc, heavy.path, until, config.phaseTimeoutMs);
  await selectSession(check, heavy);
  const memoryInfra = await captureMemoryInfra(check.browserCdp, async () => {
    const imageRows = check.page.locator('[data-slot="message-image"]');
    await imageRows.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
    const firstImage = imageRows.first();
    await firstImage.click();
    await check.page.keyboard.press('Escape');
    await selectSession(check, sessions.at(-1));
    await selectSession(check, heavy);
    await imageRows.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
  }, { timeoutMs: config.phaseTimeoutMs });
  report.memoryInfra = memoryInfra;
  report.capabilities.nativeAllocatorDump = memoryInfra.available
    ? `available; one bounded ${memoryInfra.levelOfDetail} dump outside the workload, ${memoryInfra.allocators.length} allocator owners`
    : `unavailable: ${memoryInfra.reason}`;
  report.rankings['renderer-native-allocators'] = memoryInfra.allocators;
  const streamPhase = await samplePhase(check, 'large-stream', report, { heap: true });
  report.slopes.rendererHeavyPayloadHeapBytesPerMiB = slopeSummary([
    { x: 0, y: distinctPhase.renderer?.jsHeapUsedBytes ?? null },
    { x: (config.reasoningBytes + config.markdownBytes) / 1024 / 1024, y: afterReasoning.renderer?.jsHeapUsedBytes ?? null },
    { x: (config.reasoningBytes + config.markdownBytes + config.toolBytes) / 1024 / 1024, y: afterTool.renderer?.jsHeapUsedBytes ?? null },
  ], null);
  report.imageOwnership = { count: images.length, decodedCount: streamPhase.renderer?.images?.filter(image => image.decoded).length ?? 0,
    logicalPixelBytes: images.reduce((n,image) => n + image.logicalBytes, 0), encodedBytes: images.reduce((n,image) => n + image.bytes.length, 0),
    hashes: images.map(image => image.hash), physicalDecodedBytes: null,
    limitation: 'logical RGBA estimate per decoded image; physical decode-cache ownership is unavailable' };
  assert.equal(report.imageOwnership.decodedCount, images.length, 'every synthetic message image decoded');
  report.discovery = { hostServer: true, workerServer: true, rendererStore: true, tailBuffer: true, tailBufferCountAtCheckpoint: tailCheckpointCount };
  report.temporaryPeaks.heavyRendererJsBytes = Number.isFinite(streamPhase.postGc?.renderer?.jsHeapUsedBytes)
    ? Math.max(afterReasoning.renderer?.jsHeapUsedBytes ?? 0, afterTool.renderer?.jsHeapUsedBytes ?? 0, streamPhase.renderer?.jsHeapUsedBytes ?? 0)
      - streamPhase.postGc.renderer.jsHeapUsedBytes : null;
  report.scenarios['4-large-content-and-images'] = 'complete';

  const workerDefinition = { name: 'worker', description: 'Runs synthetic resource work.', instructions: 'Complete only the assigned synthetic resource work.',
    engineInstructions: false, model: { provider: 'stub', id: 'stub-1' }, thinkingLevel: null, supportsSubagents: true,
    allowedAgents: ['worker'], scopedSkills: false, skills: [] };
  const beforeCatalog = await check.rpc('agents/list', {});
  if (!beforeCatalog.agents.some(agent => agent.name === 'worker')) await check.rpc('agents/save', { agent: workerDefinition, originalName: null });
  const catalog = await check.rpc('agents/list', {});
  const childAgent = catalog.agents.find(agent => agent.name === 'worker');
  assert.ok(childAgent, `scratch catalog did not contain expected worker; available: ${catalog.agents.map(agent => agent.name).join(',')}`);
  const parentState = (await check.rpc('session/new', { cwd: heavy.cwd, agentName: childAgent.name })).state;
  await check.rpc('pi/model/set', { path: parentState.path, model: { provider: 'stub', id: 'stub-1' } });
  const beforeRuns = (await check.rpc('agents/runs/list', { path: parentState.path })).runs;
  assert.equal(beforeRuns.length, 0, 'scratch parent starts with no unrelated runs');
  for (let i = 1; i <= config.children; i++) await prompt(check.rpc, parentState.path, `resource:start-child:${i} agent=${childAgent.name}`, until, config.phaseTimeoutMs);
  const children = await until(async () => {
    const runs = (await check.rpc('agents/runs/list', { path: parentState.path })).runs;
    const matching = runs.filter(run => /^resource-child-\d+$/.test(run.subagentName));
    return matching.length === config.children && matching.every(run => ['running','needs_input'].includes(run.status)) ? matching : false;
  }, `${config.children} synthetic child runs`, config.phaseTimeoutMs);
  assert.equal(children.length, config.children); assert.equal((await check.rpc('agents/runs/list', { path: parentState.path })).runs.length, config.children);
  await samplePhase(check, 'children-active', report);
  for (const child of children) await check.rpc('agents/runs/stop', { runId: child.runId, reason: 'synthetic resource checkpoint complete' });
  const terminalRunStatuses = new Set(['completed', 'blocked', 'failed', 'cancelled']);
  await until(async () => {
    const runs = (await check.rpc('agents/runs/list', { path: parentState.path })).runs;
    return runs.length === config.children && runs.every(run => terminalRunStatuses.has(run.status)) ? runs : false;
  }, 'children to reach terminal status after stop', config.phaseTimeoutMs);

  const bashSessions = sessions.slice(0, Math.min(10, sessions.length));
  const bashCalls = [];
  let allocationSet;
  let allocationStartedAt = 0;
  let allocationStartRequests = 0;
  for (let i = 1; i <= config.foregroundCalls + config.backgroundCalls; i++) {
    if (!allocationSet && i === Math.max(1, config.foregroundCalls + config.backgroundCalls - (mode === 'full' ? 49 : 1))) {
      allocationSet = await inspectorSet(check);
      allocationStartedAt = Date.now();
      allocationStartRequests = JSON.parse(await readFile(join(check.root, 'provider-counters.json'), 'utf8')).requests;
      await allocationSet.host.client.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (const worker of allocationSet.workers) await worker.client.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    const background = i > config.foregroundCalls; const ordinal = background ? i - config.foregroundCalls : i;
    const session = bashSessions[(i - 1) % bashSessions.length];
    await prompt(check.rpc, session.path, `resource:bash:${background ? 'bg' : 'fg'}:${ordinal} bytes=16384 RESOURCE-SOAK-COMMAND-CANARY`, until, config.phaseTimeoutMs);
    bashCalls.push({ background, generation: await workerGeneration(check, session.cwd) });
    const checkpointEvery = mode === 'full' ? 50 : 2;
    if (i % checkpointEvery === 0 || i === config.foregroundCalls + config.backgroundCalls) {
      const checkpoint = await samplePhase(check, `bash-${i}`, report);
      (report.taskCheckpoints ??= []).push({ calls: i, rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null });
    }
  }
  if (allocationSet) {
    const hostProfile = await allocationSet.host.client.send('HeapProfiler.stopSampling');
    const hostAllocations = allocationRows(hostProfile.profile);
    report.rankings['host-allocation'] = hostAllocations;
    const rows = [];
    for (const worker of allocationSet.workers) rows.push(...allocationRows((await worker.client.send('HeapProfiler.stopSampling')).profile));
    report.rankings['worker-allocation'] = rows.sort((a,b) => b.bytes-a.bytes).slice(0,20);
    const elapsedMs = Date.now() - allocationStartedAt;
    const providerRequests = JSON.parse(await readFile(join(check.root, 'provider-counters.json'), 'utf8')).requests - allocationStartRequests;
    const hostSampledBytes = hostAllocations.reduce((sum, row) => sum + row.bytes, 0);
    const workerSampledBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    report.allocationRate = { status: 'available', elapsedMs, providerRequests,
      hostSampledBytesPerSecond: elapsedMs > 0 ? hostSampledBytes * 1000 / elapsedMs : null,
      hostSampledBytesPerProviderRequest: providerRequests > 0 ? hostSampledBytes / providerRequests : null,
      workerSampledBytesPerSecond: elapsedMs > 0 ? workerSampledBytes * 1000 / elapsedMs : null,
      workerSampledBytesPerProviderRequest: providerRequests > 0 ? workerSampledBytes / providerRequests : null };
    await closeInspectorSet(allocationSet);
  }
  const taskResult = await check.rpc('tasks/list', {});
  assert.equal(taskResult.tasks.filter(task => task.status !== 'running').length, config.backgroundCalls, 'host retains every background call');
  // In-worker retention (TailBuffers, worker task rows) belongs to one worker
  // process. The sample and the generation it is compared against must be the
  // same one, so a replacement mid-sample re-takes the sample instead of
  // grading old numbers against a new process.
  let bashPhase;
  let retention;
  for (let attempt = 1; attempt <= 3 && !retention; attempt++) {
    const before = await workerGeneration(check, heavy.cwd);
    const phase = await samplePhase(check, 'bash-complete', report, { heap: true });
    const after = await workerGeneration(check, heavy.cwd);
    if (before === after) { bashPhase = phase; retention = expectedRetainedCounts({ calls: bashCalls, heavyToolGeneration, currentGeneration: after }); }
    else report.phases.pop();
  }
  if (!retention) throw new Error('The project worker was replaced during every bash-complete sample, so retained-count evidence could not be taken within one worker generation.');
  const workerTaskRows = bashPhase.workers.reduce((sum, worker) => sum + worker.tasks, 0);
  assert.equal(bashPhase.tailBuffers.count, retention.tailBuffers,
    'extension retains one bounded TailBuffer per Bash call served by the live worker generation, plus the earlier heavy tool when that generation survived '
    + `(same-generation calls ${retention.sameGenerationCalls}, calls whose worker was replaced ${retention.replacedGenerationCalls}, heavy tool survived ${retention.heavyToolGenerationSurvived})`);
  assert.equal(bashPhase.host.tasks, config.backgroundCalls, 'host retains background-task metadata only');
  assert.equal(workerTaskRows, retention.workerBackgroundTasks,
    `workers retain background-task metadata only for the generation that ran it (expected ${retention.workerBackgroundTasks} of ${config.backgroundCalls})`);
  report.workerGenerations = { bashCalls: bashCalls.length, sameGenerationCalls: retention.sameGenerationCalls,
    replacedGenerationCalls: retention.replacedGenerationCalls, heavyToolGenerationSurvived: retention.heavyToolGenerationSurvived };
  report.retainedTaskRecords = { extensionTailBuffers: bashPhase.tailBuffers.count, workerTaskRows, hostTaskRows: bashPhase.host.tasks,
    expectedExtensionTailBuffers: retention.tailBuffers, expectedWorkerTaskRows: retention.workerBackgroundTasks };
  report.slopes.rendererBashHeapBytesPerCall = slopeSummary((report.taskCheckpoints ?? []).map(row => ({ x: row.calls, y: row.rendererJsHeapBytes })), null);
  report.temporaryPeaks.bashRendererJsBytes = Number.isFinite(bashPhase.postGc?.renderer?.jsHeapUsedBytes)
    ? Math.max(...(report.taskCheckpoints ?? []).map(row => row.rendererJsHeapBytes).filter(Number.isFinite), bashPhase.renderer?.jsHeapUsedBytes ?? 0)
      - bashPhase.postGc.renderer.jsHeapUsedBytes : null;
  report.scenarios['5-children-and-bash'] = 'complete';

  const slow = new NodeWebSocket(`${check.fixture.hostRecord.url.replace('http:', 'ws:')}/ws`);
  await new Promise((resolveOpen,reject) => { slow.onopen=resolveOpen; slow.onerror=reject; });
  let rpcId = 1; const version = JSON.parse(await readFile(join(checkout, 'packages/cli/package.json'), 'utf8')).version;
  const loaded = new Promise((resolveLoad,reject) => {
    const timeout = setTimeout(() => reject(new Error('slow-client load timed out')), config.phaseTimeoutMs);
    slow.onmessage = event => { const message=JSON.parse(String(event.data)); if(message.id===rpcId){clearTimeout(timeout);resolveLoad(message.result);} };
  });
  slow.send(JSON.stringify({ jsonrpc:'2.0', id:rpcId, method:'session/load', params:{path:heavy.path,transcript:'loaded'}, clientVersion:version })); await loaded;
  slow._socket?.pause?.();
  // Replaying the already-loaded synthetic state makes kernel backpressure
  // deterministic even on hosts with TCP receive autotuning. The ordinary UI
  // client keeps draining while this one real socket is paused.
  for (let replay = 0; replay < (mode === 'full' ? 2 : 24); replay++) {
    slow.send(JSON.stringify({ jsonrpc:'2.0', id:++rpcId, method:'session/load', params:{path:heavy.path,fromSeq:0,transcript:'loaded'}, clientVersion:version }));
    // Pace replay requests and stop as soon as the first response reaches the
    // server queue. Sending the whole forcing batch concurrently can cross the
    // safety ceiling before the inspector gets a chance to observe it.
    await sleep(150);
    const set = await inspectorSet(check);
    try {
      const value = await scalarCounters(set.host.client, set.host.found.instanceId, 'host');
      if (value.bufferedBytes > SAFETY.socketBufferedBytes) throw new Error('slow socket crossed safety ceiling');
      if (value.bufferedBytes > 0) break;
    } finally { await closeInspectorSet(set); }
  }
  const streamAccepted = await check.rpc('session/prompt', { path: heavy.path, content: [{ type:'text',text:'resource:large-stream slow' }] }); assert.equal(streamAccepted.accepted,true);
  const queuedPeak = await until(async () => {
    const set=await inspectorSet(check); try { const value=await scalarCounters(set.host.client,set.host.found.instanceId,'host');
      if(value.bufferedBytes>SAFETY.socketBufferedBytes) throw new Error('slow socket crossed safety ceiling'); return value.bufferedBytes>0?value.bufferedBytes:false; } finally { await closeInspectorSet(set); }
  }, 'real WebSocket buffered bytes', Math.min(config.phaseTimeoutMs, mode === 'full' ? 60_000 : 15_000));
  assert.ok(queuedPeak > 0, 'the paused TCP reader must create real host backpressure');
  slow._socket?.resume?.();
  await settle(check.rpc, heavy.path, until, config.phaseTimeoutMs);
  await closeNodeWebSocket(slow, { force: true, resume: true });
  const finalState = await check.rpc('session/load', { path: heavy.path });
  const recovered = await check.rpc('session/load', { path: heavy.path, fromSeq: Math.max(0, finalState.seq - 5), transcript: 'loaded' });
  assert.equal(recovered.seq, finalState.seq, 'a fresh consumer recovers the authoritative watermark');
  assert.ok(recovered.replayFrom <= Math.max(0, finalState.seq - 5), 'recovery covers the requested tail');
  report.slowConsumer = { bufferedPeakBytes: queuedPeak, recovered: true, mechanism: 'paused TCP reader' };
  report.scenarios['8-slow-consumer'] = 'complete';
  await samplePhase(check, 'slow-consumer', report);

  await samplePhase(check, 'pre-detach', report, { heap: true });
  const proved = await proveNoLiveWork(() => sampleRetirementGuards(check), { deadlineMs: Math.min(config.phaseTimeoutMs, 15_000) });
  const preDetachGuards = proved.guards;
  const traversal = await traverseRetainedViews(check, sessions, workspaceSessions, exp.projectSessions + exp.workspaceSessions);
  assert.equal(traversal.visited, mode === 'full' ? 54 : 5, 'retirement traversal visits every retained UI view');
  report.retirement = { traversal, preDetachGuards, guardAttempts: proved.attempts, readableWorkers: proved.readable };

  const boundarySet = await inspectorSet(check, { includeWorkers: false });
  let boundaryGuards = retirementGuardSnapshot();
  try {
    // Closing the page, not navigating it, is what releases the app's own
    // product WebSocket and the attachment it owns. Everything after this point
    // samples the host only; the case's page metrics say the page is gone.
    await check.page.close();
    check.metrics = async () => closedPageMetrics();
    try {
      boundaryGuards = await until(async () => {
        const host = await scalarCounters(boundarySet.host.client, boundarySet.host.found.instanceId, 'host');
        boundaryGuards = retirementGuardSnapshot(host);
        return boundaryGuards.productConnections === 0 && boundaryGuards.attachmentRefs === 0 && boundaryGuards.attachedPaths === 0 ? boundaryGuards : false;
      }, 'product WebSocket and attachment teardown', Math.min(config.phaseTimeoutMs, 10_000));
    } catch {
      throw new Error(`Timed out waiting for product WebSocket and attachment teardown; guards=${JSON.stringify(boundaryGuards)}`);
    }
    assertNoLiveWork(boundaryGuards);
    assert.deepEqual({ connections: boundaryGuards.productConnections, refs: boundaryGuards.attachmentRefs, paths: boundaryGuards.attachedPaths },
      { connections: 0, refs: 0, paths: 0 }, 'page teardown releases every product connection and attachment');
  } finally {
    await closeInspectorSet(boundarySet);
  }
  report.retirement.boundaryGuards = boundaryGuards;
  await waitForNaturalRetirement(check, config.idleMs + config.sweepMs * 2 + 10_000, boundaryGuards);
  const retired = await samplePhase(check, 'retired', report, { heap: true, includeWorkers: false, pageClosed: true });
  assert.equal(retired.workers.length, 0);
  const quiet = [];
  for (let i=0;i<(mode==='full'?6:3);i++) { await sleep(mode==='full'?5000:1000); quiet.push({x:i*(mode==='full'?5:1)/60,y:(await samplePhase(check, `retired-quiet-${i+1}`, report, {includeWorkers:false,pageClosed:true})).totalPssBytes}); }
  report.slopes.hostPostRetirementPssBytesPerMinute = slopeSummary(quiet, mode === 'full' ? 5 : 1);
  report.scenarios['9-detach-and-retirement'] = 'complete';
  await removeRegistrations((await waitForRegistrations(check.fixture.inspectDir,{rootPid:check.fixture.hostRecord.pid,minimum:1})).filter(record=>record.pid!==check.fixture.hostRecord.pid));
}

function providerSummary(value) {
  const routeCounts = { seed: 0, largeStream: 0, largeTool: 0, images: 0, childStart: 0, child: 0, bash: 0, continuation: 0, other: 0 };
  for (const [name, count] of Object.entries(value.routes ?? {})) {
    const bucket = name.startsWith('seed:') ? 'seed' : name.startsWith('resource:large-stream') ? 'largeStream'
      : name.startsWith('resource:tool-large') ? 'largeTool' : name.startsWith('resource:images') ? 'images'
      : name.startsWith('resource:start-child') ? 'childStart' : name.startsWith('resource:child') ? 'child'
      : name.startsWith('resource:bash') ? 'bash' : name === 'continuation' ? 'continuation' : 'other';
    routeCounts[bucket] += Number(count) || 0;
  }
  return { requests: value.requests, routeCounts, lastToolCount: Array.isArray(value.lastToolNames) ? value.lastToolNames.length : 0 };
}

/** What a failed run is allowed to keep: completed work, counts and the refusal, never an identity. */
export function partialFailureReport(report, error, evidence = null) {
  const { startedAtMs: _startedAtMs, ...rest } = report;
  return { ...rest, pass: false,
    failure: {
      message: sanitizeOwner((error instanceof Error ? error.message : String(error)).replace(/process \d+/g, 'a sampled process')),
      phasesCompleted: report.phases.length,
      phaseNames: report.phases.map(phase => phase.name),
      scenarios: { ...report.scenarios },
      safetyRefusal: report.safetyRefusal ?? null,
      survivors: evidence?.survivors?.length ?? null,
    } };
}

/** Atomic, redaction-gated write. A partial report never half-exists. */
export async function writeAtomicJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertRedacted(text);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function oneRun(mode, artifacts, implementationSha, electron) {
  const report = { mode, implementationSha, startedAtMs: Date.now(), phases: [], rankings: {}, slopes: {}, scenarios: {},
    unsupported: ['physical decoded-image bytes per DOM owner', 'relay-client memory in the local stalled-reader lane'], pass: false };
  let evidence;
  try {
    evidence = await browserCheck({ checkout, target: resourceTarget(mode), fixture, fixtureName: mode, artifacts, timeout: modeConfig(mode).phaseTimeoutMs }, check => runBrowserSoak(check, mode, report));
  } catch (error) {
    // Teardown has already run and written its evidence; read the survivor
    // outcome when it is there, then keep what the run did prove.
    let teardown = null;
    try {
      const roots = (await readdir(artifacts, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('run-'));
      const candidates = await Promise.all(roots.map(async entry => {
        try { return JSON.parse(await readFile(join(artifacts, entry.name, 'evidence.json'), 'utf8')); } catch { return null; }
      }));
      teardown = candidates.filter(Boolean).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).at(-1);
    } catch {}
    try { await writeAtomicJson(join(artifacts, 'report-partial.json'), partialFailureReport(report, error, teardown)); } catch {}
    throw error;
  }
  report.build = evidence.build;
  report.provider = providerSummary(JSON.parse(await readFile(join(evidence.root, 'provider-counters.json'), 'utf8')));
  report.survivors = evidence.survivors.length;
  const evidenceSummary = { survivors: evidence.survivors.length };
  if (evidence.survivors.length === 0) await rm(evidence.root, { recursive: true, force: true });
  if (electron) {
    report.desktop = await runElectronLane({ checkout, root: artifacts, mode: 'quick', timeoutMs: modeConfig(mode).phaseTimeoutMs });
    report.scenarios['7-desktop-hide-and-restore'] = 'complete';
    report.rankings['desktop-processes'] = ['visible', 'hidden', 'restored'].flatMap(name =>
      report.desktop[name].processes.map(row => ({ owner: `${name}/${row.role}`, bytes: row.pssBytes ?? 0 })));
    report.capabilities.electron = 'available';
  } else {
    report.scenarios['7-desktop-hide-and-restore'] = 'quick-mode-not-requested';
    report.capabilities.electron = 'not requested in quick mode';
  }
  report.pass = report.survivors === 0 && Object.entries(report.scenarios).every(([name, value]) => name.startsWith('7-') ? (electron ? value === 'complete' : mode === 'quick') : value === 'complete');
  report.startedAtMs = undefined;
  return { report, evidence: evidenceSummary };
}

export async function runResourceSoak({ mode='quick', runs=1, artifacts='/tmp/resource-soak', electron=false }={}) {
  if (process.platform !== 'linux') throw new Error('The full resource soak requires Linux /proc PSS accounting.');
  if (mode==='full' && runs!==2) throw new Error('Full baseline evidence requires exactly two clean runs.');
  if (mode==='full' && !electron) throw new Error('Full baseline evidence requires the real Electron hide/restore lane.');
  await mkdir(artifacts,{recursive:true,mode:0o700});
  const implementationSha = execFileSync('git',['rev-parse','HEAD'],{cwd:checkout,encoding:'utf8'}).trim();
  const results=[];
  for(let i=0;i<runs;i++){
    if(i===1){
      const first=results[0];
      if(!first.report.pass||first.report.survivors) throw new Error('Safety refusal: run A was not clean; run B will not start.');
      const last=first.report.phases.at(-1); await enforceSafety([]);
      if(last?.safety?.availableBytes!==null&&last.safety.availableBytes<SAFETY.minimumAvailableBytes) throw new Error('Safety refusal: run A ended below the memory-availability floor.');
    }
    const root=join(artifacts,`run-${String.fromCharCode(97+i)}`); await mkdir(root,{recursive:true,mode:0o700});
    const result=await oneRun(mode,root,implementationSha,electron); await writeReport(root,result.report); results.push(result);
  }
  let comparison=null;
  if(results.length===2){
    comparison=compareRuns(results[0].report,results[1].report);
    const text=`${JSON.stringify({implementationSha,...comparison},null,2)}\n`; assertRedacted(text);
    const markdown = `# Resource soak comparison\n\nImplementation: \`${implementationSha}\`\n\nResult: **${comparison.pass ? 'pass' : 'failed'}**\n\n`
      + Object.entries(comparison.categories).map(([name,value]) => `- ${name}: top=${value.topOwnerSame}; overlap=${value.topFiveOverlap}/5; Spearman=${value.spearman ?? 'unavailable'}; pass=${value.pass}`).join('\n')
      + `\n\n## Slopes\n\n` + Object.entries(comparison.slopes).map(([name,value]) => `- ${name}: sign agrees=${value.signAgrees}; CV=${value.coefficientOfVariation ?? 'unavailable'}${value.flaggedOver25Percent ? ' (flagged over 25%)' : ''}`).join('\n') + '\n';
    assertRedacted(markdown);
    await Promise.all([writeFile(join(artifacts,'comparison.json'),text,{mode:0o600}),writeFile(join(artifacts,'comparison.md'),markdown,{mode:0o600})]);
  }
  const manifest = { schemaVersion: 1, implementationSha, mode, runs, electron, build: results[0]?.report.build,
    runtime: results[0]?.report.runtime, fixture: results[0]?.report.fixture, capabilities: results[0]?.report.capabilities,
    allRunsPassed: results.every(result => result.report.pass), comparisonPassed: comparison?.pass ?? null };
  const manifestText = `${JSON.stringify(manifest,null,2)}\n`; assertRedacted(manifestText);
  await writeFile(join(artifacts,'manifest.json'),manifestText,{mode:0o600});
  const scan = async directory => (await readdir(directory,{withFileTypes:true})).flatMap(entry => entry.isDirectory() ? [] : /\.(?:json|md|log)$/.test(entry.name) ? [join(directory,entry.name)] : []);
  const finalFiles = [...await scan(artifacts)];
  for (const name of ['run-a','run-b']) if ((await readdir(join(artifacts,name)).catch(()=>[])).length) finalFiles.push(...await scan(join(artifacts,name)));
  for (const file of finalFiles) assertRedacted(await readFile(file,'utf8'));
  return {implementationSha,results:results.map(({report})=>report),comparison};
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const {values}=parseArgs({options:{quick:{type:'boolean'},full:{type:'boolean'},runs:{type:'string'},artifacts:{type:'string'},electron:{type:'boolean'}}});
  const mode=values.full?'full':'quick';
  const result=await runResourceSoak({mode,runs:Number(values.runs??(mode==='full'?2:1)),electron:values.electron??false,artifacts:resolve(values.artifacts??`/tmp/resource-soak-${mode}`)});
  console.log(JSON.stringify({implementationSha:result.implementationSha,pass:result.results.every(run=>run.pass)&&(result.comparison?.pass??true)},null,2));
}
